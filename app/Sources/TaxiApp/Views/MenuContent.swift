import SwiftUI
import AppKit

// MARK: - Localization Helper

func L(_ key: String) -> String {
    let localized = Bundle.moduleResources.localizedString(forKey: key, value: nil, table: nil)
    if localized != key { return localized }

    guard let path = Bundle.moduleResources.path(forResource: "en", ofType: "lproj"),
          let englishBundle = Bundle(path: path)
    else { return key }
    return englishBundle.localizedString(forKey: key, value: key, table: nil)
}

func L(_ key: String, _ args: CVarArg...) -> String {
    String(format: L(key), arguments: args)
}

// MARK: - Shared Constants

enum TaxiConstants {
    static let npmPackageName = "@heznpc/taxi"
    static let npmPackageVersion = "1.0.0"
    static var npmPackageSpecifier: String {
        ProcessInfo.processInfo.environment["TAXI_NPM_PACKAGE_SPECIFIER"]
            ?? "\(npmPackageName)@\(npmPackageVersion)"
    }
    static let mcpProtocolVersion = "2025-11-25"
    static var appOwnedHttpPort: Int {
        #if TAXI_ACCEPTANCE_HARNESS
        let environment = ProcessInfo.processInfo.environment
        if environment[envForceAppRuntime] == "1",
           let rawPort = environment[envAppRuntimePort],
           let port = Int(rawPort),
           (1024...65535).contains(port) {
            return port
        }
        #endif
        return 3848
    }
    static let appOwnedHttpURL = "http://127.0.0.1:\(appOwnedHttpPort)/mcp"
    static let appOwnedHealthURL = "http://127.0.0.1:\(appOwnedHttpPort)/health"
    static let appOwnedIdentityChallengeURL = "http://127.0.0.1:\(appOwnedHttpPort)/app/identity-challenge"
    static let appOwnedRuntimeStateURL = "http://127.0.0.1:\(appOwnedHttpPort)/app/runtime-state"
    static let keyAutoStart = "autoStartServer"
    static let keyOnboardingCompleted = "onboardingCompleted"
    static let keyOnboardingPresented = "onboardingPresented"
    static let keyOnboardingStep = "onboardingCurrentStep"
    static let keyOnboardingDraft = "onboardingDraft"
    static let envForceAppRuntime = "TAXI_FORCE_APP_RUNTIME"
    static let envAppRuntimePort = "TAXI_APP_RUNTIME_PORT"
    static let envShowOnboarding = "TAXI_SHOW_ONBOARDING"
    static let trustCenterWindowID = "trust-center"

    private static var bundledRuntimeRoot: URL? {
        Bundle.main.resourceURL?.appendingPathComponent("taxi", isDirectory: true)
    }

    static var bundledNodePath: String? {
        guard let path = bundledRuntimeRoot?.appendingPathComponent("runtime/bin/node").path,
              FileManager.default.isExecutableFile(atPath: path)
        else { return nil }
        return path
    }

    static var bundledServerEntryPath: String? {
        guard let path = bundledRuntimeRoot?.appendingPathComponent("server/dist/index.js").path,
              FileManager.default.fileExists(atPath: path)
        else { return nil }
        return path
    }

    static var bundledBridgePath: String? {
        guard let path = bundledRuntimeRoot?.appendingPathComponent("bin/TaxiBridge").path,
              FileManager.default.isExecutableFile(atPath: path)
        else { return nil }
        return path
    }

    static var bundledServerRuntime: (node: String, entry: String)? {
        guard let node = bundledNodePath, let entry = bundledServerEntryPath else { return nil }
        return (node, entry)
    }

    static var appOwnedProxyCommand: String {
        bundledServerRuntime?.node ?? "npx"
    }

    static var appOwnedProxyArgs: [String] {
        if let runtime = bundledServerRuntime {
            return [runtime.entry, "connect", "--url", appOwnedHttpURL]
        }
        return ["-y", npmPackageSpecifier, "connect", "--url", appOwnedHttpURL]
    }

