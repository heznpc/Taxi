import { z } from "zod";
import type { McpServer } from "../shared/mcp.js";
import { errNotFound, okStructured } from "../shared/result.js";
import {
  FRONT_DOOR_TOOLS,
  PROFILE_DESCRIPTIONS,
  PROFILE_MODULES,
  PROFILE_NAMES,
  type TaxiConfig,
} from "../shared/config.js";
import {
  CORE_MODULE_PACK_NAME,
  MODULE_PACK_MANIFEST,
  getModulePackNameForModule,
  type ModulePackName,
} from "../shared/module-packs.js";
import type { ToolRegistry } from "../shared/tool-registry.js";
import { shouldRequireApproval } from "../shared/hitl-guard.js";
import { requiredScopeFor } from "../shared/oauth-scope.js";
import { getRateLimitStatus } from "../shared/rate-limit.js";
import { toolSessions } from "../shared/tool-sessions.js";
import { WORKFLOWS, findWorkflow, summarizeWorkflowsReadiness, type WorkflowReadiness } from "../shared/workflows.js";
import type { HarnessAdapterPolicy } from "../shared/task-adapters.js";
import { sanitizeToolArgs } from "../shared/audit.js";

export interface MissingPackActivationHint {
  pack: ModulePackName;
  modules: string[];
  command: string;
  message: string;
}

export interface RegisterFrontDoorToolsOptions {
  toolRegistry: ToolRegistry;
  config: TaxiConfig;
  harness: HarnessAdapterPolicy;
  enabledModules: string[];
  disabledModules: string[];
  modulePacksAvailable: string[];
  modulesMissingPacks: string[];
  missingPackActivationHints: MissingPackActivationHint[];
  buildWorkflowReadiness: () => WorkflowReadiness[];
}

export function buildMissingPackActivationHints(modulesMissingPacks: string[]): MissingPackActivationHint[] {
  const missingByPack = new Map<ModulePackName, string[]>();
  for (const moduleName of modulesMissingPacks) {
    const packName = getModulePackNameForModule(moduleName);
    if (!packName || packName === CORE_MODULE_PACK_NAME) continue;
    const current = missingByPack.get(packName) ?? [];
    if (!current.includes(moduleName)) current.push(moduleName);
    missingByPack.set(packName, current);
  }

  return MODULE_PACK_MANIFEST.filter((pack) => missingByPack.has(pack.name)).map((pack) => {
    const modules = missingByPack.get(pack.name) ?? [];
    const command = `taxi modules enable ${pack.name}`;
    return {
      pack: pack.name,
      modules,
      command,
      message: `Activate the bundled ${pack.name} module pack to use ${modules.join(", ")}: ${command}. Restart Taxi after changing the active pack set.`,
    };
  });
}

const workflowReadinessIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(["info", "warning", "blocker"]),
  message: z.string(),
  module: z.string().optional(),
  pack: z.string().optional(),
  tool: z.string().optional(),
  command: z.string().optional(),
});

const workflowReadinessSchema = z.object({
  id: z.string(),
  title: z.string(),
  prompt: z.string(),
  requiredModules: z.array(z.string()),
  tools: z.array(z.string()),
  status: z.enum(["ready", "partial", "blocked"]),
  ready: z.boolean(),
  summary: z.string(),
  issues: z.array(workflowReadinessIssueSchema),
});

