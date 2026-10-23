import SwiftUI
import AppKit

struct HarnessConnectionNotice: View {
    let store: HarnessStore
    let provider: HarnessSnapshot.Provider
    @State private var copied = false

    var body: some View {
        if !provider.installed {
            Label(L("harness.codexMissing"), systemImage: "arrow.down.circle")
                .foregroundStyle(.secondary)
        } else if provider.authentication == "login-required" {
            VStack(alignment: .leading, spacing: 10) {
                Label(L("dashboard.loginTitle"), systemImage: "person.crop.circle.badge.exclamationmark")
                    .font(.headline)
                Text(L("dashboard.loginHelp")).font(.callout).foregroundStyle(.secondary)
                DisclosureGroup(L("dashboard.loginSteps")) {
                    VStack(alignment: .leading, spacing: 10) {
                        Text(L("harness.loginHelp")).font(.callout)
                        Text(command).font(.caption.monospaced()).textSelection(.enabled)
                        HStack {
                            Button(copied ? L("dashboard.commandCopied") : L("dashboard.copyLogin")) {
                                NSPasteboard.general.clearContents()
                                NSPasteboard.general.setString(command, forType: .string)
                                copied = true
                                if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: "com.apple.Terminal") {
                                    NSWorkspace.shared.openApplication(at: url, configuration: .init()) { _, _ in }
                                }
                            }
                            Button(L("dashboard.checkLogin")) { Task { await store.refresh() } }.disabled(store.busy)
                        }
                    }.padding(.top, 8)
                }
            }
            .padding(16)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(.quaternary, in: RoundedRectangle(cornerRadius: 12))
        }
    }

    private var command: String {
        let quotedHome = "'" + provider.home.replacingOccurrences(of: "'", with: "'\"'\"'") + "'"
        return "CODEX_HOME=\(quotedHome) codex login"
    }
}
