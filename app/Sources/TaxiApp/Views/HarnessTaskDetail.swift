import SwiftUI

struct HarnessTaskDetail: View {
    let store: HarnessStore
    let task: HarnessTask
    let snapshot: HarnessSnapshot
    @State private var instruction = ""
    @State private var changeModel = false
    @State private var allowRouting = false
    @State private var usePhasePreference = true
    @State private var handoffPhase = "검증"

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 10) {
                Text(task.phase + " · " + L("dashboard.state." + (task.status ?? "not-started")))
                    .font(.subheadline).foregroundStyle(.secondary)
                Text(task.originalRequest).font(.title2.bold()).textSelection(.enabled)
                if let parent = task.parentId {
                    Button(L("harness.parent")) { store.selectedTaskID = parent }.buttonStyle(.link)
                }
            }
            contextLines(L("dashboard.criteriaLabel"), task.completionCriteria)
            if !task.decisions.isEmpty || !task.openQuestions.isEmpty || !task.evidenceRefs.isEmpty || task.handoff != nil {
                DisclosureGroup(L("dashboard.savedContext")) {
                    VStack(alignment: .leading, spacing: 12) {
                        if !task.decisions.isEmpty { contextLines(L("harness.decisions"), task.decisions) }
                        if !task.openQuestions.isEmpty { contextLines(L("harness.questions"), task.openQuestions) }
                        if !task.evidenceRefs.isEmpty { contextLines(L("harness.evidence"), task.evidenceRefs) }
                        if let handoff = task.handoff { Text(handoff).font(.callout).textSelection(.enabled) }
                    }.padding(.top, 12)
                }
            }
            Divider()
            if !runs.isEmpty {
                Text(L("dashboard.results")).font(.title3.bold())
                ForEach(runs) { run in runDetail(run) }
            }
            execution
            Divider()
            DisclosureGroup(L("dashboard.splitSession")) {
                VStack(alignment: .leading, spacing: 12) {
                    Text(L("dashboard.splitHelp")).foregroundStyle(.secondary)
                    TextField(L("dashboard.nextPhase"), text: $handoffPhase)
                    Button(L("harness.prepareHandoff")) {
                        Task { await store.handoff(task, phase: handoffPhase) }
                    }.disabled(store.busy || handoffPhase.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    ForEach(snapshot.tasks.filter { $0.parentId == task.id }) { child in
                        Button(child.phase + " · " + String(child.originalRequest.prefix(60))) { store.selectedTaskID = child.id }
                    }
                }.padding(.top, 12)
            }
        }
        .textFieldStyle(.roundedBorder)
        .onAppear { if runs.isEmpty { instruction = task.originalRequest } }
    }

    private var runs: [HarnessRun] { snapshot.runs.filter { $0.taskId == task.id }.reversed() }

    private var execution: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(runs.isEmpty ? L("dashboard.firstRun") : L("dashboard.continueRun")).font(.title3.bold())
            HarnessConnectionNotice(store: store, provider: snapshot.provider)
            TextField(L("harness.instruction"), text: $instruction, axis: .vertical).lineLimit(3...8)
                .accessibilityIdentifier("dashboard.instruction")
            DisclosureGroup(L("dashboard.runOptions")) {
                VStack(alignment: .leading, spacing: 10) {
                    Toggle(L("dashboard.phasePreference"), isOn: $usePhasePreference)
                    Toggle(L("harness.changeModel"), isOn: $changeModel).disabled(task.threadId == nil)
                    Toggle(L("harness.allowRouting"), isOn: $allowRouting).disabled(changeModel || !snapshot.settings.taskSavingsEnabled)
                }.padding(.top, 8)
            }
            Text(L("harness.runScope")).font(.caption).foregroundStyle(.secondary)
            HStack {
                Button(L("harness.run")) {
                    Task { await store.run(task, prompt: instruction, changeModel: changeModel,
                                           allowRouting: allowRouting, usePhasePreference: usePhasePreference) }
                }
                .buttonStyle(.borderedProminent).controlSize(.large)
                .disabled(store.busy || snapshot.busy || instruction.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                          || !snapshot.provider.installed || snapshot.provider.authentication == "login-required")
                .accessibilityIdentifier("dashboard.run")
                if snapshot.busy { ProgressView().controlSize(.small); Text(L("dashboard.runInProgress")).foregroundStyle(.secondary) }
            }
        }
    }

    private func contextLines(_ title: String, _ lines: [String]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.headline)
            Text(lines.isEmpty ? "—" : lines.joined(separator: "\n")).textSelection(.enabled)
        }
    }

    private func runDetail(_ run: HarnessRun) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if !run.output.isEmpty { Text(run.output).textSelection(.enabled) }
            if let error = run.event.errorCode { Label(error, systemImage: "exclamationmark.circle").foregroundStyle(.orange) }
            Text(L("harness.criteriaUnverified")).font(.caption).foregroundStyle(.secondary)
            DisclosureGroup(L("dashboard.executionDetails")) {
                VStack(alignment: .leading, spacing: 6) {
                    Text(run.event.phase)
                    if let selection = run.modelSelection { Text("\(selection.phase) · \(selection.status) · \(selection.reason)") }
                    Text(L("harness.saved") + ": \(run.settings.model) / \(run.settings.effort)")
                    Text(L("harness.requested") + ": \(run.event.from) / \(run.event.requestedEffort ?? "—")")
                    Text((run.dispatched ? L("harness.sent") : L("harness.notSent")) + ": \(run.event.to) / \(run.event.reasoningEffort ?? "—")")
                    Text(L("harness.acknowledged") + ": \(run.acknowledgedModel ?? "—")")
                    Text(L("harness.responseModel") + ": \(run.event.responseModel ?? L("harness.unverified"))")
                    if let threadId = task.threadId { Text("Codex: " + threadId) }
                }.font(.caption).textSelection(.enabled).padding(.top, 8)
            }
        }
        .padding(16).frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
    }
}
