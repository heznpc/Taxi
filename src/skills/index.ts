import type { FSWatcher } from "node:fs";
import type { McpServer } from "../shared/mcp.js";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllSkills, mergeSkills, watchUserSkills } from "./loader.js";
import { registerSkills } from "./register.js";
import { registerTrigger, resetTriggers, startTriggerListener } from "./triggers.js";
import { log } from "../shared/logger.js";
import { toolRegistry, type ToolRegistry } from "../shared/tool-registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Resolves to dist/skills/builtins/ — works in repo checkout, npm cache, and git worktrees
// because builtins are copied into dist/ during build (scripts/build.mjs).
const BUILTINS_DIR = join(__dirname, "builtins");

let skillsWatcher: FSWatcher | null = null;
let processOwnerServer: McpServer | null = null;

export type SkillEngineLifecycle = "process-owner" | "session";

export interface SkillEngineCounts {
  /** Built-in skills loaded from `dist/skills/builtins/*.yaml`. */
  builtinCount: number;
  /** User skills loaded from `~/.taxi/skills/*.yaml`. */
  userCount: number;
  /** Releases trigger/watcher ownership only if this registration still owns
   * the process singleton. Session registrations always return a no-op. */
  releaseProcessOwnership: () => void;
}

function releaseProcessOwnership(server: McpServer): void {
  // A stale cleanup callback from a replaced owner must not tear down the
  // current process owner. This matters in embedded start/close test cycles.
  if (processOwnerServer !== server) return;
  resetTriggers();
  processOwnerServer = null;
  skillsWatcher?.close();
  skillsWatcher = null;
}

export async function registerSkillEngine(
  server: McpServer,
  registry: ToolRegistry = toolRegistry,
  lifecycle: SkillEngineLifecycle = "process-owner",
): Promise<SkillEngineCounts> {
  const { builtins, user } = loadAllSkills(BUILTINS_DIR);
  const merged = mergeSkills(builtins, user);

  const release = lifecycle === "process-owner" ? () => releaseProcessOwnership(server) : () => undefined;

  if (lifecycle === "process-owner") {
    // Ownership transfer is explicit and atomic. Per-session construction
    // selects `session`, so it cannot replace this target with a server that
    // will disappear when a client/doctor closes its MCP session.
    resetTriggers();
    processOwnerServer = server;
  }

  if (merged.length === 0) {
    log.info("skills engine: no skills found");
    return { builtinCount: 0, userCount: 0, releaseProcessOwnership: release };
  }

  registerSkills(server, merged, registry);

  if (lifecycle === "process-owner") {
    for (const skill of merged) {
      registerTrigger(skill);
    }
    startTriggerListener(server, registry);

    // The watcher belongs to the same process lifetime as trigger dispatch.
    if (!skillsWatcher) {
      skillsWatcher = watchUserSkills(() => {
        log.info("user skills changed — restart server to apply changes");
      });
    }
  }

  return {
    builtinCount: builtins.length,
    userCount: user.length,
    releaseProcessOwnership: release,
  };
}

/** Close all process-owned skill resources. Called on process exit. */
export function closeSkillsWatcher(): void {
  skillsWatcher?.close();
  skillsWatcher = null;
  if (processOwnerServer) {
    resetTriggers();
    processOwnerServer = null;
  }
}
