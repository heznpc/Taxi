import SwiftUI

struct HarnessTaskDraft {
    var original = ""
    var criteria = ""
    var decisions = ""
    var questions = ""
    var evidence = ""
    var phase = "구상"
}

struct HarnessTaskComposer: View {
    let store: HarnessStore
    let snapshot: HarnessSnapshot
    @Binding var draft: HarnessTaskDraft
    @FocusState private var requestFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 8) {
                Text(L("dashboard.composeTitle")).font(.largeTitle.bold())
                Text(L("dashboard.composeHelp")).foregroundStyle(.secondary)
            }
            VStack(alignment: .leading, spacing: 10) {
                Text(L("dashboard.requestLabel")).font(.headline)
                TextField(L("dashboard.requestPlaceholder"), text: $draft.original, axis: .vertical)
                    .lineLimit(5...10).focused($requestFocused)
                    .accessibilityIdentifier("dashboard.request")
            }
            VStack(alignment: .leading, spacing: 10) {
                Text(L("dashboard.criteriaLabel")).font(.headline)
                TextField(L("dashboard.criteriaPlaceholder"), text: $draft.criteria, axis: .vertical)
                    .lineLimit(2...4)
                    .accessibilityIdentifier("dashboard.criteria")
            }
            DisclosureGroup(L("dashboard.moreContext")) {
                VStack(alignment: .leading, spacing: 12) {
                    TextField(L("dashboard.phase"), text: $draft.phase)
                    TextField(L("harness.decisions"), text: $draft.decisions, axis: .vertical)
                    TextField(L("harness.questions"), text: $draft.questions, axis: .vertical)
                    TextField(L("harness.evidence"), text: $draft.evidence, axis: .vertical)
                }.padding(.top, 12)
            }
            HStack(spacing: 12) {
                Button(L("dashboard.createAndContinue")) {
                    Task {
                        let saved = await store.create(original: draft.original, decisions: draft.decisions, questions: draft.questions,
                                           criteria: draft.criteria, evidence: draft.evidence, phase: draft.phase)
                        if saved { draft = HarnessTaskDraft() }
                    }
                }
                .buttonStyle(.borderedProminent).controlSize(.large)
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(store.busy || [draft.original, draft.criteria, draft.phase].contains { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
                .accessibilityIdentifier("dashboard.create")
                Text(L("dashboard.createHelp")).font(.caption).foregroundStyle(.secondary)
            }
            Divider()
            HarnessConnectionNotice(store: store, provider: snapshot.provider)
        }
        .textFieldStyle(.roundedBorder)
        .onAppear { requestFocused = true }
    }
}
