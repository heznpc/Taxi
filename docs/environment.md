# Taxi Environment Variables

All Taxi environment variables share the `TAXI_` prefix. The vast majority are **optional**; the common case is to set none of them and rely on defaults. This page indexes every knob with its default + common use case so operators don't have to grep the source.

If a variable accepts a path, `~` expands to `$HOME`. Booleans are `"true"` / `"false"` strings, never `0`/`1`.

---

## Quickstart

| You want… | Set |
|---|---|
| Bind HTTP server to all interfaces with token auth | `TAXI_ALLOW_NETWORK=with-token` + `TAXI_HTTP_TOKEN=…` |
| Bind HTTP server with OAuth 2.1 | `TAXI_ALLOW_NETWORK=with-oauth` + `TAXI_OAUTH_ISSUER=…` + `TAXI_OAUTH_AUDIENCE=…` |
| Disable a flaky module without removing config | `TAXI_DEBUG_MODULES=notes,calendar` (whitelist) |
| Use only selected module packs | `TAXI_MODULE_PACKS=core,productivity` |
| Send all 298 tools without compactDescription | `TAXI_COMPACT_TOOLS=false` + `TAXI_TOOL_EXPOSURE=full` |
| Require sessions before hidden tools can run | `TAXI_REQUIRE_TOOL_SESSION=true` |
| Inspect or edit bundled module packs | `taxi modules` |
| Increase audit-log signing strength for cross-host integrity | `TAXI_AUDIT_HMAC_KEY=<32+ random bytes>` |
| Block every destructive tool on a panic | `touch ~/.taxi/emergency-stop` |

---

## Network & Auth (RFC 0002 / 0005)

| Variable | Default | Notes |
|---|---|---|
| `TAXI_ALLOW_NETWORK` | `loopback-only` | Inbound HTTP exposure policy. One of `loopback-only` / `with-token` / `with-token+origin` / `with-oauth` / `with-oauth+origin` / `unauthenticated`. Startup invariant refuses to boot a misconfigured server. Not an outbound egress allow-list. |
| `TAXI_ALLOWED_ORIGINS`                   | (empty)                                       | Comma-separated browser-origin allow-list. Browser requests are denied by default in `loopback-only`; list each trusted local web origin explicitly. Required when `ALLOW_NETWORK` ends in `+origin`. Native MCP clients without an `Origin` header remain allowed unless `TAXI_DENY_NO_ORIGIN=1`. HTTP(S) values must be origin-only. Chrome extensions use the exact canonical form `chrome-extension://<32 lowercase a-p characters>`; paths, ports, queries, fragments, uppercase IDs, and `https://chrome-extension://…` are rejected. |
| `TAXI_DENY_NO_ORIGIN` | (off) | `1` / `true` rejects MCP and discovery requests that omit the `Origin` header. Leave this off for native clients such as Codex, Claude Desktop, and `curl`; their active loopback/Bearer/OAuth policy remains the authentication boundary. |
| `TAXI_HTTP_TOKEN` | (empty) | Bearer token. Required when `ALLOW_NETWORK=with-token*`. |
| `TAXI_HTTP_PORT` | `3848` | TCP port for the HTTP transport. |
| `TAXI_OAUTH_ISSUER`                      | (empty)                                       | Exact HTTPS issuer URL of the authorization server (path-bearing issuers are supported). Required when `ALLOW_NETWORK=with-oauth*`. Taxi discovers `jwks_uri` from RFC 8414 metadata, with the Keycloak-compatible OIDC discovery document as a 404 fallback. The returned `issuer` must byte-match this value.                                                                                                         |
| `TAXI_OAUTH_AUDIENCE` | (empty) | RFC 8707 resource indicator (the `aud` claim a valid token must carry). Required when `ALLOW_NETWORK=with-oauth*`. |
| `TAXI_OAUTH_AUTHORIZATION_ENDPOINT` | (empty) | Optional RFC 8414 authorization endpoint. Must be set together with `TAXI_OAUTH_TOKEN_ENDPOINT`; partial configuration fails closed. When both are present, Taxi publishes issuer-path-aware authorization-server metadata. |
| `TAXI_OAUTH_TOKEN_ENDPOINT` | (empty) | Optional RFC 8414 token endpoint. Must be set together with `TAXI_OAUTH_AUTHORIZATION_ENDPOINT`. Taxi publishes metadata only; it does not implement an authorization server. |
| `TAXI_OAUTH_TOKEN_ENDPOINT_AUTH_METHODS` | (required with RFC 8414 endpoint publication) | Comma-separated methods truthfully supported by the external authorization server: `none`, `client_secret_basic`, `client_secret_post`, `client_secret_jwt`, `private_key_jwt`, `tls_client_auth`, or `self_signed_tls_client_auth`. Public PKCE deployments explicitly set `none`; confidential-client deployments set their actual method(s). Missing or invalid values fail startup instead of guessing AS capability. |
| `TAXI_OAUTH_JWKS_URI`                    | (discovered)                                  | Optional explicit HTTPS `jwks_uri` override. Normally omit it and let Taxi use issuer metadata. Userinfo and fragments are rejected; network or metadata/JWKS parse failure fails closed.                                                                                                                                                                                                                               |
| `TAXI_OAUTH_RESOURCE_DOCS` | (empty) | Optional URL. Surfaces in `/.well-known/oauth-protected-resource` per RFC 9728. |
| `TAXI_OAUTH_RESOURCE_POLICY` | (empty) | Optional privacy-policy URL for the same discovery card. |
| `TAXI_OAUTH_RESOURCE_TOS` | (empty) | Optional ToS URL for the same discovery card. |
| `TAXI_MAX_SESSIONS` | `50` | Max concurrent HTTP sessions. |
| `TAXI_SESSION_IDLE_TTL` | `300000` (5 min) | Idle-session evict timeout in ms. |