export function registerFrontDoorTools(server: McpServer, options: RegisterFrontDoorToolsOptions): void {
  const {
    toolRegistry,
    config,
    harness,
    enabledModules,
    disabledModules,
    modulePacksAvailable,
    modulesMissingPacks,
    missingPackActivationHints,
    buildWorkflowReadiness,
  } = options;

  server.registerTool(
    "list_profiles",
    {
      title: "List Profiles",
      description:
        "List Taxi runtime profiles. Profiles choose which modules load; toolExposure chooses how much of that surface appears in tools/list.",
      inputSchema: {},
      outputSchema: {
        profiles: z.array(
          z.object({
            name: z.string(),
            description: z.string(),
            modules: z.array(z.string()),
            defaultToolExposure: z.string(),
          }),
        ),
        active: z.string(),
        toolExposure: z.string(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const profiles = PROFILE_NAMES.map((name) => ({
        name,
        description: PROFILE_DESCRIPTIONS[name],
        modules: [...PROFILE_MODULES[name]],
        defaultToolExposure: name === "full" ? "full" : name === "productivity" ? "profile" : "progressive",
      }));
      return okStructured({ profiles, active: config.profile, toolExposure: config.toolExposure });
    },
  );

  server.registerTool(
    "list_module_packs",
    {
      title: "List Module Packs",
      description: "List Taxi's bundled module packs and whether each pack is active in the current configuration.",
      inputSchema: {},
      outputSchema: {
        configured: z.boolean(),
        active: z.array(z.string()),
        packs: z.array(
          z.object({
            name: z.string(),
            title: z.string(),
            description: z.string(),
            modules: z.array(z.string()),
            active: z.boolean(),
            required: z.boolean(),
          }),
        ),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      return okStructured({
        configured: config.modulePacksConfigured,
        active: modulePacksAvailable,
        packs: MODULE_PACK_MANIFEST.map((pack) => ({
          name: pack.name,
          title: pack.title,
          description: pack.description,
          modules: [...pack.modules],
          active: modulePacksAvailable.includes(pack.name),
          required: "required" in pack && pack.required === true,
        })),
      });
    },
  );

  server.registerTool(
    "profile_status",
    {
      title: "Profile Status",
      description:
        "Show the active Taxi profile, module set, tool exposure mode, exposed tool count, and total registered tool count.",
      inputSchema: {},
      outputSchema: {
        profile: z.string(),
        toolExposure: z.string(),
        modulePacksConfigured: z.boolean(),
        modulePacksAvailable: z.array(z.string()),
        modulesMissingPacks: z.array(z.string()),
        missingPackActivationHints: z.array(
          z.object({
            pack: z.string(),
            modules: z.array(z.string()),
            command: z.string(),
            message: z.string(),
          }),
        ),
        requireToolSession: z.boolean(),
        harnessAdapter: z.string(),
        modulesEnabled: z.array(z.string()),
        modulesDisabled: z.array(z.string()),
        toolsExposed: z.number(),
        toolsRegistered: z.number(),
        toolSessionsActive: z.number(),
        frontDoorTools: z.array(z.string()),
        workflowReadiness: z.object({
          total: z.number(),
          ready: z.number(),
          partial: z.number(),
          blocked: z.number(),
        }),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const workflowReadiness = buildWorkflowReadiness();
      return okStructured({
        profile: config.profile,
        toolExposure: config.toolExposure,
        modulePacksConfigured: config.modulePacksConfigured,
        modulePacksAvailable,
        modulesMissingPacks,
        missingPackActivationHints,
        requireToolSession: config.requireToolSession,
        harnessAdapter: harness.name,
        modulesEnabled: enabledModules,
        modulesDisabled: disabledModules,
        toolsExposed: toolRegistry.getExposedToolCount(),
        toolsRegistered: toolRegistry.getToolCount(),
        toolSessionsActive: toolSessions.activeCount(),
        frontDoorTools: [...FRONT_DOOR_TOOLS],
        workflowReadiness: summarizeWorkflowsReadiness(workflowReadiness),
      });
    },
  );

  server.registerTool(
    "workflow_readiness",
    {
      title: "Workflow Readiness",
      description:
        "Explain whether curated Taxi workflows are ready in the active runtime, including missing modules, inactive bundled packs, tools, and write opt-ins.",
      inputSchema: {
        id: z
          .string()
          .min(1)
          .max(120)
          .optional()
          .describe("Optional workflow id, for example daily-briefing or meeting-prep"),
      },
      outputSchema: {
        activeProfile: z.string(),
        toolExposure: z.string(),
        workflows: z.array(workflowReadinessSchema),
        summary: z.object({
          total: z.number(),
          ready: z.number(),
          partial: z.number(),
          blocked: z.number(),
        }),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }) => {
      const workflows = buildWorkflowReadiness();
      if (id) {
        if (!findWorkflow(id)) {
          return errNotFound(`Unknown workflow "${id}". Known workflows: ${WORKFLOWS.map((w) => w.id).join(", ")}`);
        }
        const readiness = workflows.find((workflow) => workflow.id === id);
        if (!readiness) return errNotFound(`Unknown workflow "${id}".`);
        return okStructured({
          activeProfile: config.profile,
          toolExposure: config.toolExposure,
          workflows: [readiness],
          summary: summarizeWorkflowsReadiness([readiness]),
        });
      }

      return okStructured({
        activeProfile: config.profile,
        toolExposure: config.toolExposure,
        workflows,
        summary: summarizeWorkflowsReadiness(workflows),
      });
    },
  );

  server.registerTool(
    "preview_action",
    {
      title: "Preview Action",
      description:
        "Dry-run governance preview of a tool call WITHOUT executing it. Validates the args against the tool's real " +
        "input schema, reports its risk annotations, whether it would require per-call human approval at the current " +
        "HITL level, its required OAuth scope, the exact PII-scrubbed record the audit log would write, and the live " +
        "rate-limit / emergency-stop posture. The target handler is never invoked — zero side effect. Use it to see " +
        "what a destructive call would record and whether it would be gated, before committing to run it.",
      inputSchema: {
        tool: z.string().min(1).max(120).describe("Tool name to preview, for example delete_reminder or move_note."),
        args: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Arguments you would pass. Validated against the tool's real input schema; never executed."),
      },
      outputSchema: {
        tool: z.string(),
        exists: z.boolean(),
        exposed: z.boolean().optional(),
        annotations: z.object({ destructive: z.boolean(), readOnly: z.boolean(), sensitive: z.boolean() }).optional(),
        argsValid: z.boolean().optional(),
        validationError: z.string().optional(),
        wouldRequireApproval: z.boolean().optional(),
        hitlLevel: z.string(),
        requiredScope: z.string().optional(),
        auditPreview: z
          .object({
            tool: z.string(),
            status: z.string(),
            actor: z.string(),
            args: z.record(z.string(), z.unknown()),
          })
          .optional(),
        rateLimit: z.object({
          emergencyStop: z.boolean(),
          globalRemaining: z.number(),
          destructiveRemaining: z.number(),
        }),
        sideEffect: z.string(),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ tool, args }) => {
      const targetArgs = (args ?? {}) as Record<string, unknown>;
      const preview = toolRegistry.previewCall(tool, targetArgs);
      const rate = getRateLimitStatus();
      const rateLimit = {
        emergencyStop: rate.emergencyStop,
        globalRemaining: rate.globalRemaining,
        destructiveRemaining: rate.destructiveRemaining,
      };
      if (!preview.exists || !preview.annotations) {
        return okStructured({
          tool,
          exists: false,
          hitlLevel: config.hitl.level,
          rateLimit,
          sideEffect: "none — unknown tool, handler not invoked",
        });
      }
      const ann = preview.annotations;
      const wouldRequireApproval = shouldRequireApproval(
        config.hitl.level,
        { destructiveHint: ann.destructive, readOnlyHint: ann.readOnly, sensitiveHint: ann.sensitive },
        config.hitl.whitelist,
        tool,
      );
      return okStructured({
        tool,
        exists: true,
        exposed: preview.exposed,
        annotations: ann,
        argsValid: preview.argsValid,
        ...(preview.validationError ? { validationError: preview.validationError } : {}),
        wouldRequireApproval,
        hitlLevel: config.hitl.level,
        requiredScope: requiredScopeFor({ toolName: tool, isReadOnly: ann.readOnly, isDestructive: ann.destructive }),
        auditPreview: { tool, status: "would-run", actor: "caller", args: sanitizeToolArgs(tool, targetArgs) },
        rateLimit,
        sideEffect: "none — handler not invoked",
      });
    },
  );
}
