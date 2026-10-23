---
title: Build from source
description: Build the Taxi macOS source preview and connect its local runtime to an MCP client.
---

## Distribution status

Taxi is a **source preview**. An npm package, Registry listing, downloadable MCPB release and signed app installer are not yet published. Package and installer metadata in the repository prepare future distributions; they are not evidence that a download exists.

## Requirements

- macOS 14 or newer
- Node.js 22 or newer
- Xcode command-line toolchain for the native app or optional Swift bridge
- Codex CLI and a separately authenticated Taxi profile for dashboard execution

## Build the runtime

```bash
git clone https://github.com/heznpc/Taxi.git
cd Taxi
npm ci
npm run build
node dist/index.js setup --no-clients
node dist/index.js doctor
```

`--no-clients` configures Taxi without writing package-based entries to your clients. The CLI references use `taxi` as shorthand for `node dist/index.js` from the checkout.

## Open Task Dashboard

```bash
npm run app:run
```

In the Taxi menu, explicitly start the local runtime and open **Task Dashboard**. Follow the dedicated-profile login command shown there before authorizing a Codex turn. Dashboard execution currently runs read-only, one authorized turn at a time. Provider requests can consume your account's usage.

This creates a development app. It does not establish a signed installer or working AppIntents registration. See the [Task Dashboard guide](https://github.com/heznpc/Taxi/blob/main/docs/harness.md) for model selection, handoffs, local state and execution boundaries.

## Connect an MCP client

After building, replace the placeholder with the absolute path to your checkout:

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

Use your client's MCP configuration interface, then restart or reconnect that client. The client launches the local runtime over stdio. macOS may request Automation or data-access permissions when you first invoke the relevant tools.

The current `clients` command can generate package-based entries intended for a future npm release. Inspect them with `node dist/index.js clients --dry-run --json`; use the explicit local entry above for this preview.

## Optional local builds

```bash
npm run swift-build
npm run build:mcpb
```

The Swift bridge enables supported native framework tools. The MCPB builder packages the MCP server for local Claude Desktop testing; it does not include Task Dashboard or the Swift bridge. Read the [MCPB build guide](https://github.com/heznpc/Taxi/blob/main/docs/mcpb.md) before installing a local bundle.

Building or checking an artifact does not publish it. Signed distribution, npm publication, Registry submission and documentation deployment require separate release steps.
