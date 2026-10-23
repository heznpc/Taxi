# Imported session catalog v1

Taxi accepts a metadata-only Modore export with this exact JSON envelope:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-09-29T00:00:00Z",
  "source": "modore",
  "scan": {"complete": false, "truncated": true, "errors": ["scan-truncated"]},
  "sessions": [{
    "key": "opaque-profile-and-session-key",
    "provider": "codex",
    "providerSessionId": "provider-session-identifier",
    "profileKey": null,
    "workspacePath": null,
    "lastActivityAt": null,
    "provenance": "local-metadata"
  }]
}
```

`title` is optional when already present in provider metadata. Nullable fields
must be explicit null when unknown. Keys stay opaque; a null profile is never
merged with another profile or used to deduplicate different keys. Each key
must remain bound to the same provider/profile/session tuple across imports.
Duplicate keys within a catalog and unknown fields/versions are rejected.
Timestamps accept ISO-8601 offsets; time comparisons use parsed instants.

The native import route accepts at most 16 MiB and 50,000 retained sessions;
100 import receipts and 10,000 explicit links are retained. Receipts record the
source's scan completeness, truncation, errors, generated time, received time
and count. Saved session metadata preserves its own observation times. A later
import does not delete older entries or change an imported execution state from
unknown. Imports are atomic; failure leaves the previous catalog intact.

Only explicit Taxi creation records or a native registration with evidence can
establish task/session relationships. Registration can cite a user-authorized
parent session, but neither the catalog nor that label authenticates or confers
execution permission. CLI paths, titles and IDs are displayed as text, never
executed. Actual provider turn completion is only shown for Taxi-owned runs
with matching provider events; user completion criteria remain unverified.

Modore's metadata exporter owns discovery. Taxi owns import, validation and the
read-only view; it does not replicate provider disk parsers or require Modore's
application to be running. This contract is separate from the older
`taxi sessions <snapshot.json>` backup-snapshot inspection path.
