# Task Dashboard and sessions

Taxi embeds `@heznpc/quota-core` 0.2.0. QuotaPie does not need to be installed
or running. The shared implementation is maintained in QuotaPie and consumed
as a checksum-pinned package, bundled in both Taxi's npm artifact and macOS app.
Node 22 or later is required for the server.

Open **Task Dashboard** directly from the Taxi menu (⌘T) with the app-owned
runtime running. The existing Trust Center entry also remains available.
The dashboard shows root tasks and child sessions, explicit phases, execution
owners, provider state, handoff context and result evidence. Usage and provider
settings are expandable beneath the work views. Taxi is expanding into a
central work environment; the execution adapter currently supports isolated
read-only Codex turns, not a general implementation or deployment runner.

## Provider setup

This initial adapter supports the public local `codex app-server` stdio API.
Install Codex CLI if the page reports it missing, then use the login command
shown by Taxi. It sets `CODEX_HOME` to Taxi's private profile for that command.
Taxi never edits the default Codex configuration or imports credentials.
The API was exercised with Codex CLI 0.139.0. The upstream app-server interface
is experimental; incompatible or unsupported requests fail visibly.

Taxi uses a separate profile so QuotaPie's configuration and relay do not
intercept Taxi-owned sessions. There is no Taxi relay listening on an upstream
provider port. A single owner lock protects Taxi's state directory. Usage is
collected only by an explicit action after collection consent is saved; no
background model, collector loop, or manager agent is started.

## Routing and evidence

Save a model and reasoning effort for new sessions or explicitly requested
changes. Enter a phase label (for example 구상, 조사, 구현, 검증) and save the
current choice for that exact phase. Taxi calls the embedded core
`selectTaskModel` using the live account/profile model catalog: explicit choice,
then phase preference, then saved default. An unavailable choice fails before
a new provider session or turn is sent; it never silently falls back.
The selection reason is recorded alongside each run. Continuing a session preserves its model choice. **Change model in the
existing session** changes the model without creating another session. An
optional per-run switch permits the saved conservative task policy; the target
must appear in the provider's supported model and effort catalog. Explicit model
changes disable that policy for the run.

Compression routing preferences are validated and saved using the shared core,
but **compression routing is not active in this adapter**. The UI displays
`relay-not-connected`. It does not claim that a saved preference changed traffic.

Execution records distinguish saved preferences, requested selection, dispatch,
session acknowledgment, provider completion or failure, and actual response-model
evidence. The current app-server adapter does not receive response-model proof,
so it remains **unverified**, even when a turn completes. Provider completion
also does not verify the task's completion criteria. Lost connections, interrupted
turns and process restarts remain unverified and are never automatically replayed.

## Task handoffs

Record the original request, adopted decisions, open questions, completion
criteria and evidence references. **Prepare a separate session handoff** saves a
child task with an immutable context snapshot, chosen next phase and parent
link. The native handoff endpoint accepts explicit context and model-preference
overrides; omitted values inherit from the parent. Preparation
creates no provider session or model call. Authorizing its first run creates a
new Codex session, sends the handoff, and stores its thread ID and results next
to the task. Parent and child links remain navigable after restart.

Each execution requires a native app action, creates at most one turn and runs
read-only with network tools disabled and approvals denied. Parent approvals,
MCP tool-session grants, and execution permissions are never copied. Existing
external Codex sessions and unsupported providers cannot be resumed here.
Only Taxi-created sessions in Taxi's dedicated profile can be continued.
The emergency stop blocks new runs and terminates an active provider process;
interrupted outcomes stay unverified. At most one provider work run is active.

The Codex app-server additionally runs inside the macOS
[background-only process boundary](background-only.md), including its child
processes. Unsupported isolation fails before provider launch. Writable project
development for Codex or Claude uses the explicit `taxi work` mode described there.

Private task records and outputs live under the Taxi state directory in
`harness/state.json` (owner-only directory and file permissions). They are not
written into project repositories or exported into packages. Audit entries
contain action and outcome metadata, not prompts or handoffs. Storage is bounded
to 500 tasks and 1,000 runs in this initial implementation.


## External catalog and explicit relationships

**Import Modore catalog…** accepts the version-1 JSON contract in
[session-catalog.md](session-catalog.md). The importer runs without Modore or
QuotaPie installed. It preserves opaque keys, provider/profile identities,
source/provenance, generation and import times, and incomplete/truncated scan
errors. Files from unknown versions, duplicate keys or identity collisions are
rejected atomically. Older scans never replace fresher metadata. Missing entries
are retained and marked absent from the latest import, including partial scans.

Imported sessions have **unknown** execution state and **observe-only** authority.
File timestamps mean last activity, not running or completed. Metadata older
than 24 hours is labeled stale; timestamps more than five minutes ahead are
labeled future. Neither label proves provider activity. The UI searches and
pages the catalog without interpreting titles or paths as commands.

Select an external session and **Register explicit relationship** with a Taxi
task, phase, optional parent external key, registration source and evidence.
User-authorized parent sessions can prepare these exact values for native-app
registration. This is an explicit assertion, not provider-verified genealogy or
permission delegation. Cycles and unknown keys are rejected. No relationship
is inferred from shared workspaces or nearby timestamps. All records stay in
Taxi's private app state. Imported Codex and Claude desktop records can open
an installed original app; this opens the app, not the specific session or a
resume command. CLI-only and unsupported providers remain observation-only.

## Read-only tool access

Authorized clients use the normal authenticated Taxi MCP transport, then:

```text
start_tool_session({tools: ["read_task_dashboard"]})
run_tool({name: "read_task_dashboard", sessionId: "<grant>",
          args: {sessionId: "<grant>", taskId: "<optional task UUID>", limit: 50}})
```

The tool requires its own valid allowlist grant even for direct dispatch. It
reads task context, links and provider evidence from the same saved state,
with paged external metadata and up to 100 recent result records. It does not
start a host, modify state, copy grants, register relationships or execute work.
Other machines/stdio processes see only the state directory they are configured
to observe. Writes remain on the generation-authenticated native app endpoints:
`POST /app/harness/catalog`, `/tasks`, `/tasks/:id/handoff`, and
`/tasks/:id/links`. There are no corresponding write MCP tools.

Modore continues to own its existing backup/recovery and test-resource hooks.
Transferring those live resources, general execution, cross-provider resume and
autonomous scheduling is future work. Compression remains `relay-not-connected`.

## Reproducible verification

`node scripts/verify-harness.mjs` launches Taxi with isolated state and an
explicit synthetic Codex protocol fixture. It verifies native authorization,
usage, settings, task routing, separate handoffs, model-only changes,
idempotent run delivery, failure, uncertain outcomes and emergency stop. It also
checks catalog validation, explicit links, MCP reading and persistence after a
real runtime restart. Add `--catalog /path/to/catalog.json` to import actual
metadata without sending prompts to those sessions.

To test a previously installed artifact, supply `--server-root` with the installed
Taxi package directory. For a live provider check, supply `--real-codex --auth-file`
with a local Codex credential file. This makes two minimal real provider turns
and a quota read using a disposable private credential copy. It never resumes
an existing user session and removes the copy afterward. Fixture mode and real
provider mode print different verification labels.

Protocol reference: [Codex App Server](https://developers.openai.com/codex/app-server).
