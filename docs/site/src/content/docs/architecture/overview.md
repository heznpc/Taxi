---
title: Architecture Overview
description: High-level architecture of Taxi — Node.js MCP server, JXA bridge, Swift bridge, and TaxiKit.
---

Taxi is a Node.js application that implements the [Model Context Protocol](https://modelcontextprotocol.io/) (MCP) to bridge AI assistants to the Apple ecosystem. It uses multiple execution strategies depending on the target application and the required capability.

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────┐
│  MCP Client (Claude Desktop, Cursor, Windsurf, etc.)     │
│  ┌────────────────────────────────────────────────────┐   │
│  │  LLM (Claude, GPT, Gemini, etc.)                  │   │
│  └──────────────────┬─────────────────────────────────┘   │
└─────────────────────┼────────────────────────────────────┘
                      │  MCP Protocol (stdio or HTTP)
┌─────────────────────▼────────────────────────────────────┐
│  Taxi Server (Node.js)                                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌─────────────┐ │
│  │  Notes   │ │ Calendar │ │  System  │ │  32 modules  │ │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘ └──────┬──────┘ │
│       │             │            │               │        │
│  ┌────▼─────────────▼────────────▼───────────────▼────┐  │
│  │              Tool Registry & Config                 │  │
│  └────┬──────────────┬───────────────────┬────────────┘  │
└───────┼──────────────┼───────────────────┼───────────────┘
        │              │                   │
   ┌────▼────┐   ┌─────▼──────┐    ┌──────▼───────┐
   │  JXA    │   │   Swift    │    │   HTTP APIs  │
   │ Scripts │   │   Bridge   │    │  (Weather,   │
   │(osascr) │   │(TaxiBr.) │    │  Geocoding)  │
   └────┬────┘   └─────┬──────┘    └──────────────┘
        │              │
   ┌────▼────┐   ┌─────▼──────┐
   │  macOS  │   │   Apple    │
   │  Apps   │   │ Frameworks │
   │(Notes,  │   │(NaturalLang│
   │Calendar,│   │ Spotlight, │
   │ Music)  │   │ CoreML)    │
   └─────────┘   └────────────┘
```

## Execution Layers

### 1. JXA (JavaScript for Automation)

The primary interface to macOS applications. Taxi generates JXA scripts and executes them via `osascript -l JavaScript`. This is how modules like Notes, Reminders, Calendar, Contacts, Mail, Messages, Music, Safari, Photos, Finder, and System interact with their respective apps.

Key characteristics:
- Each tool call spawns an `osascript` child process
- Concurrency is limited by `TAXI_JXA_CONCURRENCY` (default: 3 parallel processes)
- A semaphore prevents overloading the system
- A circuit breaker protects against cascading failures when an app is unresponsive
- Timeout is configurable via `TAXI_TIMEOUT_JXA` (default: 30 seconds)
- Scripts are defined in each module's `scripts.ts` file as template-literal functions

### 2. Swift Bridge (`TaxiBridge`)

A compiled Swift binary that provides access to Apple frameworks not available through JXA:

- **NaturalLanguage.framework** -- on-device text embeddings for semantic search
- **Spotlight / CoreSpotlight** -- system-wide search
- **ImageCreator** -- Apple Intelligence image generation (macOS 26+)
- **Writing Tools** -- Apple Intelligence text transformation (macOS 26+)

The bridge communicates via JSON over stdin/stdout. The Node.js server spawns it as a child process and sends JSON-RPC-style commands.

Build the Swift bridge:
```bash
cd swift && swift build -c release
```

The binary is output to `swift/.build/release/TaxiBridge`.

### 3. HTTP APIs

Some modules use external HTTP APIs instead of local automation:

- **Weather** -- [Open-Meteo API](https://open-meteo.com/) for forecasts and current conditions
- **Maps (geocoding)** -- Open-Meteo Geocoding API and Nominatim for reverse geocoding
- **Semantic (Gemini)** -- Google Gemini API for cloud-based text embeddings (optional)

### 4. TaxiKit (iOS, planned)

A Swift Package for iOS expansion. TaxiKit will provide a shared framework for:
- App Intents integration
- HealthKit data access
- On-device MCP server for iOS apps

This is under development in the `ios/` directory.

## Server Architecture

### Transport

Taxi supports two MCP transports:

- **Streamable HTTP** (`--http` flag) -- Express-based HTTP server with session management. This is the recommended Taxi.app-owned local runtime on `127.0.0.1:3848`.
- **Stdio** -- `taxi run` communicates directly via stdin/stdout. Stdio-only clients use `npx -y @heznpc/taxi@1.0.0 connect --url http://127.0.0.1:3848/mcp` to proxy into the app-owned runtime. Current client setup stores the owner-only persistent `TAXI_HTTP_TOKEN` for configuration detection and repair, but the canonical proxy verifies the signed bundle and live app/Node processes, replaces that credential with a process-generation bearer, and requires a fresh nonce-bound MAC on every MCP response. The local credential boundary is the current Unix account, not a hostile same-UID process.

### Module System

Modules are defined in `src/shared/modules.ts` via a simple manifest:

```typescript
const MANIFEST = [
  { name: "notes", hasPrompts: true },
  { name: "reminders", hasPrompts: true },
  { name: "calendar", hasPrompts: true },
  // ... 22 more modules
];
```

Each module has:
- `src/<name>/tools.ts` -- exports a `registerXxxTools(server, config)` function
- `src/<name>/scripts.ts` -- JXA script generators (template-literal functions)
- `src/<name>/prompts.ts` (optional) -- MCP prompt templates

Modules are loaded dynamically at startup. The `loadModuleRegistry()` function applies debug/config filtering before import, then imports each selected module and finds its register function by convention (any exported function starting with `register`).

### Config Resolution

Configuration follows a clear precedence:

1. **Environment variables** (highest priority)
2. **CLI flags** (`--full`, `--http`, `--bind-all`)
3. **Config file** (`~/.config/taxi/config.json`)
4. **Defaults** (starter module preset)

### Concurrency Control

Taxi uses several mechanisms to manage concurrent operations:

- **Semaphore** -- limits parallel JXA processes to prevent macOS overload
- **Circuit breaker** -- per-app fault isolation. After N consecutive failures, the breaker opens and rejects calls for a cooldown period
- **Session management** -- HTTP mode limits concurrent sessions and cleans up idle ones

### Result Pattern

All tool handlers return results using a `Result` type:

```typescript
ok(data)   // { content: [{ type: "text", text: JSON.stringify(data) }] }
err(msg)   // { content: [{ type: "text", text: msg }], isError: true }
```

This ensures consistent error handling across all 298 tools.

## Directory Structure

```
taxi/
├── src/
│   ├── index.ts              # Entry point, server setup, transport
│   ├── shared/
│   │   ├── config.ts          # Config parsing, env vars
│   │   ├── constants.ts       # All magic numbers, timeouts, URLs
│   │   ├── modules.ts         # Module manifest and dynamic loader
│   │   ├── jxa.ts             # JXA execution engine (semaphore, circuit breaker)
│   │   ├── swift.ts           # Swift bridge process management
│   │   ├── result.ts          # ok/err result helpers
│   │   ├── resources.ts       # MCP resource registration
│   │   ├── hitl.ts            # Human-in-the-loop confirmation
│   │   └── banner.ts          # Startup banner display
│   ├── notes/
│   │   ├── tools.ts           # Tool registration (12 tools)
│   │   ├── scripts.ts         # JXA script generators
│   │   └── prompts.ts         # Prompt templates
│   ├── calendar/              # Same pattern as notes/
│   ├── reminders/
│   ├── ...                    # 22 more module directories
│   ├── cross/                 # Cross-module tools and prompts
│   ├── semantic/              # Vector store and semantic search
│   ├── skills/                # Personal Skills Engine (YAML workflows)
│   └── apps/                  # MCP Apps (interactive UI views)
├── swift/                     # Swift bridge source (TaxiBridge)
├── ios/                       # TaxiKit (iOS expansion, in progress)
├── tests/                     # Jest unit tests
├── scripts/                   # QA test runners, stats, i18n checks
├── docs/                      # Documentation
└── dist/                      # Compiled output (tsc)
```
