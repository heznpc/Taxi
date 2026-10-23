import {
  configureCodexTaxi,
  inspectCodexTaxiRegistration,
  setCodexTaxiEnabled,
  type CodexTaxiEnabledResult,
  type CodexTaxiRegistrationState,
} from "./codex-mcp.js";

type CodexAction = "enable" | "disable" | "status";

interface CodexOptions {
  action: CodexAction;
  json: boolean;
}

function usage(): string {
  return [
    "Usage: taxi codex [status|enable|disable] [--json]",
    "",
    "Inspect or toggle the persistent Taxi entry in the active Codex user config.",
    "Path priority: TAXI_CODEX_CONFIG_PATH, CODEX_HOME/config.toml, then ~/.codex/config.toml.",
    "A relative explicit path is resolved from the invoking directory and must be named config.toml.",
    "A project-local .codex/config.toml is never edited and may override the global setting.",
  ].join("\n");
}

function parseArgs(args: string[]): CodexOptions {
  let action: CodexAction = "status";
  let actionSeen = false;
  let json = false;
  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "status" || arg === "enable" || arg === "disable") {
      if (actionSeen) throw new Error(`Unexpected Codex action: ${arg}`);
      action = arg;
      actionSeen = true;
      continue;
    }
    throw new Error(`Unknown codex option: ${arg}`);
  }
  return { action, json };
}

function printHuman(options: CodexOptions, state: CodexTaxiRegistrationState, changed: boolean | undefined): void {
  const verb = options.action === "status" ? "is" : changed ? "is now" : "is already";
  if (state.globalState === "missing") {
    console.log(`Codex Taxi is not registered in ${state.globalConfigPath}.`);
  } else if (state.globalState === "invalid") {
    console.log(`Codex Taxi has an invalid enabled setting in ${state.globalConfigPath}.`);
  } else {
    console.log(`Codex Taxi ${verb} ${state.globalState} in ${state.globalConfigPath}.`);
  }
  if (state.projectOverride) {
    console.log(
      `Warning: ${state.projectOverride.path} defines Taxi (${state.projectOverride.state}) and takes precedence in that project; it was not edited.`,
    );
  }
}

export function runCodex(args = process.argv.slice(3)): void {
  try {
    const options = parseArgs(args);
    let state: CodexTaxiRegistrationState | CodexTaxiEnabledResult;
    let changed: boolean | undefined;

    if (options.action === "status") {
      state = inspectCodexTaxiRegistration();
    } else {
      const enabled = options.action === "enable";
      let result = setCodexTaxiEnabled(enabled);
      if (enabled && result.globalState === "missing") {
        configureCodexTaxi({ enabled: true });
        result = { ...inspectCodexTaxiRegistration(), changed: true };
      }
      state = result;
      changed = result.changed;
    }

    const payload = { action: options.action, ...state, ...(changed === undefined ? {} : { changed }) };
    if (options.json) console.log(JSON.stringify(payload, null, 2));
    else printHuman(options, state, changed);

    if (state.globalState === "invalid") process.exitCode = 1;
  } catch (error) {
    console.error(`[Taxi] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
