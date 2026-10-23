# Taxi Workflow Guide

Taxi is useful when an AI client needs to work across your Apple workspace, not just answer a question about one app. The product shape is:

- The macOS Shortcuts action library can be an Apple-native front door; iOS preview builds can additionally expose App Shortcuts and Siri phrases.
- Claude, Codex, Cursor, Raycast, and other MCP clients can be the external agent brain.
- Taxi supplies the local action runtime: Apple app access, workflow skills, semantic memory, approvals for sensitive actions, audit logs, rate limits, and OAuth scopes.

This is not positioned as a Siri replacement. Taxi gives MCP clients and macOS Shortcuts actions governed access across Notes, Calendar, Reminders, Mail, Safari, Finder, Contacts, and the Swift-backed Apple frameworks.

## Target Users

**Apple workspace power users**

People who already keep their calendar, notes, reminders, mail, files, contacts, and Safari context inside Apple apps. They do not need a new productivity database; they need a safe agent layer over the data they already use.

**Agent-native developers and operators**

People who live in Codex, Claude Code, Cursor, Raycast, or terminal agents and want those agents to act on local Apple context without writing one-off AppleScript glue for every task.

**Privacy-sensitive prosumers**

People who are willing to use cloud AI clients, but want local controls around what gets read, what gets written, what requires approval, and what remains auditable after the fact.

## First-Class Workflows

These are the workflows Taxi should make obvious in product, docs, demos, and registry copy.

| Workflow | Type | Required modules | Core tools and skills | Safety shape |
| --- | --- | --- | --- | --- |
| Today Overview | prompt-recipe | `calendar`, `reminders` | `today_events`, `list_reminders` | Starter-safe and read-only; it never writes data. |
| Daily Briefing | built-in-skill | `calendar`, `reminders`, `mail`, `notes` | `skill_daily-briefing`, `summarize_context`, `today_events`, `list_reminders`, `get_unread_count`, `list_notes` | Read-only by default; saving a note or reminder is a separate write action. |
| Inbox Triage | built-in-skill | `mail`, `reminders` | `skill_inbox-triage`, `skill_sender-to-tasks`, `search_messages`, `create_reminder` | Reads mail first; reminder creation is auditable and prompts per call at the default HITL level. |
| Meeting Prep | prompt-recipe | `calendar`, `notes`, `contacts`, `finder`, `reminders` | `today_events`, `search_notes`, `search_contacts`, `recent_files`, `list_reminders` | Read-only prep flow; agenda or task creation is an explicit follow-up write. |
| Project Digest | built-in-skill | `memory`, `notes`, `calendar`, `reminders`, `mail`, `finder` | `semantic_index`, `skill_project-digest`, `semantic_search`, `find_related` | Digest is read-only after indexing; indexing writes only to Taxi's local semantic store. |
| Focus Blocks | built-in-skill | `reminders`, `calendar` | `skill_focus-block-planner`, `list_reminders`, `create_event` | Calendar writes are non-destructive but sensitive, so each created event prompts at the default HITL level. |
| Research to Output | prompt-recipe | `safari`, `intelligence`, `notes`, `mail` | `list_tabs`, `read_page_content`, `summarize_text`, `create_note`, `send_mail` | Reading and summarizing are read-only. Sending or saving output is a separate HITL-gated action. |

| Development Window Check | prompt-recipe | `screen` | `setup_permissions`, `list_windows`, `capture_window` | Requires Screen Recording and runtime approvals; the connected AI compares the selected window image with the expected state. |

## Copyable Prompts

- **Today Overview**: "Tell me today's calendar events and overdue reminders. Do not change anything."
- **Daily Briefing**: "Brief me on today's calendar, overdue reminders, unread mail, and recent notes."
- **Inbox Triage**: "Find emails from Alex about the project and create reminders for action items."
- **Meeting Prep**: "For my next meeting, find related notes, contacts, files, and reminders."
- **Project Digest**: "Summarize what changed since yesterday on my current project."
- **Focus Blocks**: "Plan focus blocks for today's open reminders, but ask before creating each event."
- **Research to Output**: "Open the Apple developer docs in Safari, summarize the page, and draft a note."

- **Development Window Check**: "Check the expected screen state of my development app. Ask for the app/window and expected state if missing. Run setup_permissions with system_only true; if Screen Recording is denied or unknown, explain the reported recovery steps and stop. List windows with captureTargets true. If multiple windows match, ask me to select one. Pass all three fields of its target (windowId, ownerPid, title) to capture_window. On a stale target, list again and confirm the selection. Compare the returned image with the expected state and report observed evidence, uncertainties, target, timestamp, and hash. Capturing an image alone does not verify the result."

## Development Window Check

Enable the Screen module in Taxi, then copy `taxi workflows development-window-check --prompt` into a connected AI client. The recipe uses the existing permission diagnosis and approval path. `system_only: true` avoids unrelated Apple-app Automation prompts. Accessibility and Full Disk Access are reported but are not prerequisites for this CoreGraphics capture route. A denied or unknown Screen Recording result stops the recipe; use the returned settings guidance and retry after granting permission.