---

## Rate limit (PR #159 / #162)

| Variable | Default | Notes |
|---|---|---|
| `TAXI_RATE_LIMIT`                   | (enabled)                         | `false` disables the tool-call and HTTP IP buckets. The emergency-stop file remains an independent destructive-call panic control. |
| `TAXI_MAX_TOOL_CALLS_PER_MINUTE` | `60` | Per-tenant global bucket. |
| `TAXI_MAX_DESTRUCTIVE_PER_HOUR` | `10` | Per-tenant destructive bucket. |
| `TAXI_RATE_LIMIT_TENANT_CAP` | `256` | Max distinct OAuth `sub` values tracked. LRU-evicted past the cap. |
| `TAXI_HTTP_MAX_REQUESTS_PER_MINUTE` | `120` | HTTP per-IP cap. |
| `TAXI_HTTP_RATE_IP_CAP` | `10000` | Max distinct IPs tracked. FIFO-evicted past the cap. |
| `TAXI_EMERGENCY_STOP_PATH` | `~/.taxi/emergency-stop` | Touch this file to block every destructive tool until the file is removed. 1s probe cache; no restart needed. |

---

## Audit log (PR #152)

| Variable | Default | Notes |
|---|---|---|
| `TAXI_AUDIT_LOG` | (enabled) | `false` skips general audit emission. A positive HITL decision cannot bypass the durable barrier: approval-gated mutations fail closed while audit is disabled. |
| `TAXI_AUDIT_FLUSH_INTERVAL` | `30000` (30s) | ms between buffer flushes. |
| `TAXI_AUDIT_MAX_BUFFER_BYTES` | `8388608` (8 MiB) | Hard cap for the in-memory audit spool during persistence failures. Crossing it permanently fails audit authority closed for that process; repair storage and restart before governed writes can resume. |
| `TAXI_AUDIT_HMAC_KEY` | host-derived | Operator-provided key enables cross-host integrity verification (move `audit.jsonl` to a different machine + verify with the same key). The host-derived fallback is tamper-detection grade only. |

