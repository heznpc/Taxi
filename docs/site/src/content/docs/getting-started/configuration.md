---
title: Configuration
description: Configure Taxi modules, environment variables, and HTTP mode.
---

Taxi can be configured through a JSON config file, environment variables, or CLI flags. Environment variables always take precedence over config file values.

## Config File

The default config file location is `~/.config/taxi/config.json`. You can override this with the `TAXI_CONFIG_PATH` environment variable.

```json
{
  "profile": "starter",
  "toolExposure": "progressive",
  "modulePacks": ["core", "productivity"],
  "requireToolSession": true,
  "includeShared": false,
  "allowSendMessages": false,
  "allowSendMail": false,
  "disabledModules": ["tv", "podcasts"],
  "shareApproval": ["notes", "calendar"],
  "hitl": {
    "level": "sensitive-only",
    "whitelist": ["list_notes", "search_notes"],
    "timeout": 120
  },
  "performance": {
    "embeddingProvider": "swift",
    "jxaConcurrency": 3,
    "circuitBreakerThreshold": 3,
    "circuitBreakerOpenMs": 60000
  }
}
```

### Config Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `profile` | string | `"starter"` | Runtime profile: `starter`, `communications-safe`, `productivity`, or `full` |
| `toolExposure` | string | profile-dependent | `progressive`, `profile`, or `full` tools/list exposure |
| `modulePacks` | string[] | all packs | DLC-like activation packs. `core` is always kept |
| `requireToolSession` | boolean | `false` unless app/CLI config sets it | Require task-scoped sessions before hidden `run_tool` dispatch |
| `includeShared` | boolean | `false` | Include shared notes/folders in results |
| `allowSendMessages` | boolean | `false` | Allow sending iMessages via the Messages module |
| `allowSendMail` | boolean | `false` | Allow sending emails via the Mail module |
| `disabledModules` | string[] | `[]` | List of module names to disable |
| `shareApproval` | string[] | `[]` | Modules that require share approval before accessing |
| `hitl.level` | string | `"sensitive-only"` | Human-in-the-loop level: `off`, `destructive-only`, `sensitive-only`, `all-writes`, `all` |
| `hitl.whitelist` | string[] | `[]` | Tool names that bypass HITL confirmation |
| `hitl.timeout` | number | `120` | Seconds to wait for HITL confirmation |
| `performance.embeddingProvider` | string | `"auto"` | Embedding provider: `gemini`, `swift`, `hybrid`, `none` |
| `performance.jxaConcurrency` | number | `3` | Max parallel JXA/osascript processes |
| `performance.circuitBreakerThreshold` | number | `3` | Failures before circuit breaker opens |
| `performance.circuitBreakerOpenMs` | number | `60000` | Circuit breaker open duration in ms |

## Environment Variables

### Module Control

| Variable | Description |
|----------|-------------|
| `TAXI_FULL=true` | Enable all standard 32 modules (profile-only modules stay opt-in) |
| `TAXI_PROFILE=starter` | Select a module profile: `starter`, `communications-safe`, `productivity`, `full`, or `custom` |
| `TAXI_TOOL_EXPOSURE=progressive` | Keep `tools/list` thin; use `profile` or `full` to expose more tools |
| `TAXI_MODULE_PACKS=core,productivity` | Activate selected DLC-like module packs |
| `TAXI_REQUIRE_TOOL_SESSION=true` | Require task-scoped sessions before hidden `run_tool` dispatch |
| `TAXI_HARNESS_ADAPTER=strict` | Select a task harness policy explicitly |
| `TAXI_PROFILE=spatial_prep` | Enable an experimental profile-only module in addition to the selected profile |
| `TAXI_ENABLE_SPATIAL_PREP=true` | Enable the experimental read-only spatial asset prep tools |
| `TAXI_DISABLE_<MODULE>=true` | Disable a specific module (e.g. `TAXI_DISABLE_TV=true`) |
| `TAXI_CONFIG_PATH` | Override config file path (default: `~/.config/taxi/config.json`) |

### Safety Controls

| Variable | Description |
|----------|-------------|
| `TAXI_ALLOW_SEND_MESSAGES=true` | Allow sending iMessages |
| `TAXI_ALLOW_SEND_MAIL=true` | Allow sending emails |
| `TAXI_INCLUDE_SHARED=true` | Include shared Notes/folders |
| `TAXI_SHARE_APPROVAL=notes,calendar` | Comma-separated list of modules requiring share approval |
| `TAXI_HITL_LEVEL=sensitive-only` | Human-in-the-loop confirmation level |

### HTTP Mode

| Variable | Description |
|----------|-------------|
| `TAXI_HTTP_TOKEN` | Bearer token for HTTP mode authentication. **Required** when using `--bind-all` |
| `TAXI_HTTP_PORT` | HTTP server port (default: `3848`) |
| `TAXI_MAX_SESSIONS` | Max concurrent HTTP sessions (default: `50`) |
| `TAXI_SESSION_IDLE_TTL` | Session idle timeout in ms (default: `300000` / 5 minutes) |
| `TAXI_ALLOW_NETWORK` | Inbound HTTP exposure policy: `loopback-only` (default) / `with-token` / `with-token+origin` / `with-oauth` / `with-oauth+origin` / `unauthenticated`. This is not an outbound egress allow-list. Startup refuses to bind inconsistent combinations. See RFC 0002. |
| `TAXI_ALLOWED_ORIGINS` | Comma-separated Origin allow-list (e.g. `https://claude.ai,https://cursor.sh`). Required for `with-token+origin`. |

