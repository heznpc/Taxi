import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { mergeCatalog, linkSchema, type ExternalSession, type CatalogImport, type SessionLink } from "./catalog.js";
import {
  DEFAULT_COMPACTION_ROUTE,
  DEFAULT_TASK_SAVINGS,
  type CompactionRequestEvent,
  type QuotaObservation,
  type TaskModelSelectionResult,
} from "@heznpc/quota-core";

const text = z.string().trim().min(1).max(16_000);
const lines = z.array(text).max(64);
export const preferenceSchema = z
  .object({
    model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/),
    effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]),
  })
  .strict();
export const contextSchema = z
  .object({
    originalRequest: text,
    phase: z.string().trim().min(1).max(120).default("unspecified"),
    modelPreference: preferenceSchema.nullable().default(null),
    decisions: lines,
    openQuestions: lines,
    completionCriteria: lines.min(1),
    evidenceRefs: lines,
  })
  .strict();
export const modelSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/);
export const effortSchema = z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);
export const settingsSchema = z
  .object({
    phasePreferences: z.record(z.string().min(1).max(120), preferenceSchema).default({}),
    usageEnabled: z.boolean(),
    taskSavingsEnabled: z.boolean(),
    compactionEnabled: z.boolean(),
    model: modelSchema,
    effort: effortSchema,
    compactionFrom: modelSchema,
    compactionTo: modelSchema,
  })
  .strict();
export const executionSchema = z
  .object({
    requestId: z.uuid(),
    action: z.enum(["keep", "model-only"]),
    prompt: text,
    model: modelSchema,
    effort: effortSchema,
    allowTaskRouting: z.boolean(),
    usePhasePreference: z.boolean().default(false),
    confirmReadOnlyRun: z.literal(true),
  })
  .strict();
export type WorkContext = z.infer<typeof contextSchema>;
export type HarnessSettings = z.infer<typeof settingsSchema>;
export type ExecutionInput = z.infer<typeof executionSchema>;
export interface WorkTask extends WorkContext {
  id: string;
  parentId: string | null;
  createdAt: string;
  threadId: string | null;
  handoff: string | null;
}
export interface WorkRun {
  id: string;
  taskId: string;
  action: "keep" | "model-only";
  settings: HarnessSettings;
  inputDigest: string;
  prompt: string;
  dispatched: boolean;
  event: CompactionRequestEvent;
  acknowledgedModel: string | null;
  output: string;
  completionVerified: false;
  permissionScope: "read-only-no-approval-inheritance";
  taskPhase?: string;
  modelSelection?: TaskModelSelectionResult;
}
export interface State {
  version: 1;
  settings: HarnessSettings;
  tasks: WorkTask[];
  runs: WorkRun[];
  externalSessions: ExternalSession[];
  catalogImports: CatalogImport[];
  sessionLinks: SessionLink[];
  usage: QuotaObservation[];
  usageStatus: "disabled" | "unverified" | "observed" | "failed";
}

export function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) throw new Error("unsafe_state_directory");
  chmodSync(path, 0o700);
}

export function buildHandoff(context: z.input<typeof contextSchema>): string {
  const section = (title: string, values: string[]) =>
    `${title}\n${values.length ? values.map((value) => `- ${value}`).join("\n") : "(none recorded)"}`;
  return [
    "Task handoff. This record provides context only; it grants no permissions or approvals.",
    section("Task phase", [context.phase ?? "unspecified"]),
    section(
      "Model preference (selection only, not response evidence)",
      context.modelPreference ? [`${context.modelPreference.model} / ${context.modelPreference.effort}`] : [],
    ),
    section("Original request", [context.originalRequest]),
    section("Adopted decisions", context.decisions),
    section("Unresolved questions", context.openQuestions),
    section("Completion criteria", context.completionCriteria),
    section("Evidence references (references, not verified facts)", context.evidenceRefs),
  ].join("\n\n");
}