The HMAC chain authenticates audit contents, not external freshness. The running process remembers the highest checkpoint it has observed and rejects an older pair or complete deletion during that lifetime. After restart, restoring both the log and its matching older checkpoint—or deleting both—cannot be detected without an external monotonic anchor. `TAXI_AUDIT_HMAC_KEY` strengthens authenticity but does not change that rollback boundary.

Each signed JSONL row is verified against the exact raw JSON body bytes emitted by Taxi, before the trailing `_prev` / `_hmac` envelope. Verification does not parse and re-serialize the body, so duplicate-key, alternate-escape, or whitespace edits break the chain even when they decode to the same JavaScript object. Signed rows written before `seq` was introduced use the same envelope and remain verifiable.

Every new HITL decision also carries a cryptographically random `approvalId`. A correlation ID groups calls into one governed workflow, while `approvalId` is the per-call identity the mutation barrier must find in the verified chain; an older approval from the same workflow, tool, timestamp, and channel cannot authorize a later call. Older approval rows without this additive field remain readable but are never used as evidence for a newly approved mutation.

On the first signed write after an upgrade, parseable unsigned legacy rows are moved to owner-only `audit.legacy-untrusted.*` quarantine files. They remain available for manual local inspection but are excluded from active HMAC verification, `audit_log`, and trusted summaries. Any existing signed suffix is preserved byte-for-byte and re-verified before the new write is sealed.

---

## HITL / Elicitation (RFC 0008)

| Variable | Default | Notes |
|---|---|---|
| `TAXI_HITL_LEVEL` | `sensitive-only` | One of `off` / `destructive-only` / `sensitive-only` / `all-writes` / `all`. Picks which tools require approval. |
| `TAXI_ELICITATION_DISABLE` | (off) | `true` skips MCP elicitation prompts and falls through to socket HITL. Useful for fully-scripted destructive pipelines. |
| `TAXI_MANAGED_CLIENTS` | (empty) | Comma-separated client names. Suppresses elicitation when these clients connect (they have their own approval UI). All Claude products are auto-detected via the `claude` prefix. |
| `TAXI_SHARE_APPROVAL` | (off) | Per-tool share-guard approval flag. |
| `TAXI_ALLOW_SEND_MAIL` | (off) | Gates `send_mail`. |
| `TAXI_ALLOW_SEND_MESSAGES` | (off) | Gates `send_message`. |
| `TAXI_ALLOW_RUN_JAVASCRIPT` | (off) | Gates the JXA `eval` surface. |

MCP `resources/*` methods require `mcp:read` under OAuth. Live callbacks registered through `registerResource` also cross the core per-tenant rate limit and HMAC outcome audit boundary under the namespaced activity `resource:<name>`. Built-in Apple-data resources are classified sensitive, including `system://clipboard` and `context://snapshot*`; with the default `sensitive-only` HITL policy, each read needs its own approval. The exact `approvalId` is persisted and verified before resource contents are fetched. Resource governance classification is held server-side and is not exposed through `resources/list` metadata.

---

## Module control