    static func appOwnedProxyEntry(token: String) -> [String: Any] {
        [
            "command": appOwnedProxyCommand,
            "args": appOwnedProxyArgs,
            "env": [
                "TAXI_HTTP_TOKEN": token,
            ],
        ]
    }

    static func tokenForConfig() -> String {
        (try? AppRuntimeToken.ensure()) ?? "<token>"
    }

    static func claudeDesktopConfig() -> String {
        let token = tokenForConfig()
        let object: [String: Any] = ["mcpServers": ["taxi": appOwnedProxyEntry(token: token)]]
        guard let data = try? JSONSerialization.data(withJSONObject: object, options: [.prettyPrinted, .sortedKeys])
        else { return "{}" }
        return String(data: data, encoding: .utf8) ?? "{}"
    }

    static func claudeCodeConfig() -> String {
        commandLine(client: "claude")
    }

    static func codexConfig() -> String {
        commandLine(client: "codex")
    }

    private static func commandLine(client: String) -> String {
        let command = ([appOwnedProxyCommand] + appOwnedProxyArgs).map(shellQuoted).joined(separator: " ")
        return "\(client) mcp add --env \(shellQuoted("TAXI_HTTP_TOKEN=\(tokenForConfig())")) taxi -- \(command)"
    }

    private static func shellQuoted(_ value: String) -> String {
        "'" + value.replacingOccurrences(of: "'", with: "'\\''") + "'"
    }

    static func copyToClipboard(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}

// MARK: - Tool Count Helpers

private func activeToolCount(disabledModules: [String]) -> Int {
    allModules
        .filter { !disabledModules.contains($0.id) && $0.isAvailableOnCurrentOS }
        .reduce(0) { $0 + $1.toolCount }
}

private func disabledModuleCount(disabledModules: [String]) -> Int {
    allModules.filter { disabledModules.contains($0.id) }.count
}

// MARK: - Menu Content

struct MenuContent: View {
    @Environment(\.openWindow) private var openWindow
    let serverManager: ServerManager
    let permissionManager: PermissionManager
    let configManager: ConfigManager
    let setupManager: SetupManager
    let hitlManager: HitlManager
    let logManager: LogManager
    let updateManager: UpdateManager
    let onShowOnboarding: () -> Void

    var body: some View {
        Group {
            // ── 1. Server Status ────────────────────────────────
            serverStatusSection

            Divider()

            // ── 2. Update & Quick Setup ────────────────────────
            updateSection
            quickSetupSection

            // ── 3. Workflows ───────────────────────────────────
            workflowsSection

            // ── 4. Modules ─────────────────────────────────────
            modulesSection

            // ── 5. Swift Bridge ────────────────────────────────
            swiftBridgeStatus

            Divider()

            // ── 6. Settings ────────────────────────────────────
            settingsMenu

            Divider()

            // ── 7. Logs ────────────────────────────────────────
            logsMenu

            // ── 8. Configuration & Help ────────────────────────
            configSection

            Divider()

            // ── 9. Footer ──────────────────────────────────────
            footerSection
        }
    }

    // MARK: 1 - Server Status

    @ViewBuilder
    private var serverStatusSection: some View {
        Label(serverManager.statusLabel, systemImage: serverManager.statusIcon)
            .foregroundStyle(serverStatusColor)

        toolCountLabel

        serverControlButton

        Button(L("menu.refreshStatus")) {
            serverManager.checkStatus()
        }
        .keyboardShortcut("r")

        Button(L("dashboard.title")) {
            openWindow(id: "task-dashboard")
        }.keyboardShortcut("t")

        Button(L("menu.trustCenter")) {
            openWindow(id: TaxiConstants.trustCenterWindowID)
        }
    }