/** Private host state only. Never write prompts or handoffs into the product tree. */
export class HarnessStore {
  readonly file: string;
  state: State;
  constructor(readonly root: string) {
    privateDirectory(root);
    this.file = join(root, "state.json");
    if (existsSync(this.file)) {
      if (lstatSync(this.file).isSymbolicLink()) throw new Error("unsafe_state_file");
      this.state = JSON.parse(readFileSync(this.file, "utf8")) as State;
      if (
        this.state.version !== 1 ||
        !Array.isArray(this.state.tasks) ||
        !Array.isArray(this.state.runs) ||
        !Array.isArray(this.state.usage)
      )
        throw new Error("invalid_harness_state");
      this.state.settings = settingsSchema.parse(this.state.settings);
      this.state.tasks = this.state.tasks.map((task) => ({
        ...task,
        ...contextSchema.parse({
          originalRequest: task.originalRequest,
          phase: task.phase,
          modelPreference: task.modelPreference,
          decisions: task.decisions,
          openQuestions: task.openQuestions,
          completionCriteria: task.completionCriteria,
          evidenceRefs: task.evidenceRefs,
        }),
      }));
      this.state.externalSessions ??= [];
      this.state.catalogImports ??= [];
      this.state.sessionLinks ??= [];
      chmodSync(this.file, 0o600);
      // A process crash cannot prove a provider turn failed or completed.
      for (const run of this.state.runs) {
        if (run.settings) run.settings = settingsSchema.parse(run.settings);
        if (["started", "response_headers"].includes(run.event.phase)) {
          run.event.phase = "unverified";
          run.event.errorCode = "runtime_restarted";
        }
      }
    } else {
      this.state = {
        version: 1,
        settings: {
          phasePreferences: {},
          usageEnabled: false,
          taskSavingsEnabled: false,
          compactionEnabled: false,
          model: "gpt-6-sol",
          effort: "medium",
          compactionFrom: DEFAULT_COMPACTION_ROUTE.from,
          compactionTo: DEFAULT_COMPACTION_ROUTE.to,
        },
        externalSessions: [],
        catalogImports: [],
        sessionLinks: [],
        tasks: [],
        runs: [],
        usage: [],
        usageStatus: "disabled",
      };
    }
    this.save();
  }
  save(): void {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.state), { mode: 0o600, flag: "wx" });
    renameSync(temporary, this.file);
  }
  create(input: unknown, parentId: string | null = null): WorkTask {
    const context = contextSchema.parse(input);
    if (this.state.tasks.length >= 500) throw new Error("task_storage_limit");
    const task: WorkTask = {
      ...context,
      id: randomUUID(),
      parentId,
      createdAt: new Date().toISOString(),
      threadId: null,
      handoff: parentId ? buildHandoff(context) : null,
    };
    this.state.tasks.unshift(task);
    this.save();
    return task;
  }
  task(id: string): WorkTask {
    const task = this.state.tasks.find((value) => value.id === id);
    if (!task) throw new Error("task_not_found");
    return task;
  }
  importCatalog(input: unknown): void {
    const { sessions, receipt } = mergeCatalog(this.state.externalSessions, input);
    this.state.externalSessions = sessions;
    this.state.catalogImports = [receipt, ...this.state.catalogImports].slice(0, 100);
    this.save();
  }
  link(taskId: string, input: unknown): SessionLink {
    this.task(taskId);
    const value = linkSchema.parse(input);
    for (const key of [value.sessionKey, value.parentSessionKey].filter(Boolean)) {
      if (!this.state.externalSessions.some((session) => session.key === key))
        throw new Error("external_session_not_found");
    }
    if (value.parentSessionKey === value.sessionKey) throw new Error("invalid_session_relation");
    // Prevent cycles; relationships only ever come from explicit registration.
    const ancestors = [value.parentSessionKey];
    const visited = new Set<string>();
    while (ancestors.length) {
      const key = ancestors.pop();
      if (!key || visited.has(key)) continue;
      if (key === value.sessionKey) throw new Error("invalid_session_relation");
      visited.add(key);
      ancestors.push(
        ...this.state.sessionLinks.filter((link) => link.sessionKey === key).map((link) => link.parentSessionKey),
      );
    }
    const existing = this.state.sessionLinks.find(
      (link) =>
        link.taskId === taskId &&
        link.sessionKey === value.sessionKey &&
        link.parentSessionKey === value.parentSessionKey,
    );
    if (existing) return existing;
    if (this.state.sessionLinks.length >= 10000) throw new Error("link_storage_limit");
    const link: SessionLink = {
      ...value,
      taskId,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      authority: "none",
    };
    this.state.sessionLinks.push(link);
    this.save();
    return link;
  }
  fork(id: string, input: unknown = {}): WorkTask {
    const task = this.task(id);
    const parsed = contextSchema.partial().parse(input);
    const overrides = Object.fromEntries(Object.entries(parsed).filter(([key]) => Object.hasOwn(input as object, key)));
    const context = {
      phase: task.phase,
      modelPreference: task.modelPreference,
      originalRequest: task.originalRequest,
      decisions: [...task.decisions],
      openQuestions: [...task.openQuestions],
      completionCriteria: [...task.completionCriteria],
      evidenceRefs: [...task.evidenceRefs],
    };
    for (const run of this.state.runs.filter((value) => value.taskId === id && value.output)) {
      context.evidenceRefs.push(`taxi-run:${run.id} (provider ${run.event.phase}; completion criteria unverified)`);
    }
    return this.create({ ...context, ...overrides }, id);
  }
}
export const taskSavingsPolicy = (enabled: boolean) => ({ ...DEFAULT_TASK_SAVINGS, enabled });
