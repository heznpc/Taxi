# Privacy Policy

**Taxi v1.0.0** — A local workspace for coordinating AI sessions and tools (macOS source preview)
Last updated: 2026-09-29

## Overview

Taxi is an open-source local workspace for coordinating AI sessions and tools. Its Task Dashboard records work and can send explicitly authorized turns through Codex. Its MCP (Model Context Protocol) runtime connects AI clients to Apple apps through JXA (JavaScript for Automation) and a native Swift bridge.

This privacy policy explains how Taxi handles your data, including what data leaves your machine.

## Data Controller

Taxi is an open-source project maintained by **heznpc** under the MIT License. As a locally-run tool, the project maintainer does not process your personal data on any server. However, for the purposes of GDPR Article 13/14 transparency, the data controller contact point is:

- **Contact:** GitHub Issues at [https://github.com/heznpc/Taxi/issues](https://github.com/heznpc/Taxi/issues)

When you use third-party APIs (Gemini, Nominatim, Open-Meteo, Google Workspace), the respective API provider acts as an independent data controller for the data you send to them.

## Data Collection

Taxi has no maintainer-operated analytics, advertising, crash-reporting, or marketing collection service. It keeps a local usage profile by default to rank tools and may emit OpenTelemetry signals only when the owner explicitly enables and configures that integration. Those records are controlled by the owner, not sent to a Taxi-operated backend.

## Legal Basis for Processing

Under GDPR Article 6, Taxi relies on the following legal bases:

- **Legitimate interest (Art. 6(1)(f)):** Local automation operations (reading/writing Apple app data, on-device AI processing, local file operations) are performed based on the user's legitimate interest in automating their own macOS workflows. All such processing occurs entirely on the user's machine.
- **Consent (Art. 6(1)(a)):** External API calls to Google Gemini, OpenStreetMap Nominatim, Open-Meteo, Google Workspace, or Power Automate Cloud Flows are made only after the owner configures or invokes those paths. The inbound webhook listener is likewise active only after the owner explicitly starts it (`webhook_listen_start`). Consent can be withdrawn by removing the related credentials/configuration, stopping the listener, and not invoking those tools.

## How Your Data Is Handled

### Local Processing

Most Taxi operations run entirely on your Mac:

- **Apple app data** (Notes, Calendar, Reminders, Contacts, Mail, Messages, Music, Finder, Safari, Photos, etc.) is read from and written to local apps via macOS automation APIs.
- **MCP tool results** (note contents, email text, calendar events, etc.) are returned to the connected MCP client (e.g., Claude Desktop, Cursor). The MCP client's own privacy policy governs how it handles this data.

### Task Dashboard and provider requests

Creating a task, preparing a child-session handoff, saving model preferences, or importing an external-session catalog writes local state and does not by itself send a model request. A native-app authorization starts at most one Codex turn. For a new Taxi-owned session, Taxi sends the recorded task context or handoff plus the current instruction through the local Codex app-server to the configured provider. The context includes the original request, decisions, open questions, completion criteria and evidence references. Continuing a Taxi-owned session sends the new instruction in that provider session's existing context.

The current adapter requests read-only execution, denies approval requests and disables network tools. These tool restrictions do not prevent the Codex service from sending model requests to its provider. Provider handling and retention follow that provider's policies. Taxi uses a dedicated Codex profile under its private state directory; it does not import the default profile's credentials. Explicit usage refreshes query account rate-limit information after usage collection is enabled. Execution separately queries the provider’s model catalog before sending a turn.

Imported external catalogs contain session metadata, such as titles, identifiers, provider/profile details, paths, activity times and scan provenance. Importing a catalog does not grant permission to resume its sessions or automatically send it to a model. The read-only dashboard MCP tool can return task context, handoffs, results and imported metadata to the calling MCP client; it omits the run's separate prompt field but does not redact all task content. The client may send returned data to its own model provider.

### Data That Leaves Your Mac

Taxi connects to external services in the following cases:

| Feature | Service | Data Sent | When |
|---------|---------|-----------|------|
| **Task Dashboard execution** | Provider used by the dedicated Codex profile | Current instruction, initial task context/handoff, and provider session context | Only after explicit native-app authorization of a turn |
| **Task Dashboard usage refresh** | Codex account service | Authenticated account rate-limit requests | On explicit refresh after collection is enabled |
| **Semantic search (Gemini)** | Google Gemini API (`generativelanguage.googleapis.com`) | Text excerpts from notes (300 chars), email subjects/excerpts (200 chars), calendar event titles, reminder names | Only when `GEMINI_API_KEY` is configured and semantic indexing runs |
| **Weather** | Open-Meteo API (`api.open-meteo.com`) | Latitude/longitude coordinates | When weather tools are called |
| **Geocoding** | Open-Meteo Geocoding (`geocoding-api.open-meteo.com`) | Place names/addresses | When maps tools search for locations |
| **Reverse geocoding** | OpenStreetMap Nominatim (`nominatim.openstreetmap.org`) | GPS coordinates | When maps tools resolve coordinates to addresses |
| **Google Workspace** | Google APIs (via `gws` CLI) | Gmail, Drive, Sheets, Calendar, Docs data | When Google Workspace tools are used (requires separate Google auth) |
| **Inbound webhook listener** | External caller reachable at the bound host:port (`127.0.0.1` by default) | The verified POST body is turned into an internal `webhook_received` event; no payload is sent by Taxi to any external destination | Only while the listener is running — started via `webhook_listen_start`, stopped via `webhook_listen_stop` |
| **Power Automate (Cloud Flow trigger)** | Owner-configured Microsoft Power Automate Cloud Flow HTTP trigger URL | JSON payload supplied to `cloudflow_trigger` | Only when `cloudflow_trigger` is explicitly invoked and network policy allows the destination |

Taxi itself sends no data to a Taxi-operated backend. Data can still leave the Mac through a connected MCP client or when you use any of the outbound paths listed above. The inbound webhook listener is the exception: it does not send data anywhere — it only receives POSTs a caller sends to it, and (if configured to bind beyond loopback) exposes a local port to accept them.

### Local Data Storage

Taxi stores the following data on disk:

| File | Content | Purpose |
|------|---------|---------|
| `~/.config/taxi/config.json` | Module preferences, HITL settings | User configuration |
| `~/.taxi/vectors.json` | Text excerpts + embedding vectors from notes, email, calendar, reminders | Semantic search index |
| `~/.taxi/audit.jsonl`, rotations, and `audit.checkpoint` | HMAC-chained tool-call metadata with sensitive values scrubbed | Local accountability and current-snapshot integrity checks |
| `~/.taxi/profile.json` | Local tool-frequency and sequence counters | Progressive tool ranking and suggestions |
| `~/Library/Application Support/Taxi/http-token` | Owner-only bearer token (`0600`) | Authenticate the app-owned local HTTP runtime |
| `~/.taxi/harness/state.json` | Task context, handoffs, run prompts and outputs, provider IDs/events, preferences, usage observations, imported session metadata and explicit relationships | Task Dashboard continuity; owner-only directory/file permissions, without application-level encryption |
| `~/.taxi/harness/codex/` | Dedicated Codex profile, authentication and provider-managed session files | Isolated Taxi-owned Codex sessions |
| macOS Spotlight Index | Note titles, email subjects, reminder names, calendar event titles | System-wide Spotlight/Siri discoverability (opt-in via `spotlight_sync` tool) |

The vector store (`vectors.json`) and dashboard state can contain private text. Neither is encrypted by Taxi. Use `semantic_clear` to clear the semantic index. Stop Taxi before manually removing `~/.taxi/harness/state.json` to reset dashboard records. Removing the entire `~/.taxi` directory also removes other state, including audit history and the dedicated provider profile.

To also clear Spotlight entries, run the `semantic_clear` tool (which clears both) or `spotlight_clear` (Spotlight only).

## Data Retention

Taxi does not operate server-side storage. The following retention describes local Taxi records; provider copies and connected MCP clients have separate retention policies:

| Data | Retention | How to Delete |
|------|-----------|---------------|
| `~/.taxi/vectors.json` (semantic index) | Retained until the user deletes it | Use the `semantic_clear` tool or remove the index file |
| `~/.config/taxi/config.json` (configuration) | Retained until the user removes or edits the file | Delete or edit the file manually |
| `~/.taxi/audit.jsonl`, rotations, and checkpoint | Retained locally with rotation | Remove those files manually after stopping Taxi; removal intentionally destroys audit history |
| `~/.taxi/profile.json` (local usage profile) | Retained until reset or deletion | Delete the file or disable local usage tracking |
| `~/.taxi/harness/state.json` | No time-based expiry; task/run storage is bounded and new entries are rejected at the limits | Stop Taxi, then remove the file to reset dashboard records; deleting it does not remove provider copies |
| `~/.taxi/harness/codex/` | Managed by the dedicated Codex profile | Stop Taxi before removing the profile; this also removes its local authentication/session state, not remote provider records |
| macOS Spotlight entries | Retained until the user clears them | Use the `spotlight_clear` or `semantic_clear` tool |

For data sent to external APIs or an owner-configured Power Automate Cloud Flow destination, Taxi does not control the retention period; refer to each destination's privacy and retention policy. Data received by the inbound webhook listener is not persisted by Taxi beyond turning it into a `webhook_received` event — retention of the original data is controlled by whichever caller sent it and by any skill that acts on the event.

## Apple Intelligence / Foundation Models

When the optional Foundation Models build is enabled on a supported Mac, Taxi's intelligence tools process user-provided text through Apple's Foundation Models framework.

- **Opt-in build and availability check**: The default build does not claim that the Foundation Models bridge is available. Taxi checks the bridge and system-model availability before evaluation or use.
- **Apple framework boundary**: Taxi does not add its own network fallback for Foundation Models requests. Apple's platform privacy terms govern the framework itself.
- **`summarize_context` fallback**: When MCP Sampling is unavailable, this tool sends a context snapshot (calendar events, reminders, note previews, clipboard contents, mail metadata) to the on-device model.
- **`generate_image`**: Prompts are processed by Apple's on-device Image Playground model.
- **`scan_document`**: Images are processed locally via Apple Vision OCR. No network involvement.

## macOS App Intents

Taxi's companion app registers App Intent actions that owners can compose inside the macOS Shortcuts app. Apple does not support the iOS App Shortcuts phrase surface on macOS, so the Mac app does not register `AppShortcutsProvider` phrases or advertise “Hey Siri” triggers.

- Running a Taxi action from Shortcuts sends the action through the same local, token-gated Taxi runtime and its HITL, rate-limit, emergency-stop, and audit controls.
- Apple's own privacy policy governs the Shortcuts application and other system surfaces.
- Spotlight-synced data becomes visible in macOS Spotlight search UI.

## Sensitive Data in MCP Tool Results

All data returned by Taxi tools is sent to the connected MCP client (AI model). This includes:

- **Safari**: `read_page_content` returns full HTML from open tabs (up to 50KB), which may include authenticated web content (banking, email, medical portals). `run_javascript` executes arbitrary JavaScript in browser tabs and returns the result — it can access any DOM data, cookies, or session information from open pages.
- **Screen capture**: `capture_screen`, `capture_window`, and `capture_area` return full screenshots as images. Anything visible on screen (passwords, financial data, private conversations) will be sent to the AI model.
- **Notes, Mail, Messages, Contacts, Calendar, Photos**: Tool results include the full content of these items. Notes may contain passwords or sensitive records. Emails may contain financial or medical information. Photos metadata may include GPS coordinates.

**You are responsible for reviewing what data your AI model can access.** Disable modules you don't want exposed via `taxi setup` or the config file.

## Safety Controls

- **Sending email/messages** is disabled by default (`allowSendMail: false`, `allowSendMessages: false`). You must explicitly enable these in config or via environment variables.
- **Human-in-the-loop (HITL)** defaults to sensitive operations and is evaluated per tool call. It can be tightened or disabled by the owner.
- **Destructive tools** are annotated with `destructiveHint: true` so MCP clients can warn before execution.
- **Rate limits and emergency stop** bound destructive activity; creating `~/.taxi/emergency-stop` blocks the next destructive call without waiting for a negative cache.
- **HMAC-chained audit log** detects modified, inserted, malformed, or checkpoint-inconsistent entries after the signed chain begins. While Taxi remains running, an observed checkpoint floor also detects replacement with an older valid log/checkpoint pair or deletion of both. That floor is process-local: after restart, a complete older pair or complete deletion cannot be distinguished from an intentional restore or fresh state without an external monotonic anchor.

## Transport Modes

- **stdio (default):** Communication between the MCP client and Taxi happens via standard input/output on your local machine. No network traffic.
- **HTTP (`--http`):** The server is loopback-only by default. Non-loopback operation is fail-closed unless an explicit `allowNetwork` policy is selected. Token mode validates `Authorization: Bearer …`; OAuth mode uses the configured OAuth 2.1 resource server and the fixed `mcp:read`, `mcp:write`, `mcp:destructive`, and `mcp:admin` scopes. Do not expose the service through a proxy without preserving these controls.

## macOS Permissions

Taxi requires macOS Automation permissions to interact with Apple apps. These are managed by macOS and granted through system prompts. Taxi uses these permissions solely to execute actions you request through the MCP client.

## Data Subject Rights (GDPR Articles 15-22)

Under the GDPR, you have the following rights regarding your personal data:

- **Right to access (Art. 15):** You may request information about what personal data is processed.
- **Right to rectification (Art. 16):** You may correct inaccurate personal data.
- **Right to erasure (Art. 17):** You may request deletion of your personal data.
- **Right to restriction of processing (Art. 18):** You may request that processing be restricted.
- **Right to data portability (Art. 20):** You may request your data in a portable format.
- **Right to object (Art. 21):** You may object to processing based on legitimate interest.

**For locally-stored data:** Because Taxi runs entirely on your machine, you have full filesystem access to all data it stores. You can inspect, modify, export, or delete `vectors.json`, `config.json`, and Spotlight entries at any time without needing to contact anyone.

**For data sent to external APIs:** If you have exercised Gemini, Nominatim, Open-Meteo, Google Workspace, or Power Automate tools, refer to the respective destination's privacy policy to exercise your data subject rights with it. For the inbound webhook listener, Taxi is not the sender of that data — the external caller that POSTed to your listener controls it; contact that caller directly.

- Google Gemini: [Google Privacy Policy](https://policies.google.com/privacy)
- OpenStreetMap Nominatim: [OSMF Privacy Policy](https://wiki.osmfoundation.org/wiki/Privacy_Policy)
- Open-Meteo: [Open-Meteo Terms](https://open-meteo.com/en/terms)

## International Data Transfers

Taxi processes data locally on your Mac by default. When external APIs are used, international transfers may occur:

- **Google Gemini API:** Data may be transferred to Google servers in the United States. Google provides safeguards under its data processing terms.
- **OpenStreetMap Nominatim:** Requests are sent to OSM servers based in the European Union.
- **Open-Meteo:** Servers are based in the European Union.
- **Google Workspace (via `gws` CLI):** Data is transferred to Google servers. Refer to Google's data processing terms.
- **Power Automate:** Data is transferred to the Cloud Flow destination configured by the owner; its location and safeguards depend on that destination.
- **Inbound webhook listener:** No outbound international transfer occurs — the listener only receives data a caller sends to it, and (if bound to a non-loopback interface) accepts connections from that caller's network.

Taxi itself performs no international transfer to a Taxi-operated service. Transfers may still be made by the connected MCP client or an external destination selected by the owner.

## Data Protection Officer

A Data Protection Officer (DPO) is not required for Taxi, as it involves small-scale processing by an individual open-source developer and does not engage in systematic monitoring or large-scale processing of sensitive data.

For privacy-related questions or concerns, contact the project maintainer via GitHub Issues: [https://github.com/heznpc/Taxi/issues](https://github.com/heznpc/Taxi/issues)

## Right to Lodge a Complaint

If you believe your data protection rights have been violated, you have the right to lodge a complaint with your local data protection supervisory authority. A list of EU/EEA supervisory authorities is available at [https://edpb.europa.eu/about-edpb/about-edpb/members_en](https://edpb.europa.eu/about-edpb/about-edpb/members_en).

## Open Source

Taxi is open-source software under the MIT License. You can inspect the full source code at [github.com/heznpc/Taxi](https://github.com/heznpc/Taxi).

## Third-party Attribution

- Reverse geocoding powered by [Nominatim](https://nominatim.org/) / [OpenStreetMap](https://www.openstreetmap.org/) (© OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/)).
- Weather data by [Open-Meteo](https://open-meteo.com/).

## Changes to This Policy

Updates will be reflected in this file. The "Last updated" date at the top will be revised accordingly.

## Contact

For questions about this privacy policy, open an issue on the [GitHub repository](https://github.com/heznpc/Taxi).
