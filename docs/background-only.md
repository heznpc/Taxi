# Background-only development on macOS

`taxi work run request.json` can start a fresh Codex or Claude CLI process with
`mode: "background-only"`. The model and reasoning effort must be explicit.
Taxi does not change the model when authentication or provider support fails.

```json
{
  "provider": "codex",
  "workspace": "/absolute/path/to/project",
  "mode": "background-only",
  "model": "gpt-6.1-sol",
  "effort": "xhigh",
  "timeoutMs": 600000,
  "prompt": "Implement the requested change and run the project tests."
}
```

For Claude, use `provider: "claude"` and an explicit model and effort supported
by that account. The original `capture` mode remains read-only/plan-oriented;
it does not provide this OS boundary. Taxi's native harness Codex app-server
also receives the boundary, while retaining its existing read-only scope.
Already-running Codex/Claude desktop chats are outside this process tree and
cannot acquire the restriction retroactively.

## Enforcement

Before starting the provider, Taxi creates and checks a macOS Seatbelt profile.
The provider and its descendants inherit that kernel policy, including direct
shell commands and absolute binary paths. No profile means no provider launch.
There is no foreground fallback.

- WindowServer, Accessibility, LaunchServices, pasteboard, AppleEvents and I/O
  Kit connections are denied. Launching `osascript`, `open`, or another executable
  cannot remove the inherited policy.
- Project files and disposable build/cache directories are writable. HOME,
  application state, repository hooks, and provider configuration are not
  writable project targets. The native harness permits writes only to its
  dedicated provider state and disposable runtime, not its workspace.
- External traffic goes through a parent-owned public HTTPS CONNECT proxy.
  Direct networking, Unix sockets, local CDP/MCP/SSH services and private-address
  proxy destinations are denied. The proxy resolves and checks an address once
  and connects to that address. IPv6 and non-443 destinations are denied in v1.
- User MCP servers, hooks, Chrome integration and inherited provider settings
  are disabled. Codex's inner `danger-full-access` setting allows CLI development
  within the **outer** Seatbelt boundary; it does not remove that boundary.
- Provider credentials are copied into disposable state without logging them.
  Claude's Keychain reader disables interaction for both legacy and modern
  macOS Keychain APIs; missing authorization fails without opening login UI.
  Explicit API/OAuth environment credentials are supported. Runtime credentials
  are deleted and the network proxy closes when execution ends.

This mode supports file editing, CLI builds and terminal tests. GUI tests,
simulators, screen control, host-connected browsers, localhost clients, and
dependencies requiring private networks are blocked. Use a separate checkout
without unsandboxed host watchers that execute code on file changes. This is a
local process boundary, not a VM or protection against an independently running
remote service controlling this Mac.

## Validation

Build first, then run the automated boundary tests:

```sh
npm run build
node --experimental-vm-modules node_modules/.bin/jest tests/background-isolation.test.js --runInBand
```

An explicit live check consumes a provider invocation, creates an isolated
temporary project with failing tests, asks the real provider to implement it,
and independently runs the tests afterward:

```sh
node scripts/verify-background-live.mjs codex gpt-6.1-sol xhigh /absolute/evidence-directory
node scripts/verify-background-live.mjs claude YOUR_MODEL high /absolute/evidence-directory
```

The check records application activation events without recording keyboard text
or screen contents. It fails if the provider fails, tests fail, the monitor does
not finish, an app activation occurs, or the foreground PID changes. A user app
switch also makes this conservative check fail; the monitor does not attribute
switches to the user or the agent and does not measure focus between windows of
the same app. Keep working in the foreground app during a validation run.

Use a provider CLI version compatible with the explicitly selected model and
reasoning effort. Authentication or unsupported-model errors remain failed
provider runs; Taxi does not convert them to a successful development claim or
silently substitute a different model.
