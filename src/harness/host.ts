import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, unlinkSync, writeFileSync, mkdirSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import {
  parseCodexRateLimits,
  selectTaskModel,
  parseCompactionRequestEvent,
  routeCompaction,
  validateCompactionRoute,
  TaskSavingsRouter,
  summarizeRequestEvents,
  type CompactionRequestEvent,
} from "@heznpc/quota-core";
import { taskDashboard } from "./dashboard.js";
import { auditLog } from "../shared/audit.js";
import { PATHS } from "../shared/constants.js";
import { isEmergencyStopActive, checkRateLimit } from "../shared/rate-limit.js";
import { runGovernedActivity } from "../shared/governed-activity.js";
import { CodexClient, codexBinary } from "./codex-client.js";
import {
  HarnessStore,
  buildHandoff,
  executionSchema,
  modelSchema,
  settingsSchema,
  taskSavingsPolicy,
  privateDirectory,
  type ExecutionInput,
  type WorkRun,
} from "./store.js";

export class HarnessHost {
  readonly store: HarnessStore;
  readonly providerHome: string;
  readonly workspace: string;
  private active: { run: WorkRun; client: CodexClient } | null = null;
  private collection: CodexClient | null = null;
  private collecting: Promise<void> | null = null;
  private closed = false;
  private execution: Promise<void> | null = null;
  private lockNonce = randomUUID();
  private routerSupported = false;
  private router = new TaskSavingsRouter(() => this.routerSupported);
  private readonly lockPath: string;
  constructor(readonly root = join(PATHS.VECTOR_STORE, "harness")) {
    privateDirectory(root);
    this.lockPath = join(root, "owner.json");
    const acquire = () =>
      writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, nonce: this.lockNonce }), {
        flag: "wx",
        mode: 0o600,
      });
    try {
      acquire();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || lstatSync(this.lockPath).isSymbolicLink())
        throw new Error("harness_owned_elsewhere", { cause: error });
      const reapPath = this.lockPath + ".reclaim";
      mkdirSync(reapPath, { mode: 0o700 });
      try {
        const owner = JSON.parse(readFileSync(this.lockPath, "utf8")) as { pid: number };
        if (!Number.isSafeInteger(owner.pid) || owner.pid <= 1)
          throw new Error("harness_owner_unverified", { cause: error });
        try {
          process.kill(owner.pid, 0);
          throw new Error("harness_owned_elsewhere", { cause: error });
        } catch (probe) {
          if ((probe as NodeJS.ErrnoException).code !== "ESRCH")
            throw new Error("harness_owned_elsewhere", { cause: probe });
        }
        unlinkSync(this.lockPath);
        acquire();
      } finally {
        rmdirSync(reapPath);
      }
    }
    try {
      this.store = new HarnessStore(root);
    } catch (error) {
      unlinkSync(this.lockPath);
      throw error;
    }
    this.providerHome = join(root, "codex");
    this.workspace = join(root, "workspace");
    privateDirectory(this.providerHome);
    privateDirectory(this.workspace);
  }
  snapshot() {
    const settings = this.store.state.settings;
    const policy = { from: settings.compactionFrom, to: settings.compactionTo, effort: "low" as const };
    const preview = routeCompaction("/responses/compact", { model: settings.compactionFrom }, policy);
    return {
      core: { name: "@heznpc/quota-core", version: "0.2.0", installed: true },
      ownership: {
        collector: "taxi-on-demand",
        relay: "none",
        scope: "taxi-created-sessions",
        interceptsExternalRequests: false,
      },
      provider: {
        id: "codex",
        installed: codexBinary() !== null,
        home: this.providerHome,
        authentication: existsSync(join(this.providerHome, "auth.json")) ? "present-unverified" : "login-required",
        permissions: "read-only; macOS background-only process tree; no host services or inherited approvals",
        unsupportedProviders: ["claude"],
      },
      settings,
      compaction: {
        configured: settings.compactionEnabled,
        effective: false,
        state: "relay-not-connected",
        previewRouted: preview.routed,
      },
      usageStatus: this.store.state.usageStatus,
      usage: this.store.state.usage,
      ...taskDashboard(this.store.state, !this.closed),
      requestEvidence: summarizeRequestEvents(
        this.store.state.runs.map((run) => run.event),
        new Set(this.active ? [this.active.run.id] : []),
      ),
      busy: this.active !== null,
      collecting: this.collecting !== null,
    };
  }
  configure(value: unknown): void {
    const settings = settingsSchema.parse(value);
    validateCompactionRoute({ from: settings.compactionFrom, to: settings.compactionTo, effort: "low" });
    this.store.state.settings = settings;
    if (!this.store.state.settings.usageEnabled) {
      this.store.state.usage = [];
      this.store.state.usageStatus = "disabled";
    } else if (this.store.state.usageStatus === "disabled") this.store.state.usageStatus = "unverified";
    this.store.save();
  }
  collectUsage(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("harness_closed"));
    if (!this.store.state.settings.usageEnabled) return Promise.reject(new Error("usage_consent_required"));
    if (this.collecting) return this.collecting;
    this.collecting = (async () => {
      const client = new CodexClient(this.providerHome, this.workspace);
      this.collection = client;
      try {
        await client.start();
        const result = await client.request("account/rateLimits/read", {});
        const observations = parseCodexRateLimits(result);
        if (this.store.state.settings.usageEnabled) {
          this.store.state.usage = observations;
          this.store.state.usageStatus = observations.length ? "observed" : "unverified";
        }
      } catch {
        if (this.store.state.settings.usageEnabled) this.store.state.usageStatus = "failed";
      } finally {
        client.close();
        this.collection = null;
        this.collecting = null;
        this.store.save();
      }
    })();
    return this.collecting;
  }
  run(taskId: string, value: unknown): WorkRun {
    if (this.closed) throw new Error("harness_closed");
    const input = executionSchema.parse(value);
    const task = this.store.task(taskId);
    const digest = createHash("sha256").update(JSON.stringify({ taskId, input })).digest("hex");
    const previous = this.store.state.runs.find((run) => run.id === input.requestId);
    if (previous) {
      if (previous.inputDigest !== digest) throw new Error("request_id_conflict");
      return previous;
    }
    if (this.active) throw new Error("provider_busy");
    if (this.store.state.runs.length >= 1000) throw new Error("run_storage_limit");
    const gate = checkRateLimit(true);
    if (!gate.allowed) throw new Error(gate.gate ?? "rate_limited");
    const prompt = task.threadId
      ? input.prompt
      : `${task.handoff ?? buildHandoff(task)}\n\nCurrent instruction:\n${input.prompt}`;
    const run: WorkRun = {
      id: input.requestId,
      taskId,
      action: input.action,
      inputDigest: digest,
      prompt,
      dispatched: false,
      settings: structuredClone(this.store.state.settings),
      acknowledgedModel: null,
      output: "",
      completionVerified: false,
      permissionScope: "read-only-no-approval-inheritance",
      taskPhase: task.phase,
      event: {
        requestId: input.requestId,
        threadId: task.threadId,
        turnId: null,
        kind: "response",
        from: input.model,
        to: input.model,
        routed: false,
        phase: "started",
        status: 0,
        requestedEffort: input.effort,
        reasoningEffort: input.effort,
        at: new Date().toISOString(),
        durationMs: 0,
        responseModel: null,
        usage: null,
      },
    };
    this.store.state.runs.unshift(run);
    this.store.save();
    const client = new CodexClient(this.providerHome, this.workspace);
    this.active = { run, client };
    // The asynchronous task remains governed until a terminal provider event or timeout.
    this.execution = runGovernedActivity(() => this.execute(run, input, client))
      .catch(() => {
        this.finish(run, "unverified", "governed_execution_interrupted");
        client.close();
        if (this.active?.run.id === run.id) this.active = null;
      })
      .finally(() => {
        this.execution = null;
      });
    return run;
  }
  private finish(run: WorkRun, phase: CompactionRequestEvent["phase"], errorCode?: string): void {
    run.event = parseCompactionRequestEvent({
      ...run.event,
      phase,
      durationMs: Date.now() - Date.parse(run.event.at),
      at: new Date().toISOString(),
      ...(errorCode ? { errorCode } : {}),
    })!;
    if (phase !== "completed") this.router.failed(run.event.threadId);
    this.store.save();
    auditLog({
      timestamp: new Date().toISOString(),
      tool: "harness_codex_run",
      status: phase === "completed" ? "ok" : "error",
      correlationId: run.id,
      args: { taskId: run.taskId, phase, responseModelVerified: false },
      ...(errorCode ? { errorCategory: errorCode } : {}),
    });
  }
  private async execute(run: WorkRun, input: ExecutionInput, client: CodexClient): Promise<void> {
    let finishTurn!: (value: { phase: CompactionRequestEvent["phase"]; code?: string }) => void;
    const terminal = new Promise<{ phase: CompactionRequestEvent["phase"]; code?: string }>((resolve) => {
      finishTurn = resolve;
    });
    let turnSent = false;
    const started = Date.now();
    const timer = setInterval(() => {
      if (isEmergencyStopActive()) finishTurn({ phase: "unverified", code: "emergency_stop" });
      else if (Date.now() - started > 180_000) finishTurn({ phase: "unverified", code: "provider_timeout" });
    }, 500);
    client.onLost = () => finishTurn({ phase: "unverified", code: "provider_disconnected" });
    client.onNotification = (method, params) => {
      if (params?.threadId !== run.event.threadId) return;
      if (method === "item/completed" && params.item?.type === "agentMessage") {
        run.output = (run.output + String(params.item.text ?? "") + "\n").slice(0, 64_000);
      }
      if (method === "turn/completed") {
        if (run.event.turnId && params.turn?.id !== run.event.turnId) return;
        if (!run.event.turnId && typeof params.turn?.id === "string") run.event.turnId = params.turn.id;
        const status = params.turn?.status;
        finishTurn({
          phase: status === "completed" ? "completed" : status === "failed" ? "failed" : "unverified",
          ...(status === "completed"
            ? {}
            : { code: status === "failed" ? "provider_turn_failed" : "provider_turn_interrupted" }),
        });
      }
    };
    try {
      await client.start();
      const models = await client.request("model/list", { includeHidden: false, limit: 100 });
      const catalog = Array.isArray(models?.data) ? models.data : [];
      this.routerSupported = catalog.some(
        (model: { model: string; supportedReasoningEfforts?: { reasoningEffort: string }[] }) =>
          model.model === "gpt-5.6-luna" &&
          model.supportedReasoningEfforts?.some((effort) => effort.reasoningEffort === "low"),
      );
      const task = this.store.task(run.taskId);
      const resumed = task.threadId !== null;
      const capabilities = catalog
        .filter((item) => typeof item.model === "string")
        .map((item) => ({
          provider: "codex",
          model: item.model,
          efforts: (item.supportedReasoningEfforts ?? [])
            .map((option) => option.reasoningEffort)
            .filter((value) => typeof value === "string"),
        }));
      const phasePreferences = Object.fromEntries(
        Object.entries(run.settings.phasePreferences).map(([phase, choice]) => [
          phase,
          { provider: "codex", ...choice },
        ]),
      );
      // Only new sessions or an explicit model change apply the current preferences.
      // A continuation validates the provider's existing choice through the same core API.
      let selection = selectTaskModel({
        phase: task.phase,
        manualSelection: input.usePhasePreference
          ? task.modelPreference && { provider: "codex", ...task.modelPreference }
          : { provider: "codex", model: input.model, effort: input.effort },
        phasePreferences,
        defaultSelection: { provider: "codex", model: run.settings.model, effort: run.settings.effort },
        capabilities,
      });
      if (!resumed || input.action === "model-only") {
        run.modelSelection = selection;
        this.store.save();
        if (selection.status !== "selected") throw new Error(selection.reason);
      }
      const response = await client.request(resumed ? "thread/resume" : "thread/start", {
        ...(resumed ? { threadId: task.threadId } : {}),
        ...(!resumed || input.action === "model-only" ? { model: selection.selection!.model } : {}),
        cwd: this.workspace,
        approvalPolicy: "never",
        sandbox: "read-only",
      });
      if (typeof response?.thread?.id !== "string" || typeof response.model !== "string")
        throw new Error("provider_thread_unverified");
      task.threadId = response.thread.id;
      run.event.threadId = task.threadId;
      run.acknowledgedModel = modelSchema.parse(response.model);
      if (resumed && input.action === "keep") {
        selection = selectTaskModel({
          phase: task.phase,
          manualSelection: {
            provider: "codex",
            model: response.model,
            ...(response.reasoningEffort ? { effort: response.reasoningEffort } : {}),
          },
          capabilities,
        });
      }
      run.modelSelection = selection;
      if (selection.status !== "selected") throw new Error(selection.reason);
      const model = selection.selection.model;
      const effort = selection.selection.effort;
      run.event.from = model;
      run.event.requestedEffort = effort ?? null;
      const decision = this.router.route(
        {
          model,
          reasoning: { effort },
          input: [{ role: "user", content: [{ type: "input_text", text: run.prompt }] }],
        },
        taskSavingsPolicy(run.settings.taskSavingsEnabled && input.allowTaskRouting && input.action !== "model-only"),
        task.threadId,
      );
      const body = decision.body as { model: string; reasoning: { effort: string | null } };
      run.event.to = body.model;
      run.event.reasoningEffort = body.reasoning.effort;
      run.event.routed = decision.routed;
      run.event.savingsReason = decision.reason;
      const target = catalog.find((item: { model: string }) => item.model === body.model);
      if (
        !target ||
        (body.reasoning.effort &&
          !target.supportedReasoningEfforts?.some(
            (option: { reasoningEffort: string }) => option.reasoningEffort === body.reasoning.effort,
          ))
      ) {
        throw new Error("model_effort_not_supported");
      }
      this.store.save();
      if (this.closed || isEmergencyStopActive()) throw new Error("execution_stopped");
      turnSent = true;
      run.dispatched = true;
      this.store.save();
      const turn = await client.request("turn/start", {
        threadId: task.threadId,
        input: [{ type: "text", text: run.prompt, text_elements: [] }],
        model: body.model,
        ...(body.reasoning.effort ? { effort: body.reasoning.effort } : {}),
        approvalPolicy: "never",
        sandboxPolicy: { type: "readOnly", networkAccess: false },
      });
      if (typeof turn?.turn?.id !== "string") throw new Error("provider_turn_unverified");
      run.event.turnId = turn.turn.id;
      run.event.phase = "response_headers";
      this.store.save();
      const result = await terminal;
      this.finish(run, result.phase, result.code);
    } catch (error) {
      const code = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "provider_unavailable";
      this.finish(run, turnSent ? "unverified" : "failed", code);
    } finally {
      clearInterval(timer);
      client.close();
      if (this.active?.run.id === run.id) this.active = null;
    }
  }
  async close(): Promise<void> {
    if (this.closed) {
      await this.execution;
      return;
    }
    this.closed = true;
    this.active?.client.close();
    this.collection?.close();
    await Promise.allSettled([this.execution, this.collecting].filter(Boolean));
    // Release only after terminal state is persisted; no automatic replay.
    if (existsSync(this.lockPath) && JSON.parse(readFileSync(this.lockPath, "utf8")).nonce === this.lockNonce)
      unlinkSync(this.lockPath);
  }
}
