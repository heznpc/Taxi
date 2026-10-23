import { submitRemote, reconcileRemote } from "../remote/execution.js";
export async function runRemote(args = process.argv.slice(3)) {
  const [action, target, flowId] = args;
  const token = process.env.TAXI_REMOTE_TOKEN ?? "";
  if (!target)
    throw new Error("Usage: taxi remote submit <HTTPS executor> <flow UUID> | reconcile/cancel <request UUID>");
  if (action === "serve") {
    if (process.platform !== "win32") throw new Error("PAD server requires Windows");
    const { readFile } = await import("node:fs/promises");
    const { z } = await import("zod");
    const { PATHS } = await import("../shared/constants.js");
    const { join } = await import("node:path");
    const { startPadExecutor, launchPad } = await import("../remote/pad-executor.js");
    const flows = z.record(z.string().uuid(), z.string().min(1)).parse(JSON.parse(await readFile(target, "utf8")));
    const instance = await startPadExecutor({
      directory: join(PATHS.VECTOR_STORE, "pad-executor"),
      token,
      flows,
      port: 3850,
      launch: launchPad,
    });
    console.error("PAD executor listening on 127.0.0.1:3850");
    await new Promise<void>((resolve) => {
      const stop = () => {
        instance
          .close()
          .then(resolve)
          .catch(() => resolve());
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return;
  }
  let result;
  if (action === "submit" && flowId) result = await submitRemote(target, flowId, token);
  else if (action === "reconcile" || action === "cancel")
    result = await reconcileRemote(target, token, action === "cancel");
  else throw new Error("Unknown remote command");
  console.log(JSON.stringify(result, null, 2));
}
