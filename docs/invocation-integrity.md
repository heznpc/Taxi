# Invocation outcome integrity

Implemented on top of the repository bridge source base (`9fa61ae`).

## Automation fallback

`runAutomation` defaults to no replay after a dispatched Swift failure. A missing
or unsupported bridge, or a transport-proven `SwiftNotDispatchedError`, may use
JXA. Read-only callers explicitly opt into `retrySafe`; mutation annotations do
not automatically grant replay permission. Explicit bridge shutdown is not a
reason to launch another executor.

A dispatched helper error can follow a committed or partial change. For both
Swift and JXA, the tool error carries `cause.code: outcome_unknown`, the actual
bridge origin, and `retryable: false`. Callers must inspect/reconcile external
state before another mutation. This does not claim a duplicate was observed in
production or provide exactly-once execution.

## Reminder inputs and targets

Create/update/recurring due dates are validated before execution. The accepted
format is an explicit ISO timestamp at whole-second precision with `Z` or a
numeric timezone. Zero fractions such as `.000Z` are accepted; nonzero fractional
seconds, local/zone-less timestamps, impossible calendar dates and `-00:00` are
rejected. Node canonicalizes accepted values to UTC before either bridge. Swift
also rejects invalid inputs before authorization or object mutation.

Named creation lists must have exactly one match. Duplicate names are rejected
before insertion in Swift and JXA. This is fail-closed name resolution, not a
cross-provider stable-ID contract: default-list selection and name lookup still
resolve at execution time. Renaming/disambiguating lists is required when names
collide.

An API save success is not an independent post-read verification. No mandatory
post-read was added, and a later verification failure must not erase a known
successful save or invite blind replay.

## Repository reads

The 60,000-character budget returns whole lines. `nextLine` advances by the
number actually returned; a single oversized line produces an explicit error
when reached. Clients must pin the returned commit across pages. Hash evidence
continues to describe the whole decoded file, not just the returned page.

## Approval evidence

Approval records include `approvalRequestDigest` (`sha256:v1:<hex>`): SHA-256 of
canonical JSON `{tool,args}`, with object keys sorted and undefined object fields
omitted. The digest is captured before waiting for approval; args are the parsed
request, including target selectors, not a separately resolved target snapshot.
The digest is sealed and verified before the handler begins and survives audit
history export. Legacy entries remain readable without a digest.

Elicitation displays complete arguments up to 32,000 characters instead of
silently cutting them at 500. Larger requests use the native approval channel;
without an approval channel they are denied. A digest is evidence, not reusable
authority or a substitute for showing meaningful arguments to the user.

## Recurring reminders

The Swift-only recurring tool now preserves uncertain dispatched failures as
`outcome_unknown`, with `origin: swift` and `retryable: false`. Proven
pre-dispatch failures remain ordinary Swift errors, and malformed dates are
still rejected before dispatch. The process fixture now exercises the recurring
tool handler as well as the dual-executor automation path, recording exactly one
effect before exiting without a response.

Recurring reminders now retain seconds in EventKit due-date components.
