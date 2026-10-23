#!/usr/bin/env node
// Prepare an owner-only local profile. Does not create a remote tunnel, start
// polling, grant workspace access or put key values in config/argv.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log(
    "Usage: node scripts/prepare-repository-tunnel.mjs --tunnel-id <existing-id> [--api-key-file <owner-only-file>]\nUses the verified binary in .build/tunnel-client/tunnel-client. Prepares config only.",
  );
  process.exit(0);
}
const options = {};
for (let index = 0; index < args.length; index += 2) {
  if (!["--tunnel-id", "--api-key-file"].includes(args[index]) || !args[index + 1] || options[args[index]])
    throw new Error("Unknown, missing or duplicate option. Use --help.");
  options[args[index]] = args[index + 1];
}
if (!/^tunnel_[A-Za-z0-9_-]+$/.test(options["--tunnel-id"] ?? ""))
  throw new Error("Provide an existing Platform tunnel ID with --tunnel-id.");
let keyRef = "env:CONTROL_PLANE_API_KEY";
if (options["--api-key-file"]) {
  const path = resolve(options["--api-key-file"]);
  const stat = statSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid()))
    throw new Error("Runtime key file must be an owner-only regular file (0600).");
  keyRef = `file:${path}`;
}
const binary = join(root, ".build/tunnel-client/tunnel-client");
if (!existsSync(binary))
  throw new Error(
    "Install the official tunnel-client release under .build/tunnel-client first; see docs/chatgpt-local-repository.md.",
  );
if (!existsSync(join(root, "dist/index.js"))) throw new Error("Run npm run build first.");
const profileDir = join(root, ".build/repository-tunnel");
mkdirSync(profileDir, { recursive: true, mode: 0o700 });
const quote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
const command = [process.execPath, join(root, "dist/index.js"), "repo", "--root", root].map(quote).join(" ");
execFileSync(
  binary,
  [
    "init",
    "--sample",
    "sample_mcp_stdio_local",
    "--profile",
    "taxi-repository",
    "--profile-dir",
    profileDir,
    "--tunnel-id",
    options["--tunnel-id"],
    "--mcp-command",
    command,
    "--control-plane-api-key-ref",
    keyRef,
    "--health-listen-addr",
    "127.0.0.1:0",
  ],
  { stdio: "inherit" },
);
console.log("Prepared repository-only profile. No remote connection started.");
for (const verb of ["doctor", "run"])
  console.log(
    [
      binary,
      verb,
      "--profile",
      "taxi-repository",
      "--profile-dir",
      profileDir,
      ...(verb === "doctor" ? ["--explain"] : []),
    ]
      .map(quote)
      .join(" "),
  );
