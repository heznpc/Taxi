import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, realpath, rm, copyFile, chmod, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { backgroundNetwork } from "./background-network.js";

const exec = promisify(execFile);
// Keychain reads must never summon SecurityAgent before the boundary starts.
const keychainReader = `import Foundation
import Security
import LocalAuthentication
// macOS's legacy file keychain does not honor kSecUseAuthenticationUIFail.
// Disable interaction process-wide before making any keychain query.
guard SecKeychainSetUserInteractionAllowed(false) == errSecSuccess else { exit(1) }
let context = LAContext()
context.interactionNotAllowed = true
let query: [String: Any] = [
  kSecClass as String: kSecClassGenericPassword,
  kSecAttrService as String: "Claude Code-credentials",
  kSecReturnData as String: true,
  kSecMatchLimit as String: kSecMatchLimitOne,
  kSecUseAuthenticationContext as String: context
]
var item: CFTypeRef?
let status = SecItemCopyMatching(query as CFDictionary, &item)
guard status == errSecSuccess, let data = item as? Data else { exit(1) }
FileHandle.standardOutput.write(data)
`;
export const BACKGROUND_POLICY = "macos-background-v1";
const quoted = (value: string) => JSON.stringify(value);
const within = (parent: string, child: string) => {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};

export function backgroundProfile(
  workspace: string,
  runtime: string,
  port: number,
  writable = true,
  providerState?: string,
): string {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid proxy port");
  return `(version 1)
(allow default)
; Deny GUI IPC by default, including WindowServer, Accessibility, LaunchServices,
; pasteboard, AppleEvents, launchd brokers and GUI-capable user MCP services.
(deny mach-lookup)
(allow mach-lookup (global-name "com.apple.system.logger") (global-name "com.apple.system.opendirectoryd.libinfo"))
(deny appleevent-send)
(deny iokit-open)
(deny mach-task-name mach-task-read)
(deny signal)
(allow signal (target same-sandbox))
(deny user-preference-write)
(deny network*)
(allow network-outbound (remote tcp "localhost:${port}"))
; Descendants may bind test servers, but cannot contact another local service.
(allow network-bind (local ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
(deny file-write*)
(allow file-write* (subpath ${quoted(runtime)})${writable ? ` (subpath ${quoted(workspace)})` : ""}${providerState ? ` (subpath ${quoted(providerState)})` : ""} (literal "/dev/null"))
(deny file-write* (subpath ${quoted(join(workspace, ".git", "hooks"))}) (subpath ${quoted(join(workspace, ".claude"))}) (subpath ${quoted(join(workspace, ".codex"))}))
`;
}

/** An OS boundary around the entire provider, not an agent instruction or PATH shim. */
export async function prepareBackground(
  workspacePath: string,
  provider: "codex" | "claude",
  writable = true,
  persistentState?: string,
) {
  if (process.platform !== "darwin") throw new Error("background-only requires macOS Seatbelt; no fallback");
  const workspace = await realpath(workspacePath);
  const userHome = process.env.HOME ?? process.env.USERPROFILE;
  if (!userHome) throw new Error("background-only requires an explicit HOME");
  const home = await realpath(userHome);
  if (
    writable &&
    (within(workspace, home) ||
      within(join(home, "Library"), workspace) ||
      [".codex", ".claude", ".taxi", ".config"].some((name) => within(join(home, name), workspace)))
  )
    throw new Error("background-only requires a project directory, not HOME or an application state directory");
  const runtime = await realpath(await mkdtemp(join(tmpdir(), "taxi-background-")));
  const network = await backgroundNetwork();
  const close = async () => {
    network.close();
    await rm(runtime, { recursive: true, force: true });
  };
  try {
    const providerHome = persistentState ? await realpath(persistentState) : join(runtime, provider);
    const temp = join(runtime, "tmp");
    if (!persistentState) await mkdir(providerHome, { mode: 0o700 });
    await mkdir(temp, { mode: 0o700 });
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      LANG: process.env.LANG,
      TMPDIR: temp,
      TMP: temp,
      TEMP: temp,
      HTTPS_PROXY: network.url,
      HTTP_PROXY: network.url,
      ALL_PROXY: network.url,
      https_proxy: network.url,
      http_proxy: network.url,
      all_proxy: network.url,
      NO_PROXY: "",
      no_proxy: "",
      // Rust TLS must not query Keychain/Trust UI through denied Mach services.
      SSL_CERT_FILE: "/etc/ssl/cert.pem",
      CLANG_MODULE_CACHE_PATH: join(temp, "clang"),
      SWIFT_MODULECACHE_PATH: join(temp, "swift"),
      XDG_CACHE_HOME: join(runtime, "cache"),
      npm_config_cache: join(runtime, "npm"),
      TAXI_EXECUTION_MODE: "background-only",
    };
    if (provider === "codex") {
      env.CODEX_HOME = providerHome;
      const source = join(process.env.CODEX_HOME ?? join(home, ".codex"), "auth.json");
      try {
        if (!persistentState) {
          await copyFile(source, join(providerHome, "auth.json"));
          await chmod(join(providerHome, "auth.json"), 0o600);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    } else {
      env.CLAUDE_CONFIG_DIR = providerHome;
      env.CLAUDE_CODE_DISABLE_AUTO_UPDATER = "1";
      env.DISABLE_AUTOUPDATER = "1";
      if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
      if (process.env.CLAUDE_CODE_OAUTH_TOKEN) env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      // Claude stores OAuth in Keychain on macOS. Copy only credentials into the
      // ephemeral provider home; never grant the child access to SecurityAgent UI.
      if (!env.ANTHROPIC_API_KEY && !env.CLAUDE_CODE_OAUTH_TOKEN) {
        try {
          await copyFile(
            join(process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"), ".credentials.json"),
            join(providerHome, ".credentials.json"),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          try {
            await stat(process.env.CLAUDE_CONFIG_DIR ?? join(home, ".claude"));
            const reader = join(runtime, "credentials.swift");
            await writeFile(reader, keychainReader, { mode: 0o600 });
            const { stdout } = await exec("/usr/bin/swift", ["-module-cache-path", join(temp, "swift"), reader], {
              timeout: 30000,
            });
            JSON.parse(stdout);
            await writeFile(join(providerHome, ".credentials.json"), stdout, { mode: 0o600 });
          } catch {
            /* CLI reports authentication failure; never open a login window. */
          }
        }
        await chmod(join(providerHome, ".credentials.json"), 0o600).catch(() => {});
      }
    }
    const profile = backgroundProfile(
      workspace,
      runtime,
      network.port,
      writable,
      persistentState ? providerHome : undefined,
    );
    await exec("/usr/bin/sandbox-exec", ["-p", profile, "/usr/bin/true"], { env, timeout: 5000 });
    return {
      executable: "/usr/bin/sandbox-exec",
      prefix: ["-p", profile],
      env,
      close,
      evidence: {
        policy: BACKGROUND_POLICY,
        enforcement: "seatbelt-process-tree",
        profileSha256: createHash("sha256").update(profile).digest("hex"),
        network: "public-https-proxy-only",
        preflight: "passed",
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
