import SwiftUI

struct HarnessSettingsView: View {
    @Bindable var store: HarnessStore
    let snapshot: HarnessSnapshot
    @State private var preferencePhase = "구현"

    var body: some View {
        VStack(alignment: .leading, spacing: 24) {
            Text(L("dashboard.executionSettings")).font(.largeTitle.bold())
            HarnessConnectionNotice(store: store, provider: snapshot.provider)
            settings
            DisclosureGroup(L("harness.status")) { status(snapshot) }
        }
    }
    private func status(_ snapshot: HarnessSnapshot) -> some View {
        GroupBox(L("harness.status")) {
            VStack(alignment: .leading, spacing: 8) {
                Text("\(snapshot.core.name) \(snapshot.core.version)")
                Text(snapshot.provider.installed ? L("harness.codexInstalled") : L("harness.codexMissing"))
                Text(L("harness.authentication") + ": " + snapshot.provider.authentication).font(.caption)
                Text(L("harness.loginHelp"))
                Text("CODEX_HOME='\(snapshot.provider.home)' codex login").font(.caption.monospaced()).textSelection(.enabled)
                Text(L("harness.ownership")).font(.caption).foregroundStyle(.secondary)
                HStack {
                    Text(L("harness.usage") + ": " + snapshot.usageStatus)
                    Button(L("harness.collect")) { Task { await store.collectUsage() } }
                        .disabled(store.busy || !snapshot.settings.usageEnabled)
                    Button(L("trust.refresh")) { Task { await store.refresh() } }.disabled(store.busy)
                }
                ForEach(snapshot.usage) { usage in
                    HStack {
                        Text(usage.label)
                        Text(usage.usedPercent.map { String(format: "%.1f%%", $0) } ?? L("harness.unverified"))
                        Text(Date(timeIntervalSince1970: usage.observedAtMs / 1000), style: .time).foregroundStyle(.secondary)
                    }
                }
            }.frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private var settings: some View {
        GroupBox(L("harness.settings")) {
            VStack(alignment: .leading, spacing: 10) {
                if let settings = store.settings {
                    Toggle(L("harness.usageConsent"), isOn: setting(\.usageEnabled, settings.usageEnabled))
                    Toggle(L("harness.savings"), isOn: setting(\.taskSavingsEnabled, settings.taskSavingsEnabled))
                    HStack {
                        TextField(L("harness.model"), text: setting(\.model, settings.model))
                        Picker(L("harness.effort"), selection: setting(\.effort, settings.effort)) {
                            ForEach(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"], id: \.self) { Text($0) }
                        }
                    }
                    HStack {
                        TextField(L("dashboard.phase"), text: $preferencePhase)
                        Button(L("dashboard.savePhase")) {
                            store.settings?.phasePreferences[preferencePhase] = HarnessModelPreference(model: settings.model, effort: settings.effort)
                            Task { await store.saveSettings() }
                        }.disabled(preferencePhase.isEmpty || store.busy)
                    }
                    ForEach(settings.phasePreferences.keys.sorted(), id: \.self) { key in
                        if let value = settings.phasePreferences[key] { Text("\(key): \(value.model) / \(value.effort)").font(.caption) }
                    }
                    Toggle(L("harness.compaction"), isOn: setting(\.compactionEnabled, settings.compactionEnabled))
                    HStack {
                        TextField(L("harness.fromModel"), text: setting(\.compactionFrom, settings.compactionFrom))
                        Text("→")
                        TextField(L("harness.toModel"), text: setting(\.compactionTo, settings.compactionTo))
                    }
                    Text(L("harness.compactionPending")).font(.caption).foregroundStyle(.secondary)
                    Button(L("harness.save")) { Task { await store.saveSettings() } }.disabled(store.busy)
                }
            }.textFieldStyle(.roundedBorder).frame(maxWidth: .infinity, alignment: .leading)
        }
    }
    private func setting<T>(_ keyPath: WritableKeyPath<HarnessSettings, T>, _ fallback: T) -> Binding<T> {
        Binding(get: { store.settings?[keyPath: keyPath] ?? fallback }, set: { store.settings?[keyPath: keyPath] = $0 })
    }
}