| Variable | Default | Notes |
|---|---|---|
| `TAXI_FULL` | (off) | `true` requests every standard module ignoring the config's `disabledModules`. npm and MCPB artifacts include all standard JavaScript module entrypoints, so no companion package is required for this mode. Profile-only modules stay opt-in. |
| `TAXI_PROFILE` | `starter` | Runtime profile: `starter`, `communications-safe`, `productivity`, `full`, or `custom`. `custom` preserves the config's `disabledModules` surface. May also include opt-in modules such as `spatial_prep`. |
| `TAXI_TOOL_EXPOSURE` | profile-dependent | `progressive` exposes the front door, `profile` exposes the selected profile, `full` exposes every loaded tool. |
| `TAXI_MODULE_PACKS` | all packs | Comma-separated bundled-pack allow-list. `core` is always kept. Examples: `core-only`, `core,communications`, `core,productivity,spatial`, or `all`. Modules whose profile is enabled but pack is unavailable are reported through `profile_status.modulesMissingPacks`. |
| `TAXI_REQUIRE_TOOL_SESSION` | (off unless app/CLI config sets it) | `true` makes `run_tool` require a valid `sessionId` before dispatching hidden tools. Directly exposed tools remain callable without a session. New app/CLI-generated configs set `requireToolSession: true`; no-config direct stdio keeps the compatible default. |
| `TAXI_HARNESS_ADAPTER` | inferred | Task harness policy: `compatible`, `strict`, `app-runtime`, or `agent`. App-owned HTTP runtime is inferred from `TAXI_APP_OWNED_RUNTIME`; config-driven strict sessions infer `strict`. |
| `TAXI_TOOL_SESSION_MAX_TOOLS` | `64` | Maximum tools allowed in one task-scoped session. Capped at 64. |
| `TAXI_TOOL_SESSION_DEFAULT_TTL_SECONDS` | `900` | Default task session lifetime. |
| `TAXI_TOOL_SESSION_MAX_TTL_SECONDS` | `3600` | Maximum task session lifetime. Capped at 3600. |
| `TAXI_ENABLE_SPATIAL_PREP` | (off) | `true` enables the experimental read-only spatial asset prep tools. |
| `TAXI_DEBUG_MODULES` | (empty) | Comma-separated whitelist. When set, only listed modules load — easier debugging of import / boot issues. |
| `TAXI_DEBUG_SEQUENTIAL` | (off) | `true` loads modules one-by-one instead of `Promise.all()`. Memory-safe debugging. |
| `TAXI_DISABLE_POLLERS` | (off) | `true` suppresses event poller registration (mail unread, focus mode, etc.). |
| `TAXI_INCLUDE_SHARED` | (off) | `true` opts notes / reminders into shared (iCloud-shared) item access. |
| `TAXI_PROACTIVE_CONTEXT` | (off) | Toggles the proactive context module. |
| `TAXI_SEMANTIC_SEARCH` | (off) | Toggles the semantic search index + tools. |
| `TAXI_FAKE_OS_VERSION` | (empty) | Override the detected macOS version in tests. |
| `TAXI_TEST_MODE` | (off) | `1` enables test-only reset hooks (e.g. `_resetForTests`). |

---

## Embedding / AI

| Variable | Default | Notes |
|---|---|---|
| `TAXI_LOCAL_ONLY` | (off) | `true` / `1` disables every cloud embedding path. `detectProvider` returns `swift` or `none` only, the hybrid Swift→Gemini fallback is refused (Swift error surfaces to the caller instead of silent re-try), and `TAXI_EMBEDDING_PROVIDER=gemini`/`hybrid` is overridden with a stderr warning. Set this when you want a hard privacy contract — note titles + previews stay on-device. |
| `TAXI_EMBEDDING_PROVIDER` | (auto-detect) | Explicit override. One of `gemini` / `swift` / `hybrid` / `none`. Auto-detect picks `hybrid` if both `GEMINI_API_KEY` and the Swift bridge are available, else the highest-priority single backend. Rejected with warning under `TAXI_LOCAL_ONLY=true`. |
| `TAXI_EMBEDDING_MODEL` | `gemini-embedding-2` | Override for the Gemini provider. |
| `TAXI_EMBEDDING_DIM` | `256` | Output dim (256/512/1024/2048/3072). 256 is optimal for tool/note search. |
| `TAXI_EMBED_CACHE_MAX_MB` | `256` | LRU embedding cache cap in megabytes. |
| `TAXI_GEMINI_API_URL` | (default endpoint) | Override the Gemini base URL. |
| `TAXI_INDEX_COOLDOWN` | `300000` (5 min) | Backoff after an indexing failure before retry. |

> When `hybrid` mode falls back from Swift to Gemini, Taxi writes an `__embedding_fallback` line to the audit log with the original Swift error reason. `audit_summary` surfaces every cloud crossing so the trail is visible even when `TAXI_LOCAL_ONLY` is off.

---

## Telemetry / Observability

