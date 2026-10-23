/** `taxi modules` — inspect and select Taxi's bundled module packs. */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { PATHS } from "../shared/constants.js";
import {
  CORE_MODULE_PACK_NAME,
  MODULE_PACK_MANIFEST,
  getModulePackStatuses,
  resolveModulePackSelection,
  type ModulePackName,
} from "../shared/module-packs.js";
import { isPlainObject } from "../shared/validate.js";
import { BOLD, CYAN, DIM, GREEN, RESET, WHITE } from "./style.js";

type ModulesCommand = "list" | "doctor" | "enable" | "disable" | "help";
interface ParsedArgs {
  command: ModulesCommand;
  tokens: string[];
  json: boolean;
  dryRun: boolean;
}

function readConfig(): Record<string, unknown> {
  if (!existsSync(PATHS.CONFIG)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(PATHS.CONFIG, "utf-8"));
    return isPlainObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function writeConfig(config: Record<string, unknown>): void {
  mkdirSync(dirname(PATHS.CONFIG), { recursive: true });
  writeFileSync(PATHS.CONFIG, JSON.stringify(config, null, 2) + "\n");
}

function parseArgs(argv = process.argv.slice(3)): ParsedArgs {
  let command: ModulesCommand = "list";
  const tokens: string[] = [];
  let json = false;
  let dryRun = false;
  for (const arg of argv) {
    if (arg === "--json") json = true;
    else if (arg === "--dry-run") dryRun = true;
    else if (arg === "--help" || arg === "-h" || arg === "help") command = "help";
    else if (["list", "doctor", "enable", "disable"].includes(arg)) command = arg as ModulesCommand;
    else if (arg === "install" || arg === "uninstall" || arg === "--install" || arg === "--uninstall") {
      throw new Error("Taxi 1.0 modules are bundled; package installation and removal are not supported");
    } else
      tokens.push(
        ...arg
          .split(",")
          .map((token) => token.trim())
          .filter(Boolean),
      );
  }
  return { command, tokens, json, dryRun };
}

function currentPackSet(config: Record<string, unknown>): Set<ModulePackName> {
  const raw = process.env.TAXI_MODULE_PACKS ?? (config.modulePacks as string | string[] | undefined);
  return resolveModulePackSelection(raw).packs;
}

function packNamesFor(tokens: string[]): Set<ModulePackName> {
  const selection = resolveModulePackSelection(tokens.length ? tokens : ["all"]);
  if (selection.unknown.length) throw new Error(`Unknown module packs: ${selection.unknown.join(", ")}`);
  return selection.packs;
}

function sortedPackList(packs: ReadonlySet<ModulePackName>): ModulePackName[] {
  return MODULE_PACK_MANIFEST.map((pack) => pack.name).filter((name) => packs.has(name));
}

function statusPayload(config: Record<string, unknown>) {
  const configured = process.env.TAXI_MODULE_PACKS !== undefined || config.modulePacks !== undefined;
  const packs = getModulePackStatuses(currentPackSet(config));
  return {
    configPath: PATHS.CONFIG,
    configured,
    distribution: "bundled" as const,
    active: packs.filter((pack) => pack.available).map((pack) => pack.name),
    packs: packs.map(({ name, title, description, modules, available, required }) => ({
      name,
      title,
      description,
      modules,
      active: available,
      required,
    })),
  };
}

function printList(payload: ReturnType<typeof statusPayload>): void {
  console.log("");
  console.log(`  ${BOLD}${WHITE}Taxi bundled module packs${RESET}`);
  console.log(`  ${DIM}Config: ${payload.configPath}${RESET}`);
  console.log("");
  for (const pack of payload.packs) {
    const state = pack.active ? `${GREEN}enabled${RESET}` : `${DIM}disabled${RESET}`;
    const required = pack.required ? ` ${DIM}(required)${RESET}` : "";
    console.log(`  ${state.padEnd(18)} ${CYAN}${pack.name}${RESET}${required}`);
    console.log(`    ${DIM}${pack.modules.join(", ")}${RESET}`);
  }
  console.log("");
}

function printHelp(): void {
  console.log("");
  console.log(`  ${BOLD}${WHITE}Taxi modules${RESET} ${DIM}Select bundled module packs${RESET}`);
  console.log("");
  console.log(`    ${GREEN}$${RESET} taxi ${BOLD}modules${RESET}`);
  console.log(`    ${GREEN}$${RESET} taxi ${BOLD}modules list --json${RESET}`);
  console.log(`    ${GREEN}$${RESET} taxi ${BOLD}modules enable productivity,communications${RESET}`);
  console.log(`    ${GREEN}$${RESET} taxi ${BOLD}modules disable media${RESET}`);
  console.log(`    ${GREEN}$${RESET} taxi ${BOLD}modules doctor${RESET}`);
  console.log("");
}

export async function runModules(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }
  if (args.command === "help") {
    printHelp();
    return;
  }

  const config = readConfig();
  if (["enable", "disable"].includes(args.command) && process.env.TAXI_MODULE_PACKS !== undefined) {
    console.error("TAXI_MODULE_PACKS is set; unset it before editing config.json with `taxi modules`.");
    process.exitCode = 1;
    return;
  }

  let plannedActive: ModulePackName[] | undefined;
  if (args.command === "enable" || args.command === "disable") {
    try {
      const next = currentPackSet(config);
      const requested = packNamesFor(args.tokens);
      for (const pack of requested) {
        if (args.command === "enable") next.add(pack);
        else if (pack !== CORE_MODULE_PACK_NAME) next.delete(pack);
      }
      next.add(CORE_MODULE_PACK_NAME);
      plannedActive = sortedPackList(next);
      if (!args.dryRun) {
        config.modulePacks = plannedActive;
        writeConfig(config);
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      return;
    }
  }

  const effectiveConfig = args.dryRun && plannedActive ? { ...config, modulePacks: plannedActive } : config;
  const payload = { ...statusPayload(effectiveConfig), ...(plannedActive ? { plannedActive } : {}) };
  if (args.json) console.log(JSON.stringify(payload, null, 2));
  else {
    if (args.command === "doctor") {
      console.log("");
      console.log(`  ${GREEN}ok${RESET} Taxi 1.0 uses only modules bundled in @heznpc/taxi.`);
      console.log(`  ${GREEN}ok${RESET} All standard modules are bundled; no package discovery is performed.`);
    }
    printList(payload);
  }
}
