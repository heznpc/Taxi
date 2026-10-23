#!/usr/bin/env node
// Real MCP wire probe against the selected repository; no tunnel/API key needed.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { cleanBootEnv } from "./lib/clean-boot-env.mjs";
const project = fileURLToPath(new URL("..", import.meta.url));
const root = resolve(process.argv[2] ?? project);
const state = mkdtempSync(join(tmpdir(), "taxi-repo-wire-"));
const client = new Client({ name: "taxi-repo-wire-check", version: "1" }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(project, "dist/index.js"), "repo", "--root", root],
  stderr: "pipe",
  env: { ...cleanBootEnv(), TAXI_FULL: "true", TAXI_VECTOR_STORE_DIR: state },
});
try {
  await client.connect(transport);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map((t) => t.name).sort(), [
    "git_diff",
    "git_log",
    "read_file",
    "repo_status",
    "repo_tree",
    "runtime_status",
    "search_code",
  ]);
  assert(listed.tools.every((t) => t.annotations.readOnlyHint && !t.annotations.destructiveHint));
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert(!result.isError, JSON.stringify(result));
    return result.structuredContent;
  };
  const status = await call("repo_status");
  const file = await call("read_file", { path: "package.json", ref: status.head, limit: 10 });
  assert.equal(file.commit, status.head);
  assert(file.content.includes("@heznpc/taxi"));
  const search = await call("search_code", { query: "capture_window", prefix: "src/screen/", ref: status.head });
  assert(search.matches.length > 0);
  const log = await call("git_log", { ref: status.head, limit: 1 });
  assert.equal(log.commits[0].commit, status.head);
  const diff = await call("git_diff", { base: status.head, target: status.head });
  assert.equal(diff.patch, "");
  const tree = await call("repo_tree", { ref: status.head, limit: 2 });
  assert.equal(tree.files.length, 2);
  const resources = await client.listResources();
  assert.equal(resources.resources.length, 4);
  for (const resource of resources.resources) {
    const value = await client.readResource({ uri: resource.uri });
    assert(value.contents.length > 0);
  }
  assert.equal((await client.callTool({ name: "read_file", arguments: { path: "../outside.txt" } })).isError, true);
  assert.equal(
    (await client.callTool({ name: "run_tool", arguments: { name: "run_shell", arguments: {} } })).isError,
    true,
  );
  assert.equal((await call("runtime_status")).appOwned, false);
  console.log(
    JSON.stringify(
      {
        route: "local MCP stdio (not ChatGPT/tunnel)",
        status,
        checks: [
          "7 read-only tools",
          "4 readable resources",
          "pinned file/read/search/log/tree",
          "path escape denied",
          "generic tool dispatcher absent",
        ],
        fileEvidence: { path: file.path, commit: file.commit, blob: file.blob, sha256: file.sha256 },
        auditDirectory: state,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}
