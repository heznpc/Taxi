#!/usr/bin/env node
/** Portable Windows entry; bundled by scripts/build-pad-executor.mjs. */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { launchPad, startPadExecutor, recoverPadStore } from "./pad-executor.js";
const [action, flowMap, directory] = process.argv.slice(2);
try {
  if (process.platform !== "win32") throw new Error("This entry point requires Windows");
  if (action === "recover-store" && flowMap) {
    console.log(JSON.stringify(await recoverPadStore(resolve(flowMap))));
  } else if (action === "serve" && flowMap && directory) {
    const flows = z.record(z.string().uuid(), z.string().min(1)).parse(JSON.parse(await readFile(flowMap, "utf8")));
    const instance = await startPadExecutor({
      directory: resolve(directory),
      token: process.env.TAXI_REMOTE_TOKEN ?? "",
      flows,
      port: 3850,
      launch: launchPad,
    });
    console.log("PAD executor listening on 127.0.0.1:3850");
    let closing = false;
    const stop = () => {
      if (closing) return;
      closing = true;
      instance.close().catch(() => {
        process.exitCode = 1;
      });
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } else
    throw new Error(
      "Usage: pad-executor.mjs serve <flow-map.json> <state directory> | recover-store <state directory>",
    );
} catch (e) {
  console.error(e instanceof Error ? e.message : "Executor failed");
  process.exitCode = 1;
}