`list_windows({captureTargets: true})` returns CoreGraphics window IDs, owner PIDs and titles. Pass all three fields of the `target` object as `capture_window({windowId, ownerPid, title})`; this avoids guessing among multiple Simulator or app windows and does not activate another app. A missing or changed target fails without selecting another window. Identity is checked before and after capture; these checks are not an atomic OS guarantee against window ID/PID reuse. Minimized or off-screen windows may need to be made visible and listed again.

The image response includes dimensions, capture time and a SHA-256 hash of the returned PNG. These identify the evidence; they do not establish that the UI is correct. The AI must compare visible content with a stated expectation and report uncertainty. This recipe does not provide device control, app building or an automatic visual assertion engine. Workflow readiness covers module/tool availability, not permissions, approval delivery, successful capture or restart persistence.

See [implementation evidence and remaining checks](development-window-verification.md) for the native fixture reproduction and the limits of the current validation.

## How Users Run Them

```bash
taxi workflows
taxi workflows today-overview --prompt
taxi workflows daily-briefing --prompt
taxi workflows meeting-prep --modules
taxi workflows inbox-triage --tools
taxi workflows --readiness
taxi workflows --readiness --json
taxi workflows project-digest --json
```

The CLI prints the same curated workflow catalog that the macOS menubar app exposes under **Workflows**. The Mac app includes a copyable MCP prompt, core tools, and a safety note; optional Siri metadata is for iOS/launcher integrations only.

Use a workflow id with `--prompt`, `--siri`, `--tools`, `--modules`, `--safety`, or `--json` when you want only one field for a shell script, launcher, onboarding screen, or agent prompt. `--readiness` checks profile, bundled module-pack, and write opt-in readiness without launching the live server; the MCP `workflow_readiness` tool checks live tool registration inside the active runtime.

For the governed first success, run
`taxi workflows today-overview --prompt` and paste the result into a
connected MCP client. This exercises client authorization and records the MCP
tool calls in Taxi's audit path.

The optional `--preview` mode is a direct-local diagnostic, not workflow
execution. It bypasses MCP governance and Taxi audit logging. Use it only to
debug local Calendar or Reminders access:

```bash
taxi workflows today-overview --preview
taxi workflows daily-briefing --preview
```

Every diagnostic preview first checks the active profile and bundled module
packs. `today-overview --preview` returns only a bounded set of
today's calendar events and reminders due before the current instant. It does
not include reminders due later today, undated reminders, or aggregate
incomplete-reminder counts. `daily-briefing --preview` keeps the broader local
snapshot behavior and fails with a readiness explanation instead of reading
Mail when Mail is not enabled.

For Codex:

```bash
codex mcp add --env TAXI_HTTP_TOKEN=<token> taxi -- npx -y @heznpc/taxi@1.0.0 connect --url http://127.0.0.1:3848/mcp
```

For Claude Code:

```bash
claude mcp add --env TAXI_HTTP_TOKEN=<token> taxi -- npx -y @heznpc/taxi@1.0.0 connect --url http://127.0.0.1:3848/mcp
```

Current client setup still stores the owner-only persistent token for
backward-compatible configuration detection and repair. On the canonical app
endpoint, `connect` verifies the signed bundle and live app/Node processes,
replaces that credential with a process-generation bearer, and authenticates
each MCP response with a fresh nonce-bound MAC; it never forwards the persistent
token to the listener. The `0600` credential files isolate other Unix users,
not a hostile process already running under the same macOS account.

For the platform split, see [shortcuts.md](shortcuts.md). macOS exposes App Intent actions but no App Shortcuts provider. The exact eight-action phrase provider is iOS-only; `AskTaxiIntent` is a separate opt-in Foundation Models action for supported macOS/iOS builds that define `TAXI_ENABLE_FOUNDATION_MODELS`, and is not advertised by that provider.

## What Exists Today

- Shared workflow catalog SSOT: `src/shared/workflows-catalog.json`
- CLI workflow renderer and preview runner: `src/cli/workflows.ts`
- Menubar Workflows menu: `app/Sources/TaxiApp/Views/MenuContent.swift`
- Built-in workflow skills: `src/skills/builtins/*.yaml`
- Workflow safety annotations for exposed skills: `src/skills/types.ts`, `src/skills/register.ts`
- Auto-generated App Intents plus an iOS-only workflow-first App Shortcuts provider: `scripts/gen-swift-intents.mjs`
- Codex setup support: `src/cli/codex-mcp.ts`, `src/cli/setup.ts`, `src/cli/doctor.ts`

## Product Direction

The next product work should improve access and confidence around these workflows, rather than adding another broad batch of low-level tools.

- Make the first-run experience ask "what workflow do you want Taxi for?" instead of only "which modules do you want?"
- Let the menubar app run or copy workflows for specific clients: Codex, Claude, Cursor, Raycast, and Shortcuts.
- Keep required approvals scoped to the individual gated call. Do not solve approval fatigue by silently broadening approval scope; improve prompt wording, grouping, and denial recovery instead.
- Make audit review human-readable for workflow runs, not just individual tool calls.
- Treat FoundationModels host mode as preview until the Swift toolchain and platform APIs are stable enough for default builds.