| Variable | Default | Notes |
|---|---|---|
| `TAXI_TELEMETRY` | (off) | `true` enables OpenTelemetry trace emission via the optional `@opentelemetry/api` peer dep. |
| `TAXI_USAGE_TRACKING` | (enabled) | `false` disables the in-process usage tracker (next-tool suggestions). |
| `TAXI_USAGE_PROFILE_PATH` | `~/.taxi/profile.json` | Override path. Primarily used by tests to isolate state. |
| `TAXI_TOKEN_RATIO` | `4` | Char-per-token ratio for `npm run tokens` (override for sensitivity testing). |

---

## Timeouts & Buffers

| Variable | Default | Notes |
|---|---|---|
| `TAXI_TIMEOUT_JXA` | `30000` | JXA `osascript` timeout (ms). |
| `TAXI_TIMEOUT_SWIFT` | `60000` | Swift bridge call timeout (ms). |
| `TAXI_TIMEOUT_GEOCODE` | `10000` | Geocoding API timeout (ms). |
| `TAXI_TIMEOUT_GWS` | `15000` | Google Workspace CLI default timeout (ms). |
| `TAXI_BUFFER_JXA` | `10485760` (10 MB) | JXA stdout cap. |
| `TAXI_BUFFER_SWIFT` | `10485760` (10 MB) | Swift stdout cap. |
| `TAXI_BUFFER_SWIFT_LINE` | `1048576` (1 MB) | Single Swift NDJSON line cap. |
| `TAXI_JXA_CONCURRENCY` | `3` | Max parallel `osascript` processes. |
| `TAXI_CB_THRESHOLD` | `3` | Circuit breaker open threshold. |
| `TAXI_CB_OPEN_MS` | `60000` | Circuit breaker open duration (ms). |

---

## Triggers (RFC 0008-related)

| Variable | Default | Notes |
|---|---|---|
| `TAXI_TRIGGER_MAX_RETRIES` | `5` | Max retry attempts for a failing trigger. |
| `TAXI_TRIGGER_BASE_BACKOFF_MS` | `1000` | Initial backoff between retries. |
| `TAXI_TRIGGER_MAX_BACKOFF_MS` | `60000` | Cap on exponential backoff. |
| `TAXI_MAIL_POLL_MS` | `30000` | Mail unread-count poll interval. |
| `TAXI_MUSIC_POLL_MS` | `5000` | Music now-playing poll interval. |

---

## Tooling / scripts

| Variable | Default | Notes |
|---|---|---|
| `TAXI_CONFIG_PATH` | `~/.config/taxi/config.json` | Override config-file path. |
| `TAXI_TEMP_DIR` | `os.tmpdir()` | Temp directory for screenshots / recordings / intermediate exports. |
| `TAXI_USER_AGENT` | `Taxi/2.x (https://github.com/heznpc/Taxi)` | User-Agent for outbound HTTP. |
| `TAXI_COMPACT_TOOLS` | (enabled) | `false` ships full descriptions in `tools/list` (skips `compactDescription`). Roughly doubles the description token budget. |
| `TAXI_EXT_APPS_CDN` | (default URL) | CDN for the MCP Apps client library. |
| `TAXI_INTENTS_OUT` | (repo path) | Override output path for `gen-swift-intents.mjs`. |
| `TAXI_INTENTS_MANIFEST` | (repo path) | Manifest path consumed by the intents codegen. |
| `TAXI_MANIFEST_OUT` | `docs/tool-manifest.json` | Override output path for `dump-tool-manifest.mjs`. |
| `TAXI_APPINTENTS_DESTRUCTIVE` | (off) | Opt-in flag for destructive App Intents (RFC 0007 §A.3). |
| `TAXI_GEOCODING_API_URL` | Open-Meteo | Override the geocoding endpoint. |
| `TAXI_REVERSE_GEOCODE_API_URL` | Nominatim | Override the reverse geocoding endpoint. |
| `TAXI_WEATHER_API_URL` | Open-Meteo | Override the forecast endpoint. |

---

## Internal / test-only

These are documented for completeness; you should rarely set them in production.

