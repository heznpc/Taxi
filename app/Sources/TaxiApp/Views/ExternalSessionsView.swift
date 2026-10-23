import SwiftUI
import UniformTypeIdentifiers

struct ExternalSessionsView: View {
    let store: HarnessStore
    let snapshot: HarnessSnapshot
    @State private var importing = false
    @State private var query = ""
    @State private var selectedKey: String?
    @State private var parentKey = ""
    @State private var phase = "조사"
    @State private var evidence = ""
    @State private var registeredBy = "user"
    @State private var page = 0

    private var filtered: [HarnessExternalSession] {
        snapshot.externalSessions.filter { query.isEmpty || [$0.title, $0.provider, $0.profileKey, $0.providerSessionId, $0.workspacePath].compactMap { $0 }.joined(separator: " ").localizedCaseInsensitiveContains(query) }
    }
    var body: some View {
        GroupBox(L("dashboard.external")) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Button(L("dashboard.import")) { importing = true }.disabled(store.busy)
                    Text("\(snapshot.externalSessions.count) " + L("dashboard.sessions"))
                }
                Text(L("dashboard.observeOnly")).font(.caption).foregroundStyle(.secondary)
                if let receipt = snapshot.catalogImports.first {
                    Text("\(receipt.source) · \(receipt.generatedAt) · \(receipt.freshness)").font(.caption).textSelection(.enabled)
                    Text(L("dashboard.imported") + ": " + receipt.importedAt).font(.caption)
                    if !receipt.scan.complete || receipt.scan.truncated || !receipt.scan.errors.isEmpty {
                        Text(L("dashboard.incomplete")).foregroundStyle(.orange)
                        ForEach(receipt.scan.errors, id: \.self) { Text($0).font(.caption).textSelection(.enabled) }
                    }
                }
                if snapshot.externalSessions.isEmpty {
                    ContentUnavailableView {
                        Label(L("dashboard.externalEmpty"), systemImage: "tray")
                    } description: {
                        Text(L("dashboard.externalHelp"))
                    }
                } else {
                    TextField(L("dashboard.search"), text: $query).textFieldStyle(.roundedBorder).onChange(of: query) { page = 0 }
                    if filtered.isEmpty { Text(L("dashboard.noMatches")).foregroundStyle(.secondary).padding(.vertical, 16) }
                }
                ForEach(Array(filtered.dropFirst(page * 25).prefix(25))) { session in
                    Button { selectedKey = session.key } label: {
                        HStack {
                            Text(session.title ?? session.providerSessionId ?? session.key).lineLimit(1)
                            Spacer()
                            Text(session.provider + " · " + L("harness.unverified")).foregroundStyle(.secondary)
                        }.contentShape(Rectangle())
                    }.buttonStyle(.plain)
                }
                if filtered.count > 25 {
                    HStack {
                    Button(L("dashboard.previous")) { page -= 1 }.disabled(page == 0)
                    Text("\(page + 1) / \(max(1, (filtered.count + 24) / 25))").font(.caption)
                    Button(L("dashboard.next")) { page += 1 }.disabled((page + 1) * 25 >= filtered.count)
                }
                }
                if let session = snapshot.externalSessions.first(where: { $0.key == selectedKey }) { detail(session) }
                if let taskID = store.selectedTaskID {
                    ForEach(snapshot.sessionLinks.filter { $0.taskId == taskID }) { link in
                        VStack(alignment: .leading) {
                            Text(link.phase + " · " + link.registeredBy).font(.caption.bold())
                            Text((link.parentSessionKey ?? "—") + " → " + link.sessionKey).font(.caption).textSelection(.enabled)
                            Text(link.evidence).font(.caption).textSelection(.enabled)
                        }
                    }
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
            do {
                let url = try result.get()
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                guard size <= 16 * 1024 * 1024 else { throw CocoaError(.fileReadTooLarge) }
                let data = try Data(contentsOf: url)
                Task { await store.importCatalog(data) }
            } catch { store.error = error.localizedDescription }
        }
    }
    private func detail(_ session: HarnessExternalSession) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Divider()
            Text(session.title ?? session.providerSessionId ?? session.key).font(.headline).textSelection(.enabled)
            Text(L("dashboard.owner") + ": " + session.provider + " · " + L("dashboard.observeOnly")).font(.caption)
            Text("Key: " + session.key).font(.caption).textSelection(.enabled)
            Text("Profile: " + (session.profileKey ?? L("harness.unverified"))).font(.caption).textSelection(.enabled)
            Text(session.workspacePath ?? "—").font(.caption).textSelection(.enabled)
            Text(L("dashboard.lastActivity") + ": " + (session.lastActivityAt ?? "—")).font(.caption)
            Text("\(session.source) / \(session.provenance) · \(session.catalogGeneratedAt) · \(session.freshness)").font(.caption)
            if !session.presentInLatestImport { Text(L("dashboard.absentLatest")).foregroundStyle(.orange).font(.caption) }
            if let appURL = originalApp(session.provider) {
                Button(L("dashboard.openApp")) { NSWorkspace.shared.openApplication(at: appURL, configuration: .init()) { _, _ in } }
                Text(L("dashboard.openAppScope")).font(.caption).foregroundStyle(.secondary)
            }
            DisclosureGroup(L("dashboard.link")) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(L("dashboard.linkScope")).font(.caption)
                    Picker(L("harness.task"), selection: Binding(get: { store.selectedTaskID }, set: { store.selectedTaskID = $0 })) {
                        Text(L("harness.selectTask")).tag(String?.none)
                        ForEach(snapshot.tasks) { Text(String($0.originalRequest.prefix(70))).tag(Optional($0.id)) }
                    }
                    TextField(L("dashboard.parentKey"), text: $parentKey)
                    TextField(L("dashboard.phase"), text: $phase)
                    TextField(L("harness.evidence"), text: $evidence, axis: .vertical)
                    Picker(L("dashboard.registeredBy"), selection: $registeredBy) {
                        Text(L("dashboard.user")).tag("user")
                        Text(L("dashboard.authorizedParent")).tag("authorized-parent-session")
                    }
                    Button(L("dashboard.link")) {
                        guard let taskID = store.selectedTaskID else { return }
                        Task { await store.link(taskID: taskID, sessionKey: session.key,
                            parentSessionKey: parentKey.isEmpty ? nil : parentKey, phase: phase, evidence: evidence, registeredBy: registeredBy) }
                    }.disabled(store.busy || store.selectedTaskID == nil || phase.isEmpty || evidence.isEmpty)
                }.textFieldStyle(.roundedBorder)
            }
        }
    }
    private func originalApp(_ provider: String) -> URL? {
        // Fixed allowlist opens the application only. Imported titles/paths/IDs are never executed.
        let bundle: String?
        switch provider.lowercased() {
        case "codex": bundle = "com.openai.codex"
        case "claude-desktop": bundle = "com.anthropic.claudefordesktop"
        default: bundle = nil
        }
        return bundle.flatMap { NSWorkspace.shared.urlForApplication(withBundleIdentifier: $0) }
    }
}
