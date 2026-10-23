import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRepositoryServer } from "../repository/server.js";
import { flushAuditLog } from "../shared/audit.js";
import { wireStdioShutdown } from "../server/stdio-shutdown.js";

export async function runRepo(args = process.argv.slice(3)): Promise<void> {
  if (args.length === 1 && ["--help", "-h"].includes(args[0]!)) {
    console.log(
      "Usage: taxi repo --root <absolute-git-worktree-root>\nRead-only stdio MCP for local committed source, git state and staged diffs. No public listener.\nFor Secure MCP Tunnel setup, see docs/chatgpt-local-repository.md.",
    );
    return;
  }
  if (args.length !== 2 || args[0] !== "--root" || !args[1]?.startsWith("/")) {
    throw new Error("Usage: taxi repo --root <absolute-git-worktree-root>");
  }
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../../package.json", import.meta.url)), "utf8"));
  const { server } = await createRepositoryServer(args[1], pkg.version);
  const transport = new StdioServerTransport();
  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    try {
      await server.close();
      await flushAuditLog();
    } finally {
      process.exit(0);
    }
  };
  wireStdioShutdown(transport, process.stdin, shutdown);
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
  await server.connect(transport);
  console.error("[Taxi] repository-only stdio ready; no Apple tools or command execution exposed");
}