### Browser-based MCP clients (Claude in Chrome, etc.)

Extensions cannot spawn stdio subprocesses, so they consume Taxi over HTTP:

```bash
export TAXI_HTTP_TOKEN=$(openssl rand -hex 32)
export TAXI_ALLOWED_ORIGINS="https://claude.ai"
export TAXI_ALLOW_NETWORK="with-token+origin"
taxi run --http --bind-all --port 3848
```

In the extension: server URL `http://<host>:3848/mcp`, header `Authorization: Bearer $TAXI_HTTP_TOKEN`. `GET /.well-known/mcp.json` returns the server card with the resolved `network_policy`. Kill switch: `touch ~/.taxi/emergency-stop` on the server.

### Performance Tuning

| Variable | Description |
|----------|-------------|
| `TAXI_JXA_CONCURRENCY` | Max parallel JXA processes (default: `3`) |
| `TAXI_TIMEOUT_JXA` | JXA script timeout in ms (default: `30000`) |
| `TAXI_TIMEOUT_SWIFT` | Swift bridge timeout in ms (default: `60000`) |
| `TAXI_BUFFER_JXA` | JXA stdout buffer size in bytes (default: `10485760` / 10 MB) |
| `TAXI_BUFFER_SWIFT` | Swift bridge stdout buffer in bytes (default: `10485760` / 10 MB) |
| `TAXI_CB_THRESHOLD` | Circuit breaker failure threshold (default: `3`) |
| `TAXI_CB_OPEN_MS` | Circuit breaker open duration in ms (default: `60000`) |

### Embeddings

| Variable | Description |
|----------|-------------|
| `GEMINI_API_KEY` | Gemini API key for cloud-based embeddings |
| `TAXI_EMBEDDING_PROVIDER` | Provider selection: `auto`, `gemini`, `swift`, `hybrid`, `none` |
| `TAXI_EMBEDDING_MODEL` | Gemini model name (default: `gemini-embedding-2`) |
| `TAXI_EMBEDDING_DIM` | Embedding dimension (default: `256`) |

## CLI Flags

```bash
taxi                    # Show help
taxi run                # Start in stdio mode
taxi run --http         # Start as HTTP server
taxi run --http --port 8080 # Custom port
taxi run --http --bind-all  # Bind to 0.0.0.0 (all interfaces)
taxi run --full         # Request every bundled module
taxi connect            # Proxy stdio clients to Taxi.app
taxi setup                   # Interactive setup wizard
taxi modules            # Inspect or edit bundled module activation
taxi doctor             # Diagnose installation
taxi --help             # Show usage guide
```

## HTTP Mode Details

When running in HTTP mode (`taxi run --http`), Taxi uses the MCP Streamable HTTP transport:

- **Endpoint**: `POST /mcp` for all MCP requests
- **Health check**: `GET /health` returns server status, version, and session count
- **Discovery**: `GET /.well-known/mcp.json` returns the MCP Server Card
- **SSE streaming**: `GET /mcp` with `mcp-session-id` header for server-sent events
- **Session close**: `DELETE /mcp` with `mcp-session-id` header

### Authentication

When `TAXI_HTTP_TOKEN` is set, all requests (except `/health` and `/.well-known/mcp.json`) must include a `Bearer` token in the `Authorization` header:

```bash
export TAXI_HTTP_TOKEN="my-secret-token"
taxi run --http --bind-all
```

Clients connect with:

```
Authorization: Bearer my-secret-token
```

Using `--bind-all` without `TAXI_HTTP_TOKEN` is rejected at startup. Use `TAXI_ALLOW_NETWORK=with-token` with a token for trusted network exposure, or `with-token+origin` / `with-oauth+origin` for browser-facing clients.

## Starter Modules

When no `config.json` exists and `--full` is not used, Taxi enables the curated `starter` profile and progressive tool exposure:

- **Notes** -- read, create, update, delete notes and folders
- **Reminders** -- manage tasks and reminder lists
- **Calendar** -- view and create events
- **Shortcuts** -- list and run Siri Shortcuts
- **System** -- clipboard, volume, brightness, app control
- **Finder** -- file search, directory listing, file operations
- **Weather** -- current conditions and forecasts

All other standard modules are disabled by default. Use `taxi setup`, `taxi modules enable productivity`, `TAXI_PROFILE=communications-safe|productivity|full|custom`, or `--full` to customize. `custom` means the `disabledModules` list is the source of truth. Use `TAXI_TOOL_EXPOSURE=profile|full` when a client should see more than the progressive front door.

Experimental profile-only modules, such as `spatial_prep`, stay disabled even with `--full`. Enable them explicitly with `TAXI_PROFILE=spatial_prep` or `TAXI_ENABLE_SPATIAL_PREP=true`.
