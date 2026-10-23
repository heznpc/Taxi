# Review local Taxi from ChatGPT web

Taxi's repository review mode exposes one explicitly selected local Git
worktree over stdio MCP. Secure MCP Tunnel can carry that MCP connection to
ChatGPT without a public listener. The mode is part of the local Taxi package;
it does not proxy the full Apple-app runtime on port 3848.

## What the web chat can read

Start it with the **local build**, not an npm version that predates this change:

```sh
npm run build
node dist/index.js repo --root /absolute/path/to/Taxi
```

The process waits for an MCP client on stdin/stdout. It offers:

| Tools | Content |
| --- | --- |
| `repo_status` | Current local branch, full HEAD, dirty flag, observation time |
| `repo_tree` | Paginated committed source paths and blob IDs |
| `git_log` | Local commit IDs, dates and subjects |
| `git_diff` | Commit-to-commit or staged changes, with optional file selection |
| `read_file` | Committed text, line range, commit/blob/hash evidence |
| `search_code` | Literal search of committed text, with path prefix and limits |
| `runtime_status` | This repository-only process; does not claim tunnel or Taxi.app health |

Resources: `taxi://repo/status`, `taxi://repo/tree`, `taxi://repo/commit`,
`taxi://runtime/status`. Resources are conveniences; every operation is also
available as a tool so the caller need not support resource discovery.

Start with `repo_status`, then use its full HEAD as `ref` in subsequent calls.
This avoids a review silently switching source revisions when another task
commits. A dirty flag does **not** mean the returned file includes uncommitted
changes: this first mode reads commit objects and staged diffs. Unstaged,
untracked and ignored working files are not exported. No test/build execution,
write tools, generic `run_tool`, arbitrary shell, or Apple-app tools are loaded.

Regular source/text paths only are allowed. Symlinks, submodules, `.git`,
common credential filenames and binary files are excluded. Git helpers such as
external diff and text conversion are disabled. This filename policy is not a
secret scanner: an ordinary committed source file can still contain sensitive
text. Review what is committed before granting another client access. The
repo content is returned as untrusted data. Existing Taxi registry audit/rate
and emergency-stop boundaries are reused; no per-call human approval is needed
for this explicitly selected read-only surface. Stdio authorization is the
operator's launch decision; tunnel/workspace authorization is a separate layer.

Files are limited to 512 KiB, reads to 500 lines/60,000 characters, and Git
subprocesses to 10 seconds/2 MiB output. Large diffs require a narrower path.
Searches return at most five matches per file and disclose result limits.

## Official connection requirements (checked 2026-09-09 KST)

[Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels)
supports private stdio or HTTP MCP endpoints. It requires an existing tunnel ID,
a runtime API key, and Platform organization permissions. Read + Manage permits
tunnel configuration; Read + Use permits operation. The target ChatGPT workspace
must be associated with the tunnel. ChatGPT developer-mode access is separate.
Do not infer tunnel access from a ChatGPT subscription alone.

The linked [developer-mode article](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt-beta)
states Pro read/fetch support and Business/Enterprise/Edu full MCP support. The
actual account UI and permissions still need checking. This implementation only
uses reads. A private developer-mode app is not a public plugin submission.

## Prepare the tunnel

1. In [Platform tunnel settings](https://platform.openai.com/settings/organization/tunnels),
   create or select the tunnel for the intended Platform organization and
   ChatGPT workspace. Obtain a runtime key with the required tunnel access.
   Do not give a long-lived client an admin key or paste keys into a chat.
2. Download the appropriate macOS release from the official
   [latest tunnel-client release](https://github.com/openai/tunnel-client/releases/latest).
   Verify the archive against that release's `SHA256SUMS.txt`, then extract it
   under `.build/tunnel-client/` (including the accompanying runtime files).
   On this development machine v0.0.14 arm64 was downloaded, checksum-verified,
   and its `help quickstart` executed. This is a local ignored build artifact,
   not a dependency embedded into Taxi's distribution.
3. Prepare a local profile using the **real** tunnel ID:

   ```sh
   node scripts/prepare-repository-tunnel.mjs --tunnel-id tunnel_YOUR_ID \
     --api-key-file /absolute/owner-only/runtime-key-file
   ```

   The key file must be owned by the current user and not readable by group or
   others (0600). The helper stores only a `file:` reference. Without that option
   it uses `env:CONTROL_PLANE_API_KEY`. It pins the local Node executable, Taxi
   entry point and repository path; does not create a remote tunnel, start
   polling, or overwrite an existing profile. Config lives in the ignored
   `.build/repository-tunnel` directory.
4. Run the printed `doctor ... --explain` command, then the printed `run ...`
   command in a foreground terminal. Keep it running during ChatGPT discovery
   and calls. The health/admin listener is loopback-only on an ephemeral port.
   For persistent operation use the official `tunnel-client runtimes connect`
   supervisor, checking `runtimes status` for running/healthy/ready; do not
   assume a launch attempt is a successful connection.
5. In [ChatGPT Plugins](https://chatgpt.com/plugins), create a developer-mode
   app and choose **Tunnel** as its connection. Select the associated tunnel,
   scan its tools and verify that only the seven read-only tools above appear.
   Enabling developer mode or granting access may require account-owner action.
6. In a web chat, invoke Taxi and ask for `repo_status`, then `read_file` on
   `package.json` at the returned HEAD. Compare branch, full commit and file
   hash with the local wire probe. This is the end-to-end acceptance check.

## Local acceptance and remaining connection work

```sh
npm run build
node --experimental-vm-modules node_modules/.bin/jest tests/repository-store.test.js --runInBand
node scripts/verify-repository-bridge.mjs
```

The wire probe starts the real Taxi CLI and MCP SDK client, exercises all four
resources plus status, pinned reads/search/log/tree, and checks rejection of a
path escape and the absence of the generic tool dispatcher. Audit data goes to
an isolated temporary directory. Unit tests use real temporary Git repositories,
including committed credentials/symlinks, dirty working files, malformed refs,
staged changes and hostile external-diff/textconv/fsmonitor configuration.

A local MCP probe does not establish a ChatGPT web → Secure MCP Tunnel → Taxi
round trip. Verify the remote connection separately using the acceptance check
above. `runtime_status` reports local readiness and does not claim remote proof.
