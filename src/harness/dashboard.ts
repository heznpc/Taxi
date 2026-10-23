import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PATHS } from "../shared/constants.js";
import { catalogFreshness } from "./catalog.js";
import type { State } from "./store.js";

export function taskDashboard(state: State, ownerLive: boolean) {
  return {
    tasks: state.tasks.map((task) => {
      const run = state.runs.find((run) => run.taskId === task.id);
      const phase = run?.event.phase;
      const status = !run
        ? "not-started"
        : phase === "completed"
          ? "provider-completed"
          : phase === "failed"
            ? "failed"
            : phase === "unverified" || !ownerLive
              ? "unknown"
              : phase === "response_headers"
                ? "running"
                : "preparing";
      return {
        ...task,
        phase: task.phase ?? "unspecified",
        modelPreference: task.modelPreference ?? null,
        status,
        statusSource: run ? "taxi-provider-events" : "taxi-task-record",
        executionOwner: "taxi",
        completionVerified: false,
      };
    }),
    runs: state.runs,
    externalSessions: (state.externalSessions ?? []).map((session) => ({
      ...session,
      freshness: catalogFreshness(session.catalogGeneratedAt),
      status: "unknown",
      authority: "observe-only",
    })),
    catalogImports: (state.catalogImports ?? []).map((receipt) => ({
      ...receipt,
      freshness: catalogFreshness(receipt.generatedAt),
    })),
    sessionLinks: state.sessionLinks ?? [],
  };
}

/** Read-only observer. It must not acquire an executor lock, repair state, or start a provider. */
export function readTaskDashboard(taskId?: string, offset = 0, limit = 50, root = join(PATHS.VECTOR_STORE, "harness")) {
  const file = join(root, "state.json");
  if (!existsSync(file))
    return {
      tasks: [],
      runs: [],
      externalSessions: [],
      sessionLinks: [],
      catalogImports: [],
      totalExternal: 0,
      nextOffset: null,
    };
  if (lstatSync(file).isSymbolicLink() || lstatSync(file).size > 64 * 1024 * 1024) throw new Error("unsafe_state_file");
  const state = JSON.parse(readFileSync(file, "utf8")) as State;
  if (state.version !== 1 || !Array.isArray(state.tasks) || !Array.isArray(state.runs))
    throw new Error("invalid_harness_state");
  let live = false;
  try {
    const owner = JSON.parse(readFileSync(join(root, "owner.json"), "utf8")) as { pid: number };
    if (Number.isSafeInteger(owner.pid) && owner.pid > 1) {
      process.kill(owner.pid, 0);
      live = true;
    }
  } catch {
    /* A missing executor never proves completion. */
  }
  const snapshot = taskDashboard(state, live);
  const links = snapshot.sessionLinks.filter((link) => !taskId || link.taskId === taskId);
  const keys = new Set(links.flatMap((link) => [link.sessionKey, link.parentSessionKey]));
  const external = snapshot.externalSessions.filter((session) => !taskId || keys.has(session.key));
  return {
    ...snapshot,
    tasks: snapshot.tasks.filter((task) => !taskId || task.id === taskId || task.parentId === taskId),
    runs: snapshot.runs
      .filter((run) => !taskId || run.taskId === taskId)
      .map(({ prompt: _prompt, ...run }) => run)
      .slice(0, 100),
    sessionLinks: links,
    externalSessions: external.slice(offset, offset + limit),
    totalExternal: external.length,
    nextOffset: offset + limit < external.length ? offset + limit : null,
    authority: "read-only; catalog and task links do not delegate execution",
    observedAt: new Date().toISOString(),
  };
}
