#!/usr/bin/env node

if (!process.env.HOME && !process.env.USERPROFILE) {
  console.error("[Taxi] HOME environment variable not set — cannot initialize");
  process.exit(1);
}

// CLI subcommands: Taxi never starts a runtime implicitly. The bare command
// is help; `run` starts the Apple runtime and `repo` starts repository-only MCP.
const command = process.argv[2];
if (command === "--version" || command === "-v" || command === "-V") {
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const __d = dirname(fileURLToPath(import.meta.url));
  const v = JSON.parse(readFileSync(join(__d, "..", "package.json"), "utf-8")).version;
  console.log(v);
  process.exit(0);
}
if (!command || command === "--help" || command === "-h" || command === "help") {
  const mod = await import("./cli/help.js");
  mod.runHelp();
  process.exit(0);
}

if (
  command === "history" ||
  command === "sessions" ||
  command === "work" ||
  command === "browser" ||
  command === "remote"
) {
  try {
    if (command === "remote") {
      const { runRemote } = await import("./cli/remote.js");
      await runRemote();
    } else if (command === "browser") {
      const { runBrowser } = await import("./cli/browser.js");
      await runBrowser();
    } else if (command === "work") {
      const { runWork } = await import("./cli/work.js");
      await runWork();
    } else if (command === "history") {
      const { runHistory } = await import("./cli/history.js");
      await runHistory();
    } else {
      const { readModoreSnapshot } = await import("./interop/modore.js");
      const path = process.argv[3];
      if (!path || process.argv.length !== 4) throw new Error("Usage: taxi sessions <Modore snapshot.json>");
      console.log(JSON.stringify(await readModoreSnapshot(path), null, 2));
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "History command failed");
    process.exitCode = 1;
  }
  process.exit(process.exitCode ?? 0);
}

if (["setup", "doctor", "verify", "modules", "workflows", "connect", "clients", "codex"].includes(command)) {
  if (command === "setup") {
    const mod = await import("./cli/setup.js");
    await mod.runSetup();
  } else if (command === "doctor") {
    const mod = await import("./cli/doctor.js");
    await mod.runDoctor();
  } else if (command === "verify") {
    const mod = await import("./cli/verify.js");
    const code = await mod.runVerify();
    if (code !== 0) process.exitCode = code;
  } else if (command === "modules") {
    const mod = await import("./cli/modules.js");
    await mod.runModules();
  } else if (command === "workflows") {
    const mod = await import("./cli/workflows.js");
    await mod.runWorkflows();
  } else if (command === "connect") {
    const mod = await import("./cli/connect.js");
    await mod.runConnect();
  } else if (command === "clients") {
    const mod = await import("./cli/clients.js");
    mod.runClients();
  } else if (command === "codex") {
    const mod = await import("./cli/codex.js");
    mod.runCodex();
  }
  // Respect a non-zero code a subcommand set via process.exitCode (e.g.
  // `workflows <unknown>` / `--preview` errors). A blanket exit(0) would mask
  // those and silently break `taxi workflows … || exit 1` scripting.
  process.exit(process.exitCode ?? 0);
}
if (command === "repo") {
  try {
    const { runRepo } = await import("./cli/repo.js");
    await runRepo();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Repository server failed.");
    process.exitCode = 1;
  }
} else if (command !== "run") {
  console.error(`[Taxi] Unknown command: "${command}". Run 'taxi --help' for usage.`);
  process.exit(1);
}

if (command === "run") {
  // ESM imports are hoisted even when written below the command branch. Keep the
  // runtime graph behind the explicit `run` boundary so help/doctor/config-only
  // commands cannot execute server module initializers merely by starting Taxi.
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { printBanner } = await import("./shared/banner.js");
  const { IDENTITY } = await import("./shared/constants.js");
  const { APP_RUNTIME_TOKEN_PATH } = await import("./shared/app-runtime-token.js");
  const { APP_RUNTIME_OWNER_SECRET_PATH, readPrivateRuntimeCredential } =
    await import("./shared/app-runtime-identity.js");
  const { initializeServer } = await import("./server/init.js");
  const { createServer } = await import("./server/mcp-setup.js");
  const { startHttpServer } = await import("./server/http-transport.js");
  const { wireStdioShutdown } = await import("./server/stdio-shutdown.js");

  const args = process.argv.slice(3);
  const httpMode = args.includes("--http");
  const portIdx = args.indexOf("--port");
  const port = portIdx !== -1 && args[portIdx + 1] ? parseInt(args[portIdx + 1]!, 10) : IDENTITY.HTTP_PORT;
  const bindAll = args.includes("--bind-all");
  const unsafeNoAuth = args.includes("--unsafe-no-auth");
  const appOwnedRuntime = process.env.TAXI_APP_OWNED_RUNTIME === "1";
  const environmentHttpToken = process.env.TAXI_HTTP_TOKEN ?? "";
  const environmentOwnerSecret = process.env.TAXI_APP_RUNTIME_OWNER_SECRET ?? "";
  const appRuntimeTokenPath = process.env.TAXI_APP_RUNTIME_TOKEN_PATH || APP_RUNTIME_TOKEN_PATH;
  const appRuntimeOwnerPath = process.env.TAXI_APP_RUNTIME_OWNER_PATH || APP_RUNTIME_OWNER_SECRET_PATH;

  // Keep HTTP credentials and app-owned credential locations in this process
  // only. The native app passes owner-only file paths instead of secret values;
  // remove both legacy values and paths before any tool subprocess can launch.
  delete process.env.TAXI_HTTP_TOKEN;
  delete process.env.TAXI_APP_RUNTIME_OWNER_SECRET;
  delete process.env.TAXI_APP_RUNTIME_TOKEN_PATH;
  delete process.env.TAXI_APP_RUNTIME_OWNER_PATH;

  const ctx = initializeServer();

  async function main() {
    if (httpMode) {
      const httpToken = appOwnedRuntime
        ? readPrivateRuntimeCredential(appRuntimeTokenPath, "app runtime HTTP token")
        : environmentHttpToken;
      const appRuntimeOwnerSecret = appOwnedRuntime
        ? readPrivateRuntimeCredential(appRuntimeOwnerPath, "app runtime owner secret")
        : environmentOwnerSecret;
      await startHttpServer({
        config: ctx.config,
        hitlClient: ctx.hitlClient,
        osVersion: ctx.osVersion,
        pkg: ctx.pkg,
        port,
        bindAll,
        httpToken,
        appRuntimeOwnerSecret,
        unsafeNoAuth,
      });
    } else {
      const { server, bannerInfo } = await createServer(ctx);
      const transport = new StdioServerTransport();
      wireStdioShutdown(transport, process.stdin, ctx.shutdown);
      await server.connect(transport);
      await printBanner(bannerInfo);
    }
  }

  main().catch(async (error) => {
    console.error("Fatal error:", error);
    await ctx.shutdown(1);
  });
}
