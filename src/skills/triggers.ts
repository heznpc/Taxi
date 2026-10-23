import type { McpServer } from "../shared/mcp.js";
import type { SkillDefinition } from "./types.js";
import { executeSkill } from "./executor.js";
import { eventBus, type TaxiEvent } from "../shared/event-bus.js";
import { runWithRequestContext, getRequestContext } from "../shared/request-context.js";
import { randomUUID } from "node:crypto";
import { parseIntEnv } from "../shared/env.js";
import { log, errToCtx } from "../shared/logger.js";
import { toolRegistry, type ToolRegistry } from "../shared/tool-registry.js";

interface TriggerBinding {
  skill: SkillDefinition;
  debounceMs: number;
  lastFired: number;
}

const bindings = new Map<string, TriggerBinding[]>();

// Retry policy for failed trigger dispatches. Exponential backoff (2s → 4s
// → 8s …) with jitter avoids thundering-herd retries when many triggers fire
// on the same event (e.g. a burst of `calendar_changed`). Override via env
// for tests / aggressive polling setups. parseIntEnv guards against a
// non-numeric override producing NaN — a NaN retry cap makes `attempt >= NaN`
// always false (infinite retries) and a NaN backoff coerces to a 0ms hot loop.
const TRIGGER_MAX_RETRIES = parseIntEnv(process.env.TAXI_TRIGGER_MAX_RETRIES, { floor: 0, fallback: 2 });
const TRIGGER_BASE_BACKOFF_MS = parseIntEnv(process.env.TAXI_TRIGGER_BASE_BACKOFF_MS, { floor: 100, fallback: 2000 });
const TRIGGER_MAX_BACKOFF_MS = parseIntEnv(process.env.TAXI_TRIGGER_MAX_BACKOFF_MS, {
  floor: TRIGGER_BASE_BACKOFF_MS,
  fallback: 60_000,
});

function computeBackoff(attempt: number): number {
  // attempt is 1-indexed: the 1st retry waits BASE, the 2nd waits 2×BASE, …
  const exp = Math.min(TRIGGER_MAX_BACKOFF_MS, TRIGGER_BASE_BACKOFF_MS * 2 ** (attempt - 1));
  const jitter = Math.floor(Math.random() * (exp * 0.25));
  return exp + jitter;
}

function runWithRetry(server: McpServer, registry: ToolRegistry, skill: SkillDefinition, attempt: number): void {
  // Stamp an autonomous-origin actor + fresh correlation ID on the
  // AsyncLocalStorage context so every tool call inside this skill
  // execution lands in the audit log as `actor: "daemon-skill:<name>"`.
  // Without this stamp, autonomous tool calls were indistinguishable
  // from user-initiated ones during audit review.
  const existing = getRequestContext();
  const ctx = {
    ...(existing ?? {}),
    actor: `daemon-skill:${skill.name}`,
    correlationId: existing?.correlationId ?? randomUUID(),
  };
  runWithRequestContext(ctx, () => {
    executeSkill(server, skill, {}, registry).catch((e) => {
      log.warn("trigger failed", { skill: skill.name, attempt, err: errToCtx(e) });
      if (attempt >= 1 + TRIGGER_MAX_RETRIES) return;
      const delay = computeBackoff(attempt);
      const t = setTimeout(() => runWithRetry(server, registry, skill, attempt + 1), delay);
      t.unref?.();
    });
  });
}

/** Reset the one process-owned trigger runtime.
 *
 * HTTP MCP sessions must never call this: their servers are disposable and
 * closing one must not replace or tear down the daemon trigger target. Only a
 * process-lifetime owner (stdio, or the HTTP catalog owner) may reset/rebind
 * this singleton state. */
export function resetTriggers(): void {
  bindings.clear();
  // Remove our exact listener; do not disturb other event consumers.
  if (listenerInstalled) eventBus.off("event", dispatch);
  listenerInstalled = false;
  activeServer = null;
  activeRegistry = null;
}

/** Register a skill's trigger with the event bus. */
export function registerTrigger(skill: SkillDefinition): void {
  if (!skill.trigger) return;
  const { event, debounce_ms } = skill.trigger;
  const list = bindings.get(event) ?? [];
  list.push({ skill, debounceMs: debounce_ms ?? 5000, lastFired: 0 });
  bindings.set(event, list);
}

// Singleton listener — created once per process. The caller is required to be
// the explicit process-lifetime owner. Disposable HTTP sessions register skill
// tools in their own registry but never call this function.
let activeServer: McpServer | null = null;
let activeRegistry: ToolRegistry | null = null;
let listenerInstalled = false;

function dispatch(evt: TaxiEvent): void {
  const server = activeServer;
  const registry = activeRegistry;
  if (!server || !registry) return;
  const list = bindings.get(evt.type);
  if (!list) return;

  const now = Date.now();
  for (const binding of list) {
    if (now - binding.lastFired < binding.debounceMs) continue;
    binding.lastFired = now;

    // Fire and forget — don't block the event loop. `runWithRetry` handles
    // exponential backoff with jitter so bursty events (e.g. many calendar
    // updates in quick succession) don't line their retries up.
    runWithRetry(server, registry, binding.skill, 1);
  }
}

/** Start listening for events and dispatching skills. Idempotent. */
export function startTriggerListener(server: McpServer, registry: ToolRegistry = toolRegistry): void {
  activeServer = server;
  activeRegistry = registry;
  if (listenerInstalled) return;
  eventBus.on("event", dispatch);
  listenerInstalled = true;
}

/** Get all registered triggers for diagnostics. */
export function getRegisteredTriggers(): Array<{ skill: string; event: string; debounceMs: number }> {
  const result: Array<{ skill: string; event: string; debounceMs: number }> = [];
  for (const [event, list] of bindings) {
    for (const b of list) {
      result.push({ skill: b.skill.name, event, debounceMs: b.debounceMs });
    }
  }
  return result;
}
