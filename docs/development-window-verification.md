# Development window verification

## Implemented contract

- `setup_permissions({system_only: true})` reports the execution host's system
  permissions without probing unrelated Apple applications for Automation.
- `list_windows({captureTargets: true})` lists CoreGraphics window IDs, owner
  process IDs and titles. Its existing default Accessibility listing remains.
- `capture_window({windowId, ownerPid, title})` requires all three identity
  fields. It checks them before and after capture, does not activate another
  application, and rejects a stale target without capturing a substitute.
  The existing frontmost/app-name invocation remains available.
- PNG responses include target identity for window captures, timestamp,
  dimensions and SHA-256 of the returned bytes. A captured image is evidence
  for the caller's comparison, not an automatic assertion of UI correctness.
- `development-window-check` is a prompt recipe in the shared CLI/app catalog.
  It asks for an expectation and resolves ambiguous windows before capture.
  It requires the Screen module. Existing workflows remain in the catalog.
- Existing Capture Window, List Windows and Setup Permissions App Intents
  still generate and compile; exact targeting uses scalar parameters to keep
  that compatibility.

## Reproduction

```sh
npm run build
node scripts/verify-development-window.mjs
```

Run on a logged-in macOS desktop with Screen Recording granted to the actual
execution host. The script compiles a dedicated AppKit fixture with two windows,
starts the real MCP stdio runtime with isolated configuration/audit paths,
and answers its approval requests from test code. It prints a temporary
evidence directory containing `selected.png`, `report.json`, and the isolated
audit state. Only the fixture and test runtime are terminated afterward.

## Limitations

Window IDs, PIDs and titles are checked before and after the OS capture call;
this is not an atomic guarantee against ID/PID reuse. Minimized/off-screen
windows may not be enumerated. Real Simulator/device selection, physical
device control, app building, automatic visual assertions and broad development
coverage are not established by a two-window fixture. Configuration readiness
also does not establish successful capture or a correct screen state.
