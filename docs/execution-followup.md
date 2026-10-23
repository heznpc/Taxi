# Execution interfaces and boundaries

## Implemented

- The six invocation integrity items are covered by `docs/invocation-integrity.md`.
  Optional post-read verification remains optional. Ambiguous reminder list names
  fail closed; a stable cross-provider list identity is not claimed.
- MCP instructions now describe the actual planner, restricted native agent and
  deterministic event execution. They do not promise an always-on scheduler or
  that every ingress already shares Node registry policies.
- Registry tool attempts receive a unique `invocationId` independently of a
  caller's broader correlation ID. `requestDigest` commits to parsed arguments
  including target selectors, not to independently resolved target identity.
  Audit history preserves both. Existing result/error and approval evidence remain
  authoritative within their documented bounds; no general goal verification is inferred.
- `taxi history` queries retained audit records, with period, timezone, source,
  integrity, pagination, aggregate counts and explicit coverage limitations.
  Approval rows are excluded from invocation counts. `--output` creates a new
  private JSON file and refuses to overwrite an existing one.
- `taxi sessions <snapshot.json>` consumes Modore's existing v1 snapshot, checks
  required shape/version, hashes the original bytes, and returns namespaced
  session/source references with fresh/stale/future classification. Optional
  unknown fields remain in the snapshot. No cleanup or restore authority crosses.
- `taxi work` is an explicit, bounded provider execution path: fresh read-only
  Codex or Claude CLI invocation, raw stdout/stderr artifacts, conservative
  normalization, separate human review records, timeout/cancellation, and
  orphan recovery without automatic replay. This is not a generalized workflow
  engine. No mutation approval is stored or restored by a work record.
- `taxi browser` is a small Chrome debugging adapter: an explicit loopback CDP
  endpoint and exact page ID/URL, DOM/AX observations, bounded network/console
  diagnostics, and an exact-one-selector synthetic click. Page navigation and
  missing/ambiguous targets are rejected. A synthetic click is not equivalent
  to a trusted pointer event or native/domain operation.
- `taxi remote` persists request/attempt identity before dispatch and supports
  reconcile/cancel requests. HTTP 202 never becomes completion. Terminal replies
  require matching IDs and executor evidence; conflicting terminal replies cannot
  replace a known result. Transport uncertainty never invites automatic retry.
- The portable Windows PAD executor registers an operator-owned flow map,
  persists deduplication state before URI launch and accepts authenticated,
  attempt-specific callbacks from the flow. URI dispatch is only acceptance.
  Callback tokens never appear in client replies. Duplicate submissions do not
  relaunch a flow. Explicit stale-owner recovery preserves deduplication and
  marks interrupted records unknown, without restarting flows.

These new operator CLI commands are not automatically exposed to external MCP
clients and do not inherit Node ToolRegistry HITL/audit policies. Existing MCP
capabilities continue through the registry. Review is not execution approval.

## Commands

```sh
node dist/index.js history --since 2026-03-09T00:00:00+09:00 \
  --until 2026-09-10T00:00:00+09:00 --timezone Asia/Seoul \
  --snapshot /path/to/modore-snapshot.json --output /path/to/new-history.json
node dist/index.js history --since <ISO> --until <same-ISO> --offset 10000
node dist/index.js sessions /path/to/modore-snapshot.json
node dist/index.js work run /path/to/request.json
node dist/index.js work show <work-id>
node dist/index.js work cancel <work-id>
node dist/index.js work recover <work-id>
node dist/index.js work review <work-id> /path/to/review.txt
node dist/index.js browser observe <loopback-CDP-URL> <page-id> <exact-page-URL>
node dist/index.js browser click <loopback-CDP-URL> <page-id> <exact-page-URL> '#button'
node dist/index.js remote submit <HTTPS-executor-URL> <registered-flow-UUID>
node dist/index.js remote reconcile <request-UUID>
node dist/index.js remote cancel <request-UUID>
```

Provider request example:

```json
{"provider":"codex","workspace":"/path/to/project","prompt":"Summarize the current release evidence without changing files.","timeoutMs":120000}
```

The provider executable is resolved from the operator's PATH. Keep the CLI
compatible with the account's configured model. Taxi does not silently upgrade
it, choose another model, bypass provider permissions, or reinterpret a provider
error as a successful answer. Capture records may contain private output and
are stored with private local permissions. A zero process exit means output was
returned, not that its reasoning or the user's goal was verified.

History covers retained Taxi audit rows, not every past AI session or six months
of complete machine observation. Counts across pages can shift under concurrent
writes; pin an explicit upper timestamp and treat exports as observations.
Absent history and missing verification remain unknown, not zero activity or
proof of success. Raw Modore snapshot paths are references; Taxi does not open
transcripts or follow them as execution instructions.

## Windows setup and boundary

Build `node scripts/build-pad-executor.mjs` and copy `.build/pad-executor.mjs` to
Windows with Node 22+. This standalone bundle avoids the macOS npm package's OS
restriction. Create a private flow-map JSON of `{ "<UUID>": "Exact PAD flow name" }`.
Set a random 32+ character `TAXI_REMOTE_TOKEN` separately on client and executor.
Run `node pad-executor.mjs serve flow-map.json private-state-directory`. It listens
only on 127.0.0.1:3850. Use an operator-configured authenticated HTTPS transport
or a private loopback tunnel for cross-machine access; none is published by Taxi.
Windows state-directory ACLs must restrict access to the operator account.

The PAD flow must declare string inputs `TaxiRequestId`, `TaxiAttemptId`,
`TaxiCallbackURL`, `TaxiCallbackToken`. At actual completion/failure it sends:

```json
{"requestId":"<TaxiRequestId>","attemptId":"<TaxiAttemptId>","state":"completed","result":{"delivered":true}}
```

POST to `TaxiCallbackURL`, with `Authorization: Bearer <TaxiCallbackToken>` and
JSON content type. The callback is evidence supplied by the configured flow,
not independent proof of an unobservable business goal. A `started` callback is
optional; `completed`, `failed`, and `cancelled` require a result field.
The executor does not claim to stop PAD through the fire-and-forget URI API:
a cancellation request without flow acknowledgement remains unknown.
After an owner crash, `node pad-executor.mjs recover-store private-state-directory`
refuses a live owner, preserves request IDs and restores no execution authority.
Then start the server again; late callbacks can reconcile the same attempt.

## Execution boundaries

Execution records remain with the originating runtime. External session references
do not transfer database ownership, lifecycle control, or execution authority.
Windows reports observations from its configured executor; Taxi records the
originating request and uncertainty. Recovery restores evidence without granting
an implicit right to retry.