| Variable | Notes |
|---|---|
| `NODE_ENV=test` | Unlocks test-only reset hooks. |
| `TAXI_TEST_MODE=1` | Same as above for callers without control over `NODE_ENV`. |
| `TAXI_DISABLE_*` | Module-level kill switches surfaced via `taxi --help` and validated against known module names. |

---

## Task-scoped tool sessions

Taxi's profile/exposure settings control what loads and what appears in `tools/list`. For a single agent task, clients can narrow further with the MCP tools `start_tool_session`, `discover_tools`, `describe_tool`, `run_tool`, `tool_session_status`, and `end_tool_session`:

1. `start_tool_session({ tools: ["search_notes", "read_note"], ttlSeconds: 900 })`
2. `discover_tools({ query: "notes", sessionId })` only searches that allowlist.
3. `run_tool({ name: "read_note", args: {...}, sessionId })` refuses tools outside the allowlist.

This is a cooperative harness contract for MCP clients and higher-level agent runners. By default it preserves the compatible no-session path for hidden tools. Set `TAXI_REQUIRE_TOOL_SESSION=true` or `TAXI_HARNESS_ADAPTER=strict` when the client or harness is ready for strict task scoping: hidden tools still appear through compact `discover_tools` results, `describe_tool` fetches the full description for one selected tool, and `run_tool` refuses to dispatch hidden tools unless the caller passes a valid `sessionId`. Directly exposed tools remain callable without a session.

It does not replace OS permissions, HITL approval, OAuth scopes, rate limits, or the emergency stop; those gates still run inside the target tool call.

---

## Module packs

Taxi module packs are runtime activation and context boundaries. `taxi modules` and `TAXI_MODULE_PACKS` let operators activate only selected packs without changing the installed artifact. The root npm package and MCPB both ship the universal JavaScript `dist` tree; logical profiles and progressive tool exposure keep the active surface narrow. Taxi 1.0 neither discovers nor installs external module packages.

Built-in packs:

- `core`: notes, reminders, calendar, shortcuts, system, Finder, weather, audit visibility
- `communications`: contacts, mail, messages
- `productivity`: Pages, Numbers, Keynote
- `browser`: Safari
- `media`: Music, TV, Podcasts, speech
- `visual`: Photos, screen, UI automation
- `location`: Maps, current location
- `device`: Bluetooth, Health
- `intelligence`: Apple Intelligence, memory
- `google-workspace`: Google Workspace
- `spatial`: experimental spatial prep

Use `taxi modules list` locally or `list_module_packs` over MCP to inspect the active pack set. Use `taxi modules enable productivity,communications` to write a narrow `modulePacks` config. `profile_status` reports `modulePacksConfigured`, `modulePacksAvailable`, and `modulesMissingPacks` when a selected profile is narrower than the bundled catalog.

Stable release preflight clean-installs the root tarball and MCPB, boots each in `full/full` mode, and verifies representative tools across the standard packs.

The `spatial` pack is the extension point for VR/spatial context bridges. Its contract is read-only asset/context preparation: gather local Apple workspace context, file metadata, screenshots, Photos/Keynote/Finder references, and exportable manifests for a downstream spatial renderer or headset workflow. It must not become a generic 3D render pipeline inside the core package.

---

## Where to look in source

- Defaults + parsers: [`src/shared/constants.ts`](../src/shared/constants.ts)
- Config schema: [`src/shared/config.ts`](../src/shared/config.ts)
- Tool sessions: [`src/shared/tool-sessions.ts`](../src/shared/tool-sessions.ts) + front-door registration in [`src/server/mcp-setup.ts`](../src/server/mcp-setup.ts)
- Network policy: [`src/server/http-transport.ts`](../src/server/http-transport.ts) + RFC 0002
- Rate limit: [`src/shared/rate-limit.ts`](../src/shared/rate-limit.ts)
- Audit: [`src/shared/audit.ts`](../src/shared/audit.ts)
- HITL: [`src/shared/hitl-guard.ts`](../src/shared/hitl-guard.ts) + RFC 0008
