import type { ModuleRegistration } from "./registry.js";
import type { ModuleManifestEntry } from "./modules.js";
import { getModulePackNameForModule } from "./module-packs.js";
import { log, errToCtx } from "./logger.js";

// Taxi 1.0 ships every standard module in the root runtime. Activation is a
// config choice, not an npm installation or discovery boundary.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findRegisterFn(mod: Record<string, any>): ((...args: any[]) => any) | undefined {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let fallback: ((...args: any[]) => any) | undefined;
  for (const [key, value] of Object.entries(mod)) {
    if (typeof value !== "function" || !key.startsWith("register")) continue;
    if (key.includes("Dynamic")) {
      fallback ??= value;
      continue;
    }
    return value;
  }
  return fallback;
}

async function importBundledModule(
  def: ModuleManifestEntry,
  kind: "tools" | "prompts",
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<Record<string, any>> {
  return (await import(`../${def.name}/${kind}.js`)) as Record<string, unknown>;
}

/** Import one bundled module definition, returning null on failure. */
export async function importModuleRegistration(def: ModuleManifestEntry): Promise<ModuleRegistration | null> {
  try {
    const toolsFn = findRegisterFn(await importBundledModule(def, "tools"));
    if (!toolsFn) {
      log.warn("no register function found in tools.ts", { module: def.name });
      return null;
    }

    let promptsFn: ModuleRegistration["prompts"] | undefined;
    if (def.hasPrompts) promptsFn = findRegisterFn(await importBundledModule(def, "prompts"));

    return {
      name: def.name,
      tools: toolsFn,
      prompts: promptsFn,
      minMacosVersion: def.minMacosVersion,
      compatibility: def.compatibility,
      pack: getModulePackNameForModule(def.name) ?? undefined,
    } as ModuleRegistration;
  } catch (error) {
    log.error("failed to load bundled module", { module: def.name, err: errToCtx(error) });
    return null;
  }
}
