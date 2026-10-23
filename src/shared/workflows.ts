import { readFileSync } from "node:fs";
import { getModulePackNameForModule } from "./module-packs.js";
import { PRESET_PROFILE_NAMES, getProfileModules } from "./profiles.js";

export interface Workflow {
  id: string;
  title: string;
  bestFor: string;
  prompt: string;
  siri?: string;
  tools: string[];
  requiredModules: string[];
  implementation: "prompt-recipe" | "built-in-skill";
  safety: string;
}

export type WorkflowReadinessStatus = "ready" | "partial" | "blocked";
export type WorkflowReadinessSeverity = "info" | "warning" | "blocker";

export interface WorkflowReadinessIssue {
  code: "module_disabled" | "module_pack_unavailable" | "tool_not_registered" | "write_opt_in_disabled";
  severity: WorkflowReadinessSeverity;
  message: string;
  module?: string;
  pack?: string;
  tool?: string;
  command?: string;
}

export interface WorkflowReadinessContext {
  enabledModules: readonly string[];
  modulesMissingPacks?: readonly string[];
  registeredTools?: readonly string[] | ReadonlySet<string>;
  allowSendMail?: boolean;
  allowSendMessages?: boolean;
}

export interface WorkflowReadiness {
  id: string;
  title: string;
  prompt: string;
  requiredModules: string[];
  tools: string[];
  status: WorkflowReadinessStatus;
  ready: boolean;
  summary: string;
  issues: WorkflowReadinessIssue[];
}

const workflowCatalog = JSON.parse(
  readFileSync(new URL("./workflows-catalog.json", import.meta.url), "utf8"),
) as Workflow[];

export const WORKFLOWS: Workflow[] = workflowCatalog;

function toSet(values: readonly string[] | ReadonlySet<string> | undefined): ReadonlySet<string> {
  return values instanceof Set ? values : new Set(values ?? []);
}

function enableCommandForPack(pack: string): string {
  return `taxi modules enable ${pack}`;
}

function enableProfileCommand(workflow: Workflow): string {
  const requiredModules = new Set(workflow.requiredModules);
  const profile = PRESET_PROFILE_NAMES.map((name) => {
    const modules = getProfileModules(name);
    return { name, modules, moduleSet: new Set<string>(modules) };
  })
    .filter(({ moduleSet }) => Array.from(requiredModules).every((moduleName) => moduleSet.has(moduleName)))
    .sort((a, b) => a.modules.length - b.modules.length)[0]?.name;

  return `taxi setup --profile ${profile ?? "full"} --yes`;
}

function issueKey(issue: WorkflowReadinessIssue): string {
  return [issue.code, issue.module ?? "", issue.pack ?? "", issue.tool ?? ""].join(":");
}

function workflowSummary(
  status: WorkflowReadinessStatus,
  issues: readonly WorkflowReadinessIssue[],
  verifiedToolRegistration: boolean,
): string {
  if (status === "ready") {
    return verifiedToolRegistration
      ? "Ready: required modules and workflow tools are available."
      : "Ready: required modules, module packs, and write opt-ins are configured; tool registration was not checked.";
  }
  const blockers = issues.filter((issue) => issue.severity === "blocker");
  if (blockers.length > 0) {
    const noun = verifiedToolRegistration ? "runtime item" : "configuration item";
    return `Blocked: ${blockers.length} required ${noun}${blockers.length === 1 ? "" : "s"} missing.`;
  }
  return verifiedToolRegistration
    ? "Partial: runtime is available, but one or more write opt-ins remain disabled."
    : "Partial: required modules and module packs are configured, but one or more write opt-ins remain disabled.";
}

export function findWorkflow(id: string): Workflow | undefined {
  return WORKFLOWS.find((workflow) => workflow.id === id);
}

export function assessWorkflowReadiness(workflow: Workflow, context: WorkflowReadinessContext): WorkflowReadiness {
  const enabledModules = toSet(context.enabledModules);
  const missingPackModules = toSet(context.modulesMissingPacks);
  const registeredTools = context.registeredTools ? toSet(context.registeredTools) : null;
  const verifiedToolRegistration = registeredTools !== null;
  const issues: WorkflowReadinessIssue[] = [];
  const seenIssues = new Set<string>();

  function addIssue(issue: WorkflowReadinessIssue) {
    const key = issueKey(issue);
    if (seenIssues.has(key)) return;
    seenIssues.add(key);
    issues.push(issue);
  }

  for (const moduleName of workflow.requiredModules) {
    const pack = getModulePackNameForModule(moduleName);
    if (missingPackModules.has(moduleName)) {
      addIssue({
        code: "module_pack_unavailable",
        severity: "blocker",
        module: moduleName,
        ...(pack ? { pack, command: enableCommandForPack(pack) } : {}),
        message: pack
          ? `Module "${moduleName}" needs inactive bundled pack "${pack}".`
          : `Module "${moduleName}" is not available in the active pack set.`,
      });
      continue;
    }
    if (!enabledModules.has(moduleName)) {
      addIssue({
        code: "module_disabled",
        severity: "blocker",
        module: moduleName,
        command: enableProfileCommand(workflow),
        message: `Enable module "${moduleName}" for this workflow by switching to a profile that includes it.`,
      });
    }
  }

  if (registeredTools) {
    for (const tool of workflow.tools) {
      if (!registeredTools.has(tool)) {
        addIssue({
          code: "tool_not_registered",
          severity: "blocker",
          tool,
          message: `Workflow tool "${tool}" is not registered in the active runtime.`,
        });
      }
    }
  }

  if (workflow.tools.includes("send_mail") && context.allowSendMail !== true) {
    addIssue({
      code: "write_opt_in_disabled",
      severity: "warning",
      tool: "send_mail",
      message: "Mail send tools require allowSendMail=true or TAXI_ALLOW_SEND_MAIL=true before live sending.",
    });
  }

  if (workflow.tools.includes("send_message") && context.allowSendMessages !== true) {
    addIssue({
      code: "write_opt_in_disabled",
      severity: "warning",
      tool: "send_message",
      message:
        "Message send tools require allowSendMessages=true or TAXI_ALLOW_SEND_MESSAGES=true before live sending.",
    });
  }

  const status: WorkflowReadinessStatus = issues.some((issue) => issue.severity === "blocker")
    ? "blocked"
    : issues.some((issue) => issue.severity === "warning")
      ? "partial"
      : "ready";

  return {
    id: workflow.id,
    title: workflow.title,
    prompt: workflow.prompt,
    requiredModules: workflow.requiredModules,
    tools: workflow.tools,
    status,
    ready: status === "ready",
    summary: workflowSummary(status, issues, verifiedToolRegistration),
    issues,
  };
}

export function assessWorkflowsReadiness(context: WorkflowReadinessContext): WorkflowReadiness[] {
  return WORKFLOWS.map((workflow) => assessWorkflowReadiness(workflow, context));
}

export function summarizeWorkflowsReadiness(workflows: Array<{ status: WorkflowReadinessStatus }>): {
  total: number;
  ready: number;
  partial: number;
  blocked: number;
} {
  return {
    total: workflows.length,
    ready: workflows.filter((workflow) => workflow.status === "ready").length,
    partial: workflows.filter((workflow) => workflow.status === "partial").length,
    blocked: workflows.filter((workflow) => workflow.status === "blocked").length,
  };
}
