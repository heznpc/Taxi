import { readFile } from "node:fs/promises";
import { executeProvider, inspectWork, cancelWork, recoverWork, reviewWork } from "../work/provider.js";
export async function runWork(args = process.argv.slice(3)) {
  const [action, id, note] = args;
  if (!id) throw new Error("Usage: taxi work run <request.json> | show/cancel/recover <id> | review <id> <note-file>");
  let result: unknown;
  if (action === "run")
    result = await executeProvider(JSON.parse(await readFile(id, "utf8")), (workId) => console.error(`Work ${workId}`));
  else if (action === "show") result = await inspectWork(id);
  else if (action === "cancel") result = await cancelWork(id);
  else if (action === "recover") result = await recoverWork(id);
  else if (action === "review" && note) result = await reviewWork(id, await readFile(note, "utf8"));
  else throw new Error("Unknown work action");
  console.log(JSON.stringify(result, null, 2));
  if (action === "run" && (result as { outcome?: string }).outcome !== "returned") process.exitCode = 1;
}