    @ViewBuilder
    private var serverControlButton: some View {
        // Ownership wins over the last health probe. If the app's child is
        // still alive but HTTP/auth readiness has degraded, the user must keep
        // a working Stop control instead of seeing a Start action that the
        // live-process guard will reject.
        if serverManager.canStopRuntime {
            Button {
                serverManager.stopServer()
            } label: {
                Label(L("menu.stopServer"), systemImage: "stop.circle")
            }
        } else {
            switch serverManager.status {
            case .running:
                // Authenticated manual runtimes are visible and usable, but
                // their process lifecycle belongs to whoever launched them.
                Button {} label: {
                    Label(L("menu.stopServer"), systemImage: "stop.circle")
                }
                .disabled(true)
            case .stopped, .error:
                Button {
                    requestApprovalNotificationsForExplicitRuntimeStart()
                    serverManager.startServerFromExplicitUserAction()
                } label: {
                    Label(L("menu.startServer"), systemImage: "play.circle")
                }
            case .checking:
                Button(L("menu.checking")) {}
                    .disabled(true)
            }
        }
    }

    private var serverStatusColor: Color {
        switch serverManager.status {
        case .running: .green
        case .error: .red
        default: .secondary
        }
    }

    @ViewBuilder
    private var toolCountLabel: some View {
        let disabled = configManager.disabledModules
        let active = activeToolCount(disabledModules: disabled)
        let disabledCount = disabledModuleCount(disabledModules: disabled)

        if disabledCount > 0 {
            Label(
                L("menu.toolsAvailableDisabled", active, disabledCount),
                systemImage: "wrench.and.screwdriver"
            )
            .foregroundStyle(.secondary)
            .font(.caption)
        } else {
            Label(
                L("menu.toolsAvailable", active),
                systemImage: "wrench.and.screwdriver"
            )
            .foregroundStyle(.secondary)
            .font(.caption)
        }
    }

    // MARK: 2 - Update

    @ViewBuilder
    private var updateSection: some View {
        if let version = updateManager.availableVersion {
            Label(L("menu.updateAvailable", version), systemImage: "arrow.down.circle.fill")
                .foregroundStyle(.orange)

            if updateManager.isUpdating {
                Label(L("menu.updating"), systemImage: "progress.indicator")
                    .foregroundStyle(.secondary)
            } else {
                Button(L("menu.updateNow")) {
                    updateManager.performUpdate()
                }
            }

            if let error = updateManager.updateError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            Divider()
        }
    }

    // MARK: 2b - Quick Setup

    @ViewBuilder
    private var quickSetupSection: some View {
        let isStopped: Bool = {
            switch serverManager.status {
            case .stopped, .error: return true
            default: return false
            }
        }()
        let showGetStarted = isStopped
            && !setupManager.isRunning
            && setupManager.state == .idle

        if showGetStarted {
            Button {
                setupManager.runSetup(
                    permissionManager: permissionManager,
                    serverManager: serverManager,
                    hitlLevel: configManager.hitlLevel
                )
            } label: {
                Label(L("menu.getStarted"), systemImage: "sparkles")
            }

            Divider()
        }

        if let label = setupManager.progressLabel {
            if case .done = setupManager.state {
                Label(label, systemImage: "checkmark.seal.fill")
                    .foregroundStyle(.green)
                Divider()
            } else if case .failed = setupManager.state {
                Label(label, systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.red)
                Button(L("onboarding.firstRunCheckAgain")) {
                    setupManager.reset()
                    setupManager.runSetup(
                        permissionManager: permissionManager,
                        serverManager: serverManager,
                        hitlLevel: configManager.hitlLevel
                    )
                }
                Divider()
            } else {
                Label(label, systemImage: "progress.indicator")
                    .foregroundStyle(.secondary)
                Divider()
            }
        }
    }

    private func requestApprovalNotificationsForExplicitRuntimeStart() {
        guard RuntimeStartConsentPolicy.shouldRequestApprovalNotifications(
            hitlLevel: configManager.hitlLevel,
            userInitiated: true
        ) else { return }
        HitlManager.requestNotificationPermission()
    }

