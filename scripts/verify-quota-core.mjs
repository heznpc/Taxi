import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export function verifyQuotaCore() {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const filename = "heznpc-quota-core-0.2.0.tgz";
  const expected = readFileSync(resolve(root, "vendor", filename + ".sha256"), "utf8").trim().split(/\s+/)[0];
  const actual = createHash("sha256").update(readFileSync(resolve(root, "vendor", filename))).digest("hex");
  if (!/^[a-f0-9]{64}$/.test(expected) || actual !== expected) throw new Error("quota-core artifact checksum mismatch");
  const installed = JSON.parse(readFileSync(resolve(root, "node_modules/@heznpc/quota-core/package.json"), "utf8"));
  if (installed.name !== "@heznpc/quota-core" || installed.version !== "0.2.0") throw new Error("quota-core installed version mismatch");
}
if (process.argv[1] === fileURLToPath(import.meta.url)) { verifyQuotaCore(); console.log("quota-core 0.2.0 checksum and installed version verified"); }
