<p align="center">
  <img src="icons/taxi-icon-256.png" alt="Taxi" width="128">
</p>

# Taxi

**A local workspace for coordinating AI sessions and tools.**

Keep a task's request, decisions, sessions and evidence together. Use the
**Task Dashboard** to prepare child-session handoffs, choose models by phase,
and review provider results. Connect Mac apps such as Notes, Mail, Calendar,
Reminders, Shortcuts, Finder and Safari through the same governed MCP runtime.

**Source preview — build from source.** This repository is the current entry
point. An npm package, Registry listing, downloadable MCPB release and signed
app installer are not yet published. Publishing the repository does not
publish any of those artifacts or deploy the documentation site.

## Currently implemented

- **Task Dashboard:** a direct menu entry for task phases, parent/child links,
  execution owners, results and unknown/failed/provider-completed states.
- **Session handoffs:** carry the original request, adopted decisions, open
  questions, completion criteria and evidence into a separate child session.
  Creation records survive restart; a model change can stay in the same session.
- **Phase model preferences:** apply explicit choices against the provider's
  model/effort catalog using the embedded QuotaPie core. Unsupported choices
  fail visibly; a selected model is not proof of the actual response model.
- **Mac tools:** connect MCP clients to Apple apps with task-scoped tool access,
  approval controls, audit evidence and an emergency stop.
- **External-session observation:** import a Modore metadata catalog, record
  explicit relationships and inspect the same task state through a read-only
  MCP tool. QuotaPie and Modore apps are not required to run Taxi.

The current dashboard executor runs **read-only Codex turns in a dedicated
profile**, one authorized turn at a time. Imported external sessions have no
resume authority. Provider turn completion does not verify the user's whole
goal. See [Task Dashboard](docs/harness.md) for setup and exact boundaries.

## Build from source

Requires macOS 14 or newer and Node.js 22 or newer. Building the native app or
optional Swift bridge also requires the Xcode command-line toolchain.

```bash
git clone https://github.com/heznpc/Taxi.git
cd Taxi
npm ci
npm run build
node dist/index.js setup --no-clients
```

For the native Task Dashboard, build and launch the local app:

```bash
npm run app:run
```

In Taxi's menu, explicitly start the local runtime and open **Task Dashboard**.
Follow the displayed dedicated-profile login instructions before authorizing
Codex execution. Provider requests can consume your account's usage. Local
builds are development artifacts; they do not establish a signed installer or
working AppIntents registration. To use Mac tools from an MCP client, configure
the source entry below after building. Avoid generated npm registrations until
the package is actually published.

## CLI

```text
taxi                         Show help
taxi setup                   Configure Taxi interactively
taxi run                     Run a standalone stdio MCP server
taxi run --http              Run a standalone Streamable HTTP server
taxi connect                 Bridge stdio to the running Taxi.app runtime
taxi clients                 Detect and configure MCP clients
taxi codex                   Inspect or change Codex registration
taxi doctor                  Diagnose installation and connectivity
taxi verify                  Verify audit-chain and runtime trust state
taxi modules                 Select bundled module packs
taxi workflows               Inspect curated workflows
```

## MCP client modes

For this source preview, direct mode launches your compiled local entry.
Replace the placeholder with the absolute path to your checkout:

```json
{
  "mcpServers": {
    "taxi": {
      "command": "node",
      "args": ["/absolute/path/to/Taxi/dist/index.js", "run"]
    }
  }
}
```

App-owned mode uses Taxi.app's bundled Node runtime and server entry when
available. Its stdio bridge connects to the authenticated local HTTP runtime;
Taxi verifies the owning app, runtime process, launch arguments, token, and
generation-bound response proofs before accepting it.

The CLI reference uses `taxi` as shorthand for `node dist/index.js` from the
checkout. Use `node dist/index.js clients --dry-run --json` to inspect generated
registrations; package-based entries target a future npm release. Configure the
local entry above for source use. Existing client files are backed up by explicit
configuration commands.

## Module packs

Local npm/MCPB builds include every standard JavaScript module.
Module packs are activation boundaries, not packages to install:

```bash
taxi modules list
taxi modules enable productivity,communications
taxi modules disable media
taxi modules doctor
```

Taxi 1.0 does not discover or install external module packages.

## Runtime Model

Taxi contains 32 modules. The complete generated catalog currently contains 298 tools.
The default `starter` profile exposes a compact front door; use
`taxi run --full` only when a client explicitly needs the complete bundled
surface.

The optional native Swift bridge is not shipped in the npm tarball. Build it
from source with `npm run swift-build`. Native app builds can embed the bridge;
the current MCPB builder does not include it. The generated native surface contains 234 App Intent action types,
86 Interactive Snippet views, and 15 AppEnum pickers.

## Safety Model

Default process limits are 60/min overall and 10 destructive/hr. OAuth JWT
verification accepts RS256 and ES256 only. The MCP server-card schema version
is `2025-11-25`.

## Trust and local state

Taxi uses its own configuration, state, cache, runtime token, owner secret,
audit key, and emergency-stop files. `taxi verify` distinguishes verified,
degraded, tampered, halted, approval, and operational states and preserves the
documented exit-code contract.

The default paths are:

```text
~/.config/taxi/config.json
~/.taxi/
~/.cache/taxi/
~/Library/Application Support/Taxi/
```

## Direction and boundaries

**Design intent:** one local environment for requesting, planning, researching,
implementing and reviewing work across sessions, models and tools. Task phases
are explicit user labels, not a claim that every phase can execute autonomously.
A resident manager model is not required.

**Planned:** broader authorized execution, resource lifecycle management,
supported external-session resume and a connected compression relay. None is
available merely by setting a preference or importing a catalog. The iOS/iPadOS
source is experimental; visionOS and watchOS remain roadmap targets.

**Non-goals for this preview:** inferring permissions from session metadata,
automatically replaying uncertain work, or treating a successful tool call as
proof that a user's goal is complete.

**Redacted — public data boundary:** repository examples are synthetic or redacted. Task
prompts, catalog metadata, session identifiers, credentials, private paths and
local verification evidence belong in private app state, not public issues or
commits. Review and redact diagnostics before sharing. Local storage does not
make authorized provider requests offline; those requests send the chosen
context to the provider.

## Development

```bash
npm ci
npm run build
npm test -- --runInBand
npm run swift-build
npm run build:mcpb
```

See `CONTRIBUTING.md` and `docs/testing.md` for development and test details.

For CLI development without foreground computer control, see
[background-only mode](docs/background-only.md). It applies an OS boundary to
Taxi-launched Codex and Claude processes and includes a live focus check.

## License and notices

Taxi is distributed under the MIT License. See `LICENSE` and
`THIRD_PARTY_NOTICES.md` for redistributed dependency notices. Source lineage
is recorded separately in `SOURCE_PROVENANCE.md`.