    // MARK: 3 - Workflows

    @ViewBuilder
    private var workflowsSection: some View {
        Menu(L("menu.workflows")) {
            Text(L("workflow.menuHint"))
                .font(.caption)
                .foregroundStyle(.secondary)

            Divider()

            ForEach(featuredWorkflows) { workflow in
                Menu {
                    Text(workflow.localizedDescription)
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    Text(workflow.safety)
                        .font(.caption)
                        .foregroundStyle(.secondary)

                    Divider()

                    Button(L("workflow.copyPrompt")) {
                        TaxiConstants.copyToClipboard(workflow.prompt)
                    }

                    Button(L("workflow.copyToolList")) {
                        TaxiConstants.copyToClipboard(workflow.tools.joined(separator: ", "))
                    }
                } label: {
                    Label(workflow.title, systemImage: workflow.icon)
                }
            }

            Divider()

            Button(L("workflow.openShortcutsDoc")) {
                if let url = URL(string: "https://github.com/heznpc/Taxi/blob/main/docs/shortcuts.md") {
                    NSWorkspace.shared.open(url)
                }
            }
        }
    }

    // MARK: 4 - Modules

    @ViewBuilder
    private var modulesSection: some View {
        Menu(L("menu.modules")) {
            modulePacksMenu
            Divider()
            ForEach(allModules) { module in
                moduleToggle(for: module)
            }
        }
    }

    @ViewBuilder
    private var modulePacksMenu: some View {
        Menu(L("modulePacks.menu")) {
            ForEach(allModulePacks) { pack in
                modulePackMenu(for: pack)
            }

            Divider()

            Text(L("settings.restartHint"))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func modulePackMenu(for pack: ModulePackInfo) -> some View {
        let isActive = configManager.modulePacks.contains(pack.id)

        Menu {
            Text(pack.localizedDescription)
                .font(.caption)
                .foregroundStyle(.secondary)

            Divider()

            Toggle(L("modulePacks.active"), isOn: Binding(
                get: { isActive },
                set: { enabled in
                    configManager.setModulePack(pack.id, enabled: enabled)
                }
            ))
            .disabled(pack.required)
        } label: {
            Label(pack.localizedTitle, systemImage: isActive ? "checkmark.circle" : pack.icon)
        }
    }

    @ViewBuilder
    private func moduleToggle(for module: ModuleInfo) -> some View {
        let isDisabled = configManager.disabledModules.contains(module.id)
        let label = "\(module.localizedName) \u{2014} \(module.localizedDescription)"

        if module.isAvailableOnCurrentOS {
            Toggle(isOn: Binding(
                get: { !isDisabled },
                set: { enabled in
                    var modules = configManager.disabledModules
                    if enabled {
                        modules.removeAll { $0 == module.id }
                    } else {
                        modules.append(module.id)
                    }
                    configManager.disabledModules = modules
                }
            )) {
                Label(label, systemImage: module.icon)
            }
        } else {
            Label(
                "\(label) — \(L("module.requiresMacOS", module.minMacosVersion ?? 0))",
                systemImage: module.icon
            )
            .foregroundStyle(.secondary)
        }
    }

    // MARK: 5 - Swift Bridge

    @ViewBuilder
    private var swiftBridgeStatus: some View {
        if configManager.swiftBridgeAvailable {
            Label(L("menu.swiftBridgeAvailable"), systemImage: "checkmark.circle.fill")
                .foregroundStyle(.green)
        } else {
            Label(L("menu.swiftBridgeNotBuilt"), systemImage: "xmark.circle")
                .foregroundStyle(.secondary)
            Text(L("menu.swiftBuildHint"))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: 6 - Settings

    @ViewBuilder
    private var settingsMenu: some View {
        Menu(L("menu.settings")) {
            // General
            Toggle(L("settings.autoStart"), isOn: Binding(
                get: { serverManager.autoStartEnabled },
                set: { serverManager.autoStartEnabled = $0 }
            ))

            Toggle(L("settings.launchAtLogin"), isOn: Binding(
                get: { serverManager.launchAtLoginEnabled },
                set: { serverManager.setLaunchAtLogin($0) }
            ))

            if let error = serverManager.launchAtLoginError {
                Text(L("settings.launchAtLoginFailed", error))
                    .font(.caption)
                    .foregroundStyle(.red)
            }

            Divider()

            // Permissions
            Toggle(L("settings.includeShared"), isOn: Binding(
                get: { configManager.includeShared },
                set: { configManager.includeShared = $0 }
            ))

            Toggle(L("settings.allowMessages"), isOn: Binding(
                get: { configManager.allowSendMessages },
                set: { configManager.allowSendMessages = $0 }
            ))

            Toggle(L("settings.allowMail"), isOn: Binding(
                get: { configManager.allowSendMail },
                set: { configManager.allowSendMail = $0 }
            ))

            Divider()

            // Share Approval
            Text(L("settings.shareApproval"))
                .font(.caption)
                .foregroundStyle(.secondary)

            shareApprovalToggles

            Divider()

            // HITL
            Text(L("settings.hitl"))
                .font(.caption)
                .foregroundStyle(.secondary)

            Picker(L("settings.hitlLevel"), selection: Binding(
                get: { configManager.hitlLevel },
                set: { configManager.hitlLevel = $0 }
            )) {
                Text(L("settings.hitlOff")).tag(HitlLevel.off)
                Text(L("settings.hitlDestructiveOnly")).tag(HitlLevel.destructiveOnly)
                Text(L("settings.hitlSensitiveOnly")).tag(HitlLevel.sensitiveOnly)
                Text(L("settings.hitlAllWrites")).tag(HitlLevel.allWrites)
                Text(L("settings.hitlAll")).tag(HitlLevel.all)
            }

            Stepper(
                L("settings.hitlTimeout", configManager.hitlTimeout),
                value: Binding(
                    get: { configManager.hitlTimeout },
                    set: { configManager.hitlTimeout = $0 }
                ),
                in: 10...120,
                step: 5
            )

            hitlStatusLabel

            Divider()

            Text(L("settings.restartHint"))
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: 7 - Logs

    @ViewBuilder
    private var logsMenu: some View {
        Menu(L("menu.viewLogs", logManager.entries.count)) {
            if logManager.entries.isEmpty {
                Text(L("menu.noLogs"))
                    .foregroundStyle(.secondary)
            } else {
                ForEach(logManager.recentLines) { entry in
                    Text(entry.message)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(entry.isError ? .red : .primary)
                        .lineLimit(1)
                }

                if logManager.entries.count > 20 {
                    Divider()
                    Text(L("menu.moreLines", logManager.entries.count - 20))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Divider()

                Button(L("menu.clearLogs")) {
                    logManager.clear()
                }
            }
        }
    }

    // MARK: 8 - Configuration & Help

    @ViewBuilder
    private var configSection: some View {
        Button(L("menu.openSetup")) {
            onShowOnboarding()
        }

        Button(permissionManager.isRunning ? L("menu.settingUp") : L("menu.setupPermissions")) {
            permissionManager.runSetup()
        }
        .disabled(permissionManager.isRunning)

        Button(L("menu.copyClaudeConfig")) {
            TaxiConstants.copyToClipboard(TaxiConstants.claudeDesktopConfig())
        }
        .keyboardShortcut("c")

        Button(L("menu.copyClaudeCodeConfig")) {
            TaxiConstants.copyToClipboard(TaxiConstants.claudeCodeConfig())
        }

        Button(L("menu.copyCodexConfig")) {
            TaxiConstants.copyToClipboard(TaxiConstants.codexConfig())
        }

        Button(L("menu.addWidget")) {
            NSWorkspace.shared.open(URL(fileURLWithPath: "/System/Library/CoreServices/NotificationCenter.app"))
        }

        Divider()

        Button(L("menu.openDocumentation")) {
            if let url = URL(string: "https://github.com/heznpc/Taxi") {
                NSWorkspace.shared.open(url)
            }
        }
    }

    // MARK: 9 - Footer

    @ViewBuilder
    private var footerSection: some View {
        Text("Taxi v\(updateManager.currentVersionString)")
            .foregroundStyle(.secondary)

        Button(L("menu.quit")) {
            // TaxiApplicationDelegate defers AppKit termination while the
            // app-owned runtime receives its full graceful-shutdown budget and
            // performs exact-process escalation if required.
            NSApplication.shared.terminate(nil)
        }
        .keyboardShortcut("q")
    }

    // MARK: - Share Approval Toggles

    private static let shareApprovalCapableModules: [(id: String, nameKey: String)] = [
        ("notes", "module.notes"),
        ("reminders", "module.reminders"),
        ("calendar", "module.calendar"),
    ]

    @ViewBuilder
    private var shareApprovalToggles: some View {
        ForEach(Self.shareApprovalCapableModules, id: \.id) { module in
            Toggle(L(module.nameKey), isOn: Binding(
                get: { configManager.shareApprovalModules.contains(module.id) },
                set: { enabled in
                    var modules = configManager.shareApprovalModules
                    if enabled {
                        if !modules.contains(module.id) {
                            modules.append(module.id)
                        }
                    } else {
                        modules.removeAll { $0 == module.id }
                    }
                    configManager.shareApprovalModules = modules
                }
            ))
        }

        Text(L("settings.shareApprovalHint"))
            .font(.caption)
            .foregroundStyle(.secondary)
    }

    // MARK: - HITL Status

    @ViewBuilder
    private var hitlStatusLabel: some View {
        switch hitlManager.state {
        case .connected:
            Label(L("settings.hitlConnected"), systemImage: "antenna.radiowaves.left.and.right")
                .foregroundStyle(.green)
        case .listening:
            Label(L("settings.hitlWaiting"), systemImage: "antenna.radiowaves.left.and.right.slash")
                .foregroundStyle(.secondary)
        case .idle:
            Label(L("settings.hitlInactive"), systemImage: "antenna.radiowaves.left.and.right.slash")
                .foregroundStyle(.secondary)
        }

        if !hitlManager.pendingRequests.isEmpty {
            Divider()
            Text(L("settings.pendingApprovals"))
                .font(.caption)
                .foregroundStyle(.secondary)
            ForEach(hitlManager.pendingRequests) { request in
                VStack(alignment: .leading, spacing: 4) {
                    Label(
                        request.tool,
                        systemImage: request.destructive || request.sensitive ? "exclamationmark.triangle" : "questionmark.circle"
                    )
                        .font(.caption)
                        .foregroundStyle(request.destructive || request.sensitive ? .orange : .primary)
                    HStack {
                        Button(L("hitl.approve")) {
                            hitlManager.respond(id: request.id, approved: true, tool: request.tool)
                        }
                        Button(L("hitl.deny")) {
                            hitlManager.respond(id: request.id, approved: false, tool: request.tool)
                        }
                    }
                }
            }
        }

        if !hitlManager.recentRequests.isEmpty {
            Divider()
            Text(L("settings.recentApprovals"))
                .font(.caption)
                .foregroundStyle(.secondary)
            ForEach(hitlManager.recentRequests) { record in
                Label(
                    "\(record.tool) — \(record.approved ? L("settings.approved") : L("settings.denied"))",
                    systemImage: record.approved ? "checkmark.circle" : "xmark.circle"
                )
                .foregroundStyle(record.approved ? .green : .red)
                .font(.caption)
            }
        }
    }
}
