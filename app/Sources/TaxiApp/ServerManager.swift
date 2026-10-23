import Darwin
import Foundation
import ServiceManagement

/// One monotonic epoch spans start, stop, crash-restart, and status probing.
/// Async work may publish a result only while its captured epoch is current.
struct RuntimeOperationGate: Sendable {
    private(set) var generation: UInt64 = 0

    mutating func advance() -> UInt64 {
        generation &+= 1
        return generation
    }

    func accepts(_ capturedGeneration: UInt64) -> Bool {
        capturedGeneration == generation
    }
}

/// Kernel-observed process-generation evidence captured while the app-owned
/// endpoint is authenticated. PID alone is not sufficient after the listener
/// closes because macOS may reuse it; start time, uid, and executable path let
/// shutdown escalation prove that the PID still names the same process.
struct RuntimeProcessGenerationReceipt: Sendable, Equatable {
    let processIdentifier: Int32
    let userIdentifier: UInt32
    let startTimeSeconds: UInt64
    let startTimeMicroseconds: UInt64
    let executablePath: String
}

struct VerifiedOwnedRuntimeEvidence: Sendable, Equatable {
    let identity: AppOwnedRuntimeIdentity
    let processReceipt: RuntimeProcessGenerationReceipt
}

enum RuntimeTerminationOutcome: Sendable, Equatable {
    case alreadyExited
    case graceful
    case forced
    case identityLost
    case stillRunning
}

private final class SynchronousRuntimeStateBox: @unchecked Sendable {
    private let lock = NSLock()
    private var value: AppRuntimeState?

    func store(_ state: AppRuntimeState?) {
        lock.withLock { value = state }
    }

    func load() -> AppRuntimeState? {
        lock.withLock { value }
    }
}

@MainActor
@Observable
final class ServerManager {

    enum Status: Sendable, Equatable {
        case running
        case stopped
        case checking
        case error(String)
    }

    enum RuntimeHealthResponse: Sendable, Equatable {
        case unavailable
        case occupiedUnrecognized
        case matching(version: String, appOwned: Bool)
        case versionMismatch(found: String, expected: String)
    }

    enum RuntimeProbeResult: Sendable, Equatable {
        case ready(version: String, appOwned: Bool)
        case unavailable
        case portOccupied
        case versionMismatch(found: String, expected: String)
        case authenticationFailed(version: String)
    }

    struct LightweightRuntimeProbeObservation: Sendable, Equatable {
        let probe: RuntimeProbeResult
        let verifiedEvidence: VerifiedOwnedRuntimeEvidence?
    }

    struct OnboardingRuntimeReceipt: Sendable, Equatable {
        let generation: UInt64
        let version: String
        let draftFingerprint: String
        let runtimeFingerprint: String
        let tokenFingerprint: String
        let enabledModules: [String]
        let unavailableModules: [AppRuntimeModuleUnavailable]
        let effectiveHitlLevel: HitlLevel
        let effectiveHitlWhitelist: [String]
    }

    enum OnboardingRuntimeActivationResult: Sendable, Equatable {
        case ready(OnboardingRuntimeReceipt)
        case manualRuntime(version: String)
        case failed(String)
    }

    var status: Status = .checking
    var autoStartEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: TaxiConstants.keyAutoStart) }
        set { UserDefaults.standard.set(newValue, forKey: TaxiConstants.keyAutoStart) }
    }
    var launchAtLoginEnabled: Bool
    var launchAtLoginError: String?

    private var timer: Timer?
    private var serverProcess: Process?
    /// Captured in the same MainActor turn that calls `Process.run()`. Every
    /// later signal to `serverProcess` must revalidate this receipt first.
    private var serverProcessReceipt: RuntimeProcessGenerationReceipt?
    /// Each installed callback carries a unique token. Controlled termination
    /// marks that exact token before yielding, so a callback already delivered
    /// to the MainActor cannot be mistaken for a crash after `terminationHandler`
    /// is detached. Reinstalling a handler always replaces the token.
    private var serverProcessTerminationToken: UUID?
    private var intentionalServerProcessTerminationToken: UUID?
    var logManager: LogManager?
    private var stdoutPipe: Pipe?
    private var stderrPipe: Pipe?
    private var isShuttingDown = false
    private var lastRuntimeDiagnostic: String?
    private var startAttemptID: UUID?
    private var operationGate = RuntimeOperationGate()
    private var statusProbeSequence: UInt64 = 0
    private var stopOperationGeneration: UInt64?
    private var ownedRuntimeIdentity: AppOwnedRuntimeIdentity?
    private var ownedRuntimeProcessReceipt: RuntimeProcessGenerationReceipt?
    private var degradedRecoveryAttemptID: UUID?
    private var degradedRecoverySuspendedUntil: Date?
    private let adoptedRuntimeTerminator: @Sendable (AppOwnedRuntimeIdentity) -> Void
    private var onboardingActivationInProgress = false
    private var onboardingRuntimeControlAuthorized = false
    private var onboardingRuntimeGeneration: UInt64 = 0
    private var onboardingScopeRevision: UInt64 = 0
    private var connectorRuntimeStartRequested = false

    /// Only a live child launched by this app or an authenticated runtime whose
    /// exact PID and current-user owner fingerprint were verified may be stopped.
    /// A same-token manual runtime remains usable, but its lifecycle belongs to
    /// the terminal or service that launched it.
    var canStopRuntime: Bool {
        (serverProcess?.isRunning == true
            && serverProcessReceipt.map(Self.processMatchesGenerationReceipt) == true)
            || (ownedRuntimeIdentity != nil
                && ownedRuntimeProcessReceipt.map(Self.processMatchesGenerationReceipt) == true)
    }

    // MARK: - Crash Restart Tracking

    private var restartTimestamps: [Date] = []
    private var degradedRecoveryTimestamps: [Date] = []
    private static let maxRestartAttempts = 3
    private static let restartWindowSeconds: TimeInterval = 300  // 5 minutes
    nonisolated static let appOwnedReadinessTimeoutSeconds: TimeInterval = 12
    private nonisolated static let individualReadinessProbeTimeout: Duration = .seconds(2)
    /// Node reserves five seconds for governed-call drain and audit persistence.
    /// Give that contract one scheduling second before exact-PID escalation.
    nonisolated static let gracefulTerminationTimeoutSeconds: TimeInterval = 6
    private nonisolated static let forcedTerminationObservationSeconds: TimeInterval = 1
    nonisolated static let applicationTerminationTimeoutSeconds: TimeInterval = 7.5
    private nonisolated static let degradedRuntimeConfirmationDelay: Duration = .seconds(1)

    init(
        adoptedRuntimeTerminator: @escaping @Sendable (AppOwnedRuntimeIdentity) -> Void = { identity in
            ServerManager.terminateVerifiedAdoptedRuntimeSynchronously(identity)
        }
    ) {
        self.adoptedRuntimeTerminator = adoptedRuntimeTerminator
        launchAtLoginEnabled = SMAppService.mainApp.status == .enabled
    }

    func setLaunchAtLogin(_ enabled: Bool) {
        do {
            if enabled {
                try SMAppService.mainApp.register()
                autoStartEnabled = true
            } else {
                try SMAppService.mainApp.unregister()
            }
            launchAtLoginEnabled = SMAppService.mainApp.status == .enabled
            launchAtLoginError = nil
        } catch {
            launchAtLoginEnabled = SMAppService.mainApp.status == .enabled
            launchAtLoginError = error.localizedDescription
        }
    }

    // MARK: - Polling

    func startPolling() {
        guard timer == nil else { return }
        checkStatus()
        timer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
            Task { @MainActor in
                self?.checkStatus()
            }
        }
    }

    func stopPolling() {
        timer?.invalidate()
        timer = nil
    }

    @discardableResult
    private func beginRuntimeOperation() -> UInt64 {
        // Advancing the probe sequence also invalidates an older probe that was
        // launched during the previous lifecycle epoch.
        degradedRecoveryAttemptID = nil
        statusProbeSequence &+= 1
        return operationGate.advance()
    }

    func checkStatus() {
        let operationGeneration = operationGate.generation
        statusProbeSequence &+= 1
        let probeSequence = statusProbeSequence
        Task.detached {
            let observation = await Self.probeAppOwnedRuntimeLightweight()
            await MainActor.run { [weak self] in
                guard let self,
                      self.operationGate.accepts(operationGeneration),
                      self.statusProbeSequence == probeSequence,
                      self.startAttemptID == nil,
                      self.stopOperationGeneration == nil
                else { return }
                self.applyRuntimeProbe(
                    observation.probe,
                    preserveExistingErrorWhenUnavailable: true,
                    verifiedAdoptedIdentity: observation.verifiedEvidence?.identity,
                    verifiedProcessReceipt: observation.verifiedEvidence?.processReceipt
                )
                self.scheduleDegradedRuntimeRecoveryIfNeeded(for: observation.probe)
            }
        }
    }

    // MARK: - Server Control

    /// A direct user start requests both the current launch and future app-owned
    /// recovery. The persistent consent is committed only after authenticated
    /// app-owned readiness succeeds.
    func startServerFromExplicitUserAction() {
        startServer(tokenPolicy: .createIfNeeded, commitAutoStartOnReady: true)
    }

    func startServer() {
        startServer(tokenPolicy: .createIfNeeded)
    }

    private func startServer(
        tokenPolicy: RuntimeTokenLaunchPolicy,
        commitAutoStartOnReady: Bool = false
    ) {
        guard !isShuttingDown,
              (!onboardingActivationInProgress || onboardingRuntimeControlAuthorized),
              status != .running,
              serverProcess?.isRunning != true,
              startAttemptID == nil,
              stopOperationGeneration == nil
        else { return }
        let operationGeneration = beginRuntimeOperation()
        let attemptID = UUID()
        startAttemptID = attemptID
        status = .checking

        Task {
            defer {
                if startAttemptID == attemptID {
                    startAttemptID = nil
                }
            }
            let existingProbe = await Self.probeAppOwnedRuntime()
            let existingEvidence = await Self.verifiedAdoptedRuntimeEvidence(for: existingProbe)
            let existingIdentity = existingEvidence?.identity
            guard operationGate.accepts(operationGeneration),
                  startAttemptID == attemptID
            else { return }
            if case .unavailable = existingProbe {
                // No listener owns the app runtime port; continue with launch.
            } else {
                if Self.shouldCommitExplicitAutoStart(
                    requested: commitAutoStartOnReady,
                    probe: existingProbe,
                    hasVerifiedIdentity: existingIdentity != nil
                ) {
                    autoStartEnabled = true
                }
                applyRuntimeProbe(
                    existingProbe,
                    preserveExistingErrorWhenUnavailable: false,
                    verifiedAdoptedIdentity: existingIdentity,
                    verifiedProcessReceipt: existingEvidence?.processReceipt
                )
                return
            }

            var pipes: (stdout: Pipe, stderr: Pipe)?
            if let logManager {
                pipes = logManager.makePipes()
            }
            // Token/secret preparation may block on the filesystem, so it runs
            // off the MainActor. The returned Process has not been started yet.
            // Generation validation, `run()`, receipt capture, and adoption are
            // intentionally one uninterrupted MainActor turn below.
            let result = await Self.prepareServerLaunch(
                stdoutPipe: pipes?.stdout,
                stderrPipe: pipes?.stderr,
                tokenPolicy: tokenPolicy
            )
            guard Self.shouldCommitPreparedLaunch(
                capturedGeneration: operationGeneration,
                currentGeneration: operationGate.generation,
                expectedAttemptID: attemptID,
                currentAttemptID: startAttemptID,
                isShuttingDown: isShuttingDown
            )
            else {
                if let pipes, let logManager {
                    logManager.detachPipes(stdout: pipes.stdout, stderr: pipes.stderr)
                }
                return
            }
            switch result {
            case .success(
                let process,
                let expectedOwnerFingerprint,
                let runtimeMustMatchLaunchedProcess
            ):
                // Install before spawn so even an immediate exit is queued for
                // the generation we adopt later in this same MainActor turn.
                installTerminationHandler(on: process)
                do {
                    try process.run()
                } catch {
                    process.terminationHandler = nil
                    serverProcessTerminationToken = nil
                    intentionalServerProcessTerminationToken = nil
                    if let pipes, let logManager {
                        logManager.detachPipes(stdout: pipes.stdout, stderr: pipes.stderr)
                    }
                    let message = "Failed to launch server: \(error.localizedDescription)"
                    logManager?.append(message, isError: true)
                    status = .error(message)
                    return
                }
                // Adopt immediately after run, before kernel receipt capture.
                // An immediate status-0/nonzero exit can now reach the common
                // termination reducer instead of falling through an untracked
                // gap between spawn and `serverProcess` assignment.
                clearOwnedRuntimeIdentity()
                serverProcess = process
                serverProcessReceipt = nil
                stdoutPipe = pipes?.stdout
                stderrPipe = pipes?.stderr
                guard let processReceipt = Self.processGenerationReceipt(
                    forLaunchedProcess: process
                ) else {
                    // Never signal a bare PID. A still-running child is retained
                    // so the failure is visible and a later callback can clear
                    // it, but lifecycle controls remain closed without a receipt.
                    let message = "Failed to capture the launched runtime process generation"
                    logManager?.append(message, isError: true)
                    status = .error(message)
                    return
                }
                serverProcessReceipt = processReceipt
                let readiness = await Self.waitForAppOwnedRuntime()
                guard operationGate.accepts(operationGeneration),
                      startAttemptID == attemptID
                else { return }
                switch readiness {
                case .ready(_, appOwned: true):
                    let runtimeEvidence = await Self.verifiedAdoptedRuntimeEvidence(for: readiness)
                    let runtimeIdentity = runtimeEvidence?.identity
                    guard operationGate.accepts(operationGeneration),
                          startAttemptID == attemptID,
                          serverProcess === process,
                          serverProcessReceipt == processReceipt
                    else { return }
                    guard Self.launchReadinessEvidenceMatches(
                        expectedOwnerFingerprint: expectedOwnerFingerprint,
                        evidence: runtimeEvidence,
                        launchedProcessReceipt: processReceipt,
                        requiresExactProcess: runtimeMustMatchLaunchedProcess
                    )
                    else {
                        await cleanupFailedLaunch(
                            process: process,
                            processReceipt: processReceipt,
                            pipes: pipes
                        )
                        guard operationGate.accepts(operationGeneration),
                              startAttemptID == attemptID
                        else { return }
                        applyRuntimeProbe(
                            readiness,
                            preserveExistingErrorWhenUnavailable: false
                        )
                        return
                    }
                    if Self.shouldCommitExplicitAutoStart(
                        requested: commitAutoStartOnReady,
                        probe: readiness,
                        hasVerifiedIdentity: runtimeIdentity != nil
                    ) {
                        autoStartEnabled = true
                    }
                    applyRuntimeProbe(
                        readiness,
                        preserveExistingErrorWhenUnavailable: false,
                        verifiedAdoptedIdentity: runtimeIdentity,
                        verifiedProcessReceipt: runtimeEvidence?.processReceipt
                    )
                case .ready, .portOccupied, .versionMismatch, .authenticationFailed:
                    // A listener other than the child we just launched won the
                    // port, or the child never reached authenticated readiness.
                    // Relinquish the failed child before publishing a retryable
                    // UI state; otherwise Error shows a Start button that the
                    // live `serverProcess` guard can never honor.
                    await cleanupFailedLaunch(
                        process: process,
                        processReceipt: processReceipt,
                        pipes: pipes
                    )
                    guard operationGate.accepts(operationGeneration),
                          startAttemptID == attemptID
                    else { return }
                    applyRuntimeProbe(readiness, preserveExistingErrorWhenUnavailable: false)
                case .unavailable:
                    await cleanupFailedLaunch(
                        process: process,
                        processReceipt: processReceipt,
                        pipes: pipes
                    )
                    guard operationGate.accepts(operationGeneration),
                          startAttemptID == attemptID
                    else { return }
                    let message = "App-owned runtime failed authenticated readiness"
                    lastRuntimeDiagnostic = nil
                    logManager?.append(message, isError: true)
                    status = .error(message)
                }
            case .failure(let error):
                if let pipes, let logManager {
                    logManager.detachPipes(stdout: pipes.stdout, stderr: pipes.stderr)
                }
                logManager?.append(error, isError: true)
                status = .error(error)
            }
        }
    }

    /// Persist connector recovery consent only for a verified app-owned
    /// listener. A manual listener, public ownership bit, failed probe, or an
    /// internal lifecycle launch can never opt the user into auto-start.
    nonisolated static func shouldCommitExplicitAutoStart(
        requested: Bool,
        probe: RuntimeProbeResult,
        hasVerifiedIdentity: Bool
    ) -> Bool {
        guard requested, hasVerifiedIdentity else { return false }
        guard case .ready(_, appOwned: true) = probe else { return false }
        return true
    }

    /// The last gate before spawning a prepared child. This decision and the
    /// subsequent `Process.run()` + receipt adoption execute in one MainActor
    /// turn, so application termination cannot invalidate the generation in
    /// between and create an untracked late child.
    nonisolated static func shouldCommitPreparedLaunch(
        capturedGeneration: UInt64,
        currentGeneration: UInt64,
        expectedAttemptID: UUID,
        currentAttemptID: UUID?,
        isShuttingDown: Bool
    ) -> Bool {
        capturedGeneration == currentGeneration
            && expectedAttemptID == currentAttemptID
            && !isShuttingDown
    }

    nonisolated static func launchReadinessEvidenceMatches(
        expectedOwnerFingerprint: String,
        evidence: VerifiedOwnedRuntimeEvidence?,
        launchedProcessReceipt: RuntimeProcessGenerationReceipt,
        requiresExactProcess: Bool
    ) -> Bool {
        guard let evidence,
              evidence.identity.ownerFingerprint == expectedOwnerFingerprint
        else { return false }
        if evidence.processReceipt == launchedProcessReceipt { return true }
        return !requiresExactProcess
            && processGeneration(
                evidence.processReceipt,
                isDescendantOf: launchedProcessReceipt
            )
    }

    /// A spawned runtime is ours even when it never becomes reachable. Detach
    /// its callback and pipes, then terminate it off the main actor before the
    /// Start action becomes available again.
    private func cleanupFailedLaunch(
        process: Process,
        processReceipt: RuntimeProcessGenerationReceipt,
        pipes: (stdout: Pipe, stderr: Pipe)?
    ) async {
        detachTerminationHandlerIntentionally(from: process)
        if let pipes, let logManager {
            logManager.detachPipes(stdout: pipes.stdout, stderr: pipes.stderr)
        }
        if stdoutPipe === pipes?.stdout { stdoutPipe = nil }
        if stderrPipe === pipes?.stderr { stderrPipe = nil }
        let outcome = await Self.terminateOwnedProcess(
            process,
            processReceipt: processReceipt
        )
        if (outcome == .stillRunning || outcome == .identityLost), process.isRunning {
            if serverProcess == nil || serverProcess === process {
                serverProcess = process
                serverProcessReceipt = outcome == .stillRunning ? processReceipt : nil
                installTerminationHandler(on: process)
            }
            logManager?.append(
                outcome == .stillRunning
                    ? "Failed launch child remained alive after exact-process SIGKILL"
                    : "Failed launch child generation changed before safe termination",
                isError: true
            )
        } else if serverProcess === process {
            clearTerminationHandlerState(for: process)
            serverProcess = nil
            serverProcessReceipt = nil
        }
    }

    @discardableResult
    nonisolated static func terminateOwnedProcess(
        _ process: Process,
        processReceipt: RuntimeProcessGenerationReceipt,
        gracefulTimeout: TimeInterval = gracefulTerminationTimeoutSeconds
    ) async -> RuntimeTerminationOutcome {
        await withCheckedContinuation { (continuation: CheckedContinuation<RuntimeTerminationOutcome, Never>) in
            DispatchQueue.global().async {
                guard processReceipt.processIdentifier == process.processIdentifier else {
                    continuation.resume(returning: .identityLost)
                    return
                }
                guard processMatchesGenerationReceipt(processReceipt) else {
                    continuation.resume(returning: process.isRunning ? .identityLost : .alreadyExited)
                    return
                }
                guard signalProcess(matching: processReceipt, signal: SIGTERM) else {
                    continuation.resume(
                        returning: processMatchesGenerationReceipt(processReceipt)
                            ? .stillRunning
                            : .graceful
                    )
                    return
                }
                let gracefulSteps = max(1, Int(ceil(max(0, gracefulTimeout) * 10)))
                for _ in 0..<gracefulSteps {
                    usleep(100_000)
                    if !processMatchesGenerationReceipt(processReceipt) {
                        continuation.resume(returning: .graceful)
                        return
                    }
                }
                guard signalProcess(matching: processReceipt, signal: SIGKILL) else {
                    continuation.resume(
                        returning: processMatchesGenerationReceipt(processReceipt)
                            ? .stillRunning
                            : .graceful
                    )
                    return
                }
                let forcedSteps = max(1, Int(ceil(forcedTerminationObservationSeconds * 10)))
                for _ in 0..<forcedSteps {
                    usleep(100_000)
                    if !processMatchesGenerationReceipt(processReceipt) {
                        continuation.resume(returning: .forced)
                        return
                    }
                }
                continuation.resume(returning: .stillRunning)
            }
        }
    }

    /// Capture process-generation evidence without trusting command-line text.
    /// `proc_pidinfo`'s birth timestamp distinguishes a recycled PID, while the
    /// uid and kernel-resolved executable path keep escalation inside the
    /// current user's already-authenticated runtime generation.
    nonisolated static func processGenerationReceipt(
        for processIdentifier: Int32
    ) -> RuntimeProcessGenerationReceipt? {
        guard processIdentifier > 1 else { return nil }
        var info = proc_bsdinfo()
        let infoSize = Int32(MemoryLayout<proc_bsdinfo>.size)
        guard proc_pidinfo(
            processIdentifier,
            PROC_PIDTBSDINFO,
            0,
            &info,
            infoSize
        ) == infoSize,
              info.pbi_uid == getuid()
        else { return nil }

        var pathBuffer = [CChar](repeating: 0, count: Int(MAXPATHLEN * 4))
        guard proc_pidpath(
            processIdentifier,
            &pathBuffer,
            UInt32(pathBuffer.count)
        ) > 0 else { return nil }
        let executablePath = String(
            decoding: pathBuffer.prefix { $0 != 0 }.map { UInt8(bitPattern: $0) },
            as: UTF8.self
        )
        guard !executablePath.isEmpty else { return nil }
        return RuntimeProcessGenerationReceipt(
            processIdentifier: processIdentifier,
            userIdentifier: info.pbi_uid,
            startTimeSeconds: UInt64(info.pbi_start_tvsec),
            startTimeMicroseconds: UInt64(info.pbi_start_tvusec),
            executablePath: executablePath
        )
    }

    /// `Process.run()` returns only after a PID exists, but very short-lived
    /// children can still race kernel inspection. Retry for a small bounded
    /// interval while the Process object reports that its child is live. This
    /// helper must be called before yielding the MainActor launch transaction.
    nonisolated static func processGenerationReceipt(
        forLaunchedProcess process: Process,
        retryCount: Int = 50
    ) -> RuntimeProcessGenerationReceipt? {
        let attempts = max(1, retryCount)
        for attempt in 0..<attempts {
            if let receipt = processGenerationReceipt(for: process.processIdentifier) {
                return receipt
            }
            guard process.isRunning, attempt + 1 < attempts else { return nil }
            usleep(1_000)
        }
        return nil
    }

    nonisolated static func processMatchesGenerationReceipt(
        _ receipt: RuntimeProcessGenerationReceipt
    ) -> Bool {
        processGenerationReceipt(for: receipt.processIdentifier) == receipt
    }

    /// Prove that two still-live process generations belong to the same launch
    /// tree. This is needed only for the `npx` fallback, where the authenticated
    /// Node listener may be a child of the Process object started by the app.
    /// Revalidating both endpoint receipts before and after the parent walk
    /// prevents PID reuse from turning ancestry text into signal authority.
    nonisolated static func processGeneration(
        _ descendant: RuntimeProcessGenerationReceipt,
        isDescendantOf ancestor: RuntimeProcessGenerationReceipt,
        maximumDepth: Int = 32
    ) -> Bool {
        guard maximumDepth > 0,
              processMatchesGenerationReceipt(descendant),
              processMatchesGenerationReceipt(ancestor)
        else { return false }
        if descendant == ancestor { return true }

        var currentPID = descendant.processIdentifier
        var visited = Set<Int32>()
        for _ in 0..<maximumDepth {
            guard visited.insert(currentPID).inserted else { return false }
            var info = proc_bsdinfo()
            let infoSize = Int32(MemoryLayout<proc_bsdinfo>.size)
            guard proc_pidinfo(
                currentPID,
                PROC_PIDTBSDINFO,
                0,
                &info,
                infoSize
            ) == infoSize,
                  info.pbi_uid == ancestor.userIdentifier
            else { return false }
            let parentPID = Int32(info.pbi_ppid)
            guard parentPID > 1 else { return false }
            if parentPID == ancestor.processIdentifier {
                return processMatchesGenerationReceipt(descendant)
                    && processMatchesGenerationReceipt(ancestor)
            }
            currentPID = parentPID
        }
        return false
    }

    @discardableResult
    nonisolated static func signalProcess(
        matching receipt: RuntimeProcessGenerationReceipt,
        signal: Int32
    ) -> Bool {
        guard processMatchesGenerationReceipt(receipt) else { return false }
        return Darwin.kill(receipt.processIdentifier, signal) == 0
    }

    private func rememberOwnedRuntimeIdentity(
        _ identity: AppOwnedRuntimeIdentity?,
        processReceipt: RuntimeProcessGenerationReceipt? = nil
    ) {
        guard let identity else {
            clearOwnedRuntimeIdentity()
            return
        }
        let previousIdentity = ownedRuntimeIdentity
        let previousReceipt = ownedRuntimeProcessReceipt
        if let processReceipt,
           processReceipt.processIdentifier == identity.processIdentifier,
           Self.processMatchesGenerationReceipt(processReceipt) {
            ownedRuntimeIdentity = identity
            ownedRuntimeProcessReceipt = processReceipt
        } else if identity == previousIdentity,
                  let previousReceipt,
                  Self.processMatchesGenerationReceipt(previousReceipt) {
            // A transient receipt refresh failure must not discard an earlier
            // generation proof for the same still-live authenticated runtime.
            ownedRuntimeIdentity = identity
            ownedRuntimeProcessReceipt = previousReceipt
        } else {
            clearOwnedRuntimeIdentity()
        }
    }

    private func clearOwnedRuntimeIdentity() {
        ownedRuntimeIdentity = nil
        ownedRuntimeProcessReceipt = nil
    }

    /// Auto-start the server after the user enables it. This also resumes an
    /// interrupted final onboarding step where runtime access was already
    /// granted before the user pressed Finish.
    func autoStartIfNeeded() {
        guard autoStartEnabled, status != .running else { return }
        // `startServer` owns the serialized probe-and-launch transaction. A
        // separate preflight task could otherwise outlive a user Stop action.
        startServer()
    }

    /// Resume a previously authorized app runtime when a verified local
    /// connector delivers the canonical deep link. This deliberately ignores
    /// cached `status`: the listener can disappear just before Process invokes
    /// its termination handler, leaving `.running` stale for a short window.
    func requestConnectorRuntimeStart() {
        guard autoStartEnabled else {
            connectorRuntimeStartRequested = false
            return
        }
        let existingToken: String
        do {
            guard let token = try AppRuntimeToken.loadExisting() else {
                connectorRuntimeStartRequested = false
                logManager?.append(
                    "Ignored connector runtime start: no previously enabled app runtime token exists",
                    isError: true
                )
                return
            }
            existingToken = token
        } catch {
            connectorRuntimeStartRequested = false
            logManager?.append(
                "Ignored connector runtime start: existing app runtime consent is unreadable",
                isError: true
            )
            return
        }

        // Preserve the intent across the short interval where the listener is
        // already gone but Process has not delivered its termination callback.
        connectorRuntimeStartRequested = true
        let managedProcessIsRunning = serverProcess?.isRunning == true
        guard Self.shouldProbeConnectorRuntimeStart(
            autoStartEnabled: autoStartEnabled,
            hasExistingToken: true,
            isShuttingDown: isShuttingDown,
            managedProcessIsRunning: managedProcessIsRunning,
            startInProgress: startAttemptID != nil,
            stopInProgress: stopOperationGeneration != nil
        ) else { return }

        if let staleProcess = serverProcess, !staleProcess.isRunning {
            detachTerminationHandlerIntentionally(from: staleProcess)
            clearTerminationHandlerState(for: staleProcess)
            logManager?.detachPipes(stdout: stdoutPipe, stderr: stderrPipe)
            stdoutPipe = nil
            stderrPipe = nil
            serverProcess = nil
            serverProcessReceipt = nil
        }

        let requestGeneration = beginRuntimeOperation()
        status = .checking
        Task {
            let probe = await Self.probeAppOwnedRuntime()
            let verifiedEvidence = await Self.verifiedAdoptedRuntimeEvidence(for: probe)
            guard operationGate.accepts(requestGeneration),
                  startAttemptID == nil,
                  stopOperationGeneration == nil
            else { return }
            guard autoStartEnabled,
                  AppRuntimeToken.matchesExisting(existingToken)
            else {
                connectorRuntimeStartRequested = false
                return
            }

            if case .unavailable = probe {
                connectorRuntimeStartRequested = false
                if liveOwnedRuntimeProcessIdentifier != nil {
                    applyRuntimeProbe(.unavailable, preserveExistingErrorWhenUnavailable: false)
                    scheduleDegradedRuntimeRecoveryIfNeeded(for: .unavailable)
                } else {
                    clearOwnedRuntimeIdentity()
                    status = .stopped
                    startServer(tokenPolicy: .existing(existingToken))
                }
            } else {
                connectorRuntimeStartRequested = false
                applyRuntimeProbe(
                    probe,
                    preserveExistingErrorWhenUnavailable: false,
                    verifiedAdoptedIdentity: verifiedEvidence?.identity,
                    verifiedProcessReceipt: verifiedEvidence?.processReceipt
                )
            }
        }
    }

    nonisolated static func shouldProbeConnectorRuntimeStart(
        autoStartEnabled: Bool,
        hasExistingToken: Bool,
        isShuttingDown: Bool,
        managedProcessIsRunning: Bool,
        startInProgress: Bool,
        stopInProgress: Bool
    ) -> Bool {
        autoStartEnabled
            && hasExistingToken
            && !isShuttingDown
            && !managedProcessIsRunning
            && !startInProgress
            && !stopInProgress
    }

    nonisolated static func shouldResumeConnectorRuntimeAfterTermination(
        requestPending: Bool,
        autoStartEnabled: Bool,
        isShuttingDown: Bool
    ) -> Bool {
        requestPending && autoStartEnabled && !isShuttingDown
    }

    func stopServer() {
        connectorRuntimeStartRequested = false
        guard (!onboardingActivationInProgress || onboardingRuntimeControlAuthorized),
              stopOperationGeneration == nil,
              canStopRuntime
        else { return }
        let operationGeneration = beginRuntimeOperation()
        stopOperationGeneration = operationGeneration
        // Invalidate a launch that is probing or preparing credentials. The
        // MainActor launch-commit gate prevents a child from spawning afterward.
        startAttemptID = nil
        status = .checking

        let managedProcess = serverProcess
        let managedReceipt = serverProcessReceipt
        let adoptedIdentity = ownedRuntimeIdentity
        let adoptedReceipt = ownedRuntimeProcessReceipt
        // Explicit Stop owns this transition. Detach the crash callback before
        // inspecting `isRunning` so a just-exited child cannot start a newer
        // crash epoch and strand the stop operation.
        if let managedProcess {
            detachTerminationHandlerIntentionally(from: managedProcess)
        }

        if let process = managedProcess {
            Task {
                async let managedTermination: RuntimeTerminationOutcome = {
                    guard let managedReceipt else { return .identityLost }
                    return await Self.terminateOwnedProcess(
                        process,
                        processReceipt: managedReceipt
                    )
                }()
                async let adoptedTermination: RuntimeTerminationOutcome? = {
                    guard let adoptedIdentity,
                          adoptedIdentity.processIdentifier != process.processIdentifier
                    else { return nil }
                    return await Self.terminateVerifiedAdoptedRuntime(
                        adoptedIdentity,
                        cachedReceipt: adoptedReceipt
                    )
                }()
                let (managedOutcome, adoptedOutcome) = await (
                    managedTermination,
                    adoptedTermination
                )
                await completeStop(
                    operationGeneration: operationGeneration,
                    managedProcess: process,
                    managedReceipt: managedReceipt,
                    managedOutcome: managedOutcome,
                    adoptedIdentity: adoptedIdentity,
                    adoptedReceipt: adoptedReceipt,
                    adoptedOutcome: adoptedOutcome
                )
            }
        } else {
            // Reaching this branch requires an exact authenticated PID + owner
            // fingerprint captured from the runtime-state endpoint. Revalidate
            // that identity immediately before signalling only that PID.
            guard let adoptedIdentity else {
                stopOperationGeneration = nil
                status = .stopped
                return
            }
            Task {
                let adoptedOutcome = await Self.terminateVerifiedAdoptedRuntime(
                    adoptedIdentity,
                    cachedReceipt: adoptedReceipt
                )
                await completeStop(
                    operationGeneration: operationGeneration,
                    managedProcess: nil,
                    managedReceipt: nil,
                    managedOutcome: nil,
                    adoptedIdentity: adoptedIdentity,
                    adoptedReceipt: adoptedReceipt,
                    adoptedOutcome: adoptedOutcome
                )
            }
        }
    }

    private func completeStop(
        operationGeneration: UInt64,
        managedProcess: Process?,
        managedReceipt: RuntimeProcessGenerationReceipt?,
        managedOutcome: RuntimeTerminationOutcome?,
        adoptedIdentity: AppOwnedRuntimeIdentity?,
        adoptedReceipt: RuntimeProcessGenerationReceipt?,
        adoptedOutcome: RuntimeTerminationOutcome?
    ) async {
        guard operationGate.accepts(operationGeneration),
              stopOperationGeneration == operationGeneration
        else {
            if stopOperationGeneration == operationGeneration {
                stopOperationGeneration = nil
            }
            if let managedProcess {
                restoreTerminationHandlerIfNeeded(
                    on: managedProcess,
                    retaining: managedReceipt
                )
            }
            return
        }

        if managedOutcome == .forced || adoptedOutcome == .forced {
            logManager?.append(
                "Runtime did not exit within the graceful shutdown budget; sent SIGKILL to the verified process generation",
                isError: true
            )
        }
        let managedStillRunning = managedReceipt.map(Self.processMatchesGenerationReceipt) ?? false
        let adoptedStillRunning = adoptedReceipt.map(Self.processMatchesGenerationReceipt) ?? false
        if managedOutcome == .identityLost || adoptedOutcome == .identityLost {
            stopOperationGeneration = nil
            if let managedProcess {
                restoreTerminationHandlerIfNeeded(
                    on: managedProcess,
                    retaining: managedReceipt
                )
            }
            setRuntimeDiagnostic(
                L(
                    "server.runtimeIdentityLost",
                    Int(managedProcess?.processIdentifier ?? adoptedIdentity?.processIdentifier ?? 0)
                )
            )
            return
        }
        if managedStillRunning
            || adoptedStillRunning
            || managedOutcome == .stillRunning
            || adoptedOutcome == .stillRunning {
            stopOperationGeneration = nil
            if let managedProcess {
                restoreTerminationHandlerIfNeeded(
                    on: managedProcess,
                    retaining: managedReceipt
                )
            }
            setRuntimeDiagnostic(
                L(
                    "server.runtimeTerminationFailed",
                    Int(managedProcess?.processIdentifier ?? adoptedIdentity?.processIdentifier ?? 0)
                )
            )
            return
        }

        if let managedProcess, serverProcess === managedProcess {
            clearTerminationHandlerState(for: managedProcess)
            serverProcess = nil
            serverProcessReceipt = nil
        }
        if ownedRuntimeIdentity == adoptedIdentity {
            clearOwnedRuntimeIdentity()
        }
        logManager?.detachPipes(stdout: stdoutPipe, stderr: stderrPipe)
        stdoutPipe = nil
        stderrPipe = nil
        await settleStop(operationGeneration: operationGeneration)
    }

    private func restoreTerminationHandlerIfNeeded(
        on process: Process,
        retaining receipt: RuntimeProcessGenerationReceipt?
    ) {
        guard !isShuttingDown,
              serverProcess === process,
              process.isRunning
        else { return }
        if let receipt,
           receipt.processIdentifier == process.processIdentifier,
           Self.processMatchesGenerationReceipt(receipt) {
            serverProcessReceipt = receipt
        } else {
            serverProcessReceipt = nil
        }
        installTerminationHandler(on: process)
    }

    private func settleStop(operationGeneration: UInt64) async {
        try? await Task.sleep(nanoseconds: 500_000_000)
        guard operationGate.accepts(operationGeneration),
              stopOperationGeneration == operationGeneration
        else {
            if stopOperationGeneration == operationGeneration {
                stopOperationGeneration = nil
            }
            return
        }
        let probe = await Self.probeAppOwnedRuntime()
        let verifiedEvidence = await Self.verifiedAdoptedRuntimeEvidence(for: probe)
        guard operationGate.accepts(operationGeneration),
              stopOperationGeneration == operationGeneration
        else {
            if stopOperationGeneration == operationGeneration {
                stopOperationGeneration = nil
            }
            return
        }
        stopOperationGeneration = nil
        applyRuntimeProbe(
            probe,
            preserveExistingErrorWhenUnavailable: false,
            verifiedAdoptedIdentity: verifiedEvidence?.identity,
            verifiedProcessReceipt: verifiedEvidence?.processReceipt
        )
    }

    /// Invalidate any receipt/activation tied to the previous Setup selection.
    /// An app-owned runtime using that old selection is stopped; an authenticated
    /// manual runtime is deliberately left under its launcher's control.
    func noteOnboardingScopeChanged() {
        onboardingScopeRevision &+= 1
        guard !onboardingActivationInProgress, canStopRuntime else { return }
        stopServer()
    }

    /// One serialized stop → persist+verify → start → runtime-state-verify
    /// transaction for Setup. The runtime is never connected to clients until
    /// both the config bytes and authenticated effective scope agree.
    func activateOnboardingRuntime(
        for scope: OnboardingRuntimeScope,
        configManager: ConfigManager
    ) async -> OnboardingRuntimeActivationResult {
        guard !onboardingActivationInProgress, !isShuttingDown else {
            return .failed("Another runtime activation is already in progress.")
        }
        onboardingActivationInProgress = true
        let capturedRevision = onboardingScopeRevision
        let previousDisabledModules = Array(Set(configManager.disabledModules)).sorted()
        let previousRuntimeFingerprint = OnboardingRuntimeScope(
            workflowID: configManager.config.onboardingWorkflow ?? "previous",
            disabledModules: previousDisabledModules
        ).runtimeFingerprint
        defer {
            onboardingRuntimeControlAuthorized = false
            onboardingActivationInProgress = false
        }

        guard await waitForRuntimeOperationsToSettle(),
              capturedRevision == onboardingScopeRevision
        else { return .failed("The Setup access selection changed before activation.") }

        let initialProbe = await Self.probeAppOwnedRuntime()
        guard capturedRevision == onboardingScopeRevision else {
            return .failed("The Setup access selection changed before activation.")
        }

        var previouslyOwnedRuntimeWasRunning = false
        switch initialProbe {
        case .ready(let version, appOwned: false):
            return .manualRuntime(version: version)
        case .ready(let version, appOwned: true):
            guard let state = try? await AppRuntimeClient.runtimeState(),
                  let expectedOwnerFingerprint = try? AppRuntimeToken.expectedOwnerFingerprint(),
                  let runtimeIdentity = Self.authenticatedOwnedRuntimeIdentity(
                      state: state,
                      expectedVersion: version,
                      expectedOwnerFingerprint: expectedOwnerFingerprint
                  )
            else { return .failed("The running runtime identity could not be verified.") }
            guard let processReceipt = await Self.confirmedProcessGenerationReceipt(
                for: runtimeIdentity
            ) else { return .failed("The running runtime process generation could not be verified.") }
            rememberOwnedRuntimeIdentity(runtimeIdentity, processReceipt: processReceipt)
            previouslyOwnedRuntimeWasRunning = true
            let stopped = await stopOwnedRuntimeAndWait()
            switch stopped {
            case .unavailable:
                break
            case .ready(let version, appOwned: false):
                return .manualRuntime(version: version)
            default:
                return .failed("The existing app-owned runtime did not stop completely.")
            }
        case .unavailable:
            if canStopRuntime {
                previouslyOwnedRuntimeWasRunning = true
                guard case .unavailable = await stopOwnedRuntimeAndWait() else {
                    return .failed("The existing app-owned runtime did not stop completely.")
                }
            }
        case .portOccupied, .versionMismatch, .authenticationFailed:
            return .failed(statusLabel)
        }

        guard capturedRevision == onboardingScopeRevision else {
            return .failed("The Setup access selection changed before the scope was saved.")
        }

        guard let transaction = configManager.beginOnboardingRuntimeScopeTransaction(scope) else {
            if previouslyOwnedRuntimeWasRunning {
                _ = await recoverPreviousAppOwnedRuntime(
                    disabledModules: previousDisabledModules,
                    runtimeFingerprint: previousRuntimeFingerprint
                )
            }
            return .failed(configManager.lastPersistenceError ?? "The Setup scope could not be saved.")
        }

        if capturedRevision != onboardingScopeRevision {
            _ = configManager.rollbackOnboardingRuntimeScope(transaction)
            return .failed("The Setup access selection changed while the scope was saved.")
        }

        startServerForOnboardingActivation()
        let startSettled = await waitForRuntimeOperationsToSettle()
        let activatedProbe = await Self.probeAppOwnedRuntime()
        let activatedToken = try? AppRuntimeToken.loadExisting()
        let activatedState: AppRuntimeState? = if let activatedToken {
            try? await AppRuntimeClient.runtimeStateWhenReady(
                token: activatedToken,
                timeout: .seconds(Self.appOwnedReadinessTimeoutSeconds)
            )
        } else {
            nil
        }
        let activatedOwnerFingerprint = try? AppRuntimeToken.expectedOwnerFingerprint()
        let activatedIdentity: AppOwnedRuntimeIdentity? = {
            guard case .ready(let version, appOwned: true) = activatedProbe,
                  let activatedState
            else { return nil }
            return Self.authenticatedOwnedRuntimeIdentity(
                state: activatedState,
                expectedVersion: version,
                expectedOwnerFingerprint: activatedOwnerFingerprint
            )
        }()
        let activatedProcessReceipt: RuntimeProcessGenerationReceipt?
        if let activatedIdentity {
            activatedProcessReceipt = await Self.confirmedProcessGenerationReceipt(for: activatedIdentity)
        } else {
            activatedProcessReceipt = nil
        }
        let selectionStillCurrent = capturedRevision == onboardingScopeRevision
        let surfaceAssessment = activatedState.map {
            scope.assessRuntimeSurface(
                enabledModules: $0.enabledModules,
                unavailableModules: $0.unavailableModules
            )
        }
        let exactRuntimeReady: Bool = {
            guard startSettled,
                  selectionStillCurrent,
                  case .ready(let version, appOwned: true) = activatedProbe,
                  let activatedState,
                  activatedState.status == "ok",
                  activatedState.version == version,
                  activatedIdentity != nil,
                  activatedProcessReceipt != nil,
                  activatedState.disabledModules == scope.disabledModules,
                  activatedState.scopeFingerprint == scope.runtimeFingerprint,
                  surfaceAssessment?.isAcceptable == true,
                  let activatedToken,
                  AppRuntimeToken.matchesExisting(activatedToken),
                  configManager.isOnboardingRuntimeScopePersisted(scope)
            else { return false }
            return true
        }()

        if exactRuntimeReady,
           case .ready(let version, appOwned: true) = activatedProbe,
           let activatedIdentity,
           let activatedState,
           let activatedToken {
            rememberOwnedRuntimeIdentity(
                activatedIdentity,
                processReceipt: activatedProcessReceipt
            )
            onboardingRuntimeGeneration &+= 1
            return .ready(
                OnboardingRuntimeReceipt(
                    generation: onboardingRuntimeGeneration,
                    version: version,
                    draftFingerprint: scope.draftFingerprint,
                    runtimeFingerprint: scope.runtimeFingerprint,
                    tokenFingerprint: AppRuntimeToken.fingerprint(for: activatedToken),
                    enabledModules: activatedState.enabledModules.sorted(),
                    unavailableModules: surfaceAssessment?.diagnosedUnavailableModules ?? [],
                    effectiveHitlLevel: activatedState.effectiveHitlLevel,
                    effectiveHitlWhitelist: activatedState.effectiveHitlWhitelist
                )
            )
        }

        // Never roll the file back while a child using the new bytes is still
        // live. Stop only an authenticated app-owned runtime; a manual process
        // that raced onto the port remains untouched and blocks recovery.
        var manualRuntimeVersion: String?
        if case .ready(let version, appOwned: false) = activatedProbe {
            manualRuntimeVersion = version
        } else if let activatedState, !activatedState.appOwned {
            manualRuntimeVersion = activatedState.version
        } else if canStopRuntime {
            let stopped = await stopOwnedRuntimeAndWait()
            if case .ready(let version, appOwned: false) = stopped {
                manualRuntimeVersion = version
            }
        } else if startAttemptID != nil {
            cancelPendingOnboardingStart()
            _ = await waitForRuntimeOperationsToSettle()
        }

        // A manual process that won the port after the new config was persisted
        // may already be running that scope. It is not ours to stop, and rolling
        // the file back underneath it would manufacture a file/runtime mismatch.
        // Keep client patching locked and leave the verified new bytes in place.
        if let manualRuntimeVersion {
            return .manualRuntime(version: manualRuntimeVersion)
        }

        guard configManager.rollbackOnboardingRuntimeScope(transaction) else {
            return .failed(configManager.lastPersistenceError ?? "The previous configuration could not be restored.")
        }

        if previouslyOwnedRuntimeWasRunning,
           selectionStillCurrent,
           manualRuntimeVersion == nil,
           !(await recoverPreviousAppOwnedRuntime(
               disabledModules: transaction.previousDisabledModules,
               runtimeFingerprint: transaction.previousRuntimeFingerprint
           )) {
            return .failed("The previous app-owned runtime could not be restored.")
        }

        let failureDetail = surfaceAssessment.flatMap { assessment in
            assessment.isAcceptable ? nil : assessment.failureDescription
        }
        return .failed(
            selectionStillCurrent
                ? (failureDetail ?? "The app-owned runtime did not load the exact saved scope.")
                : "The Setup access selection changed during activation."
        )
    }

    /// Revalidate a previously consented draft against the currently running
    /// process generation. The caller supplies the persisted draft receipt;
    /// without that receipt an arbitrary pre-existing runtime can never unlock
    /// client configuration.
    func validateOnboardingRuntime(
        for scope: OnboardingRuntimeScope,
        authorizedDraftFingerprint: String,
        runtimeToken: String,
        configManager: ConfigManager
    ) async -> OnboardingRuntimeActivationResult {
        guard authorizedDraftFingerprint == scope.draftFingerprint else {
            return .failed("The Setup access selection changed after runtime activation.")
        }
        let probe = await Self.probeAppOwnedRuntime()
        if case .ready(let version, appOwned: false) = probe {
            return .manualRuntime(version: version)
        }
        guard case .ready(let version, appOwned: true) = probe,
              let state = try? await AppRuntimeClient.runtimeState(token: runtimeToken),
              let expectedOwnerFingerprint = try? AppRuntimeToken.expectedOwnerFingerprint(),
              let runtimeIdentity = Self.authenticatedOwnedRuntimeIdentity(
                  state: state,
                  expectedVersion: version,
                  expectedOwnerFingerprint: expectedOwnerFingerprint
              )
        else { return .failed("The app-owned runtime is not ready.") }
        guard state.disabledModules == scope.disabledModules,
              state.scopeFingerprint == scope.runtimeFingerprint,
              AppRuntimeToken.matchesExisting(runtimeToken),
              configManager.isOnboardingRuntimeScopePersisted(scope)
        else { return .failed("The running runtime scope does not match Setup.") }
        let surfaceAssessment = scope.assessRuntimeSurface(
            enabledModules: state.enabledModules,
            unavailableModules: state.unavailableModules
        )
        guard surfaceAssessment.isAcceptable else {
            return .failed(surfaceAssessment.failureDescription)
        }

        guard let processReceipt = await Self.confirmedProcessGenerationReceipt(for: runtimeIdentity)
        else { return .failed("The app-owned runtime process generation could not be verified.") }
        rememberOwnedRuntimeIdentity(runtimeIdentity, processReceipt: processReceipt)
        onboardingRuntimeGeneration &+= 1
        return .ready(
            OnboardingRuntimeReceipt(
                generation: onboardingRuntimeGeneration,
                version: version,
                draftFingerprint: scope.draftFingerprint,
                runtimeFingerprint: scope.runtimeFingerprint,
                tokenFingerprint: AppRuntimeToken.fingerprint(for: runtimeToken),
                enabledModules: state.enabledModules.sorted(),
                unavailableModules: surfaceAssessment.diagnosedUnavailableModules,
                effectiveHitlLevel: state.effectiveHitlLevel,
                effectiveHitlWhitelist: state.effectiveHitlWhitelist
            )
        )
    }

    private func startServerForOnboardingActivation() {
        onboardingRuntimeControlAuthorized = true
        startServer()
        onboardingRuntimeControlAuthorized = false
    }

    private func stopOwnedRuntimeAndWait() async -> RuntimeProbeResult {
        onboardingRuntimeControlAuthorized = true
        stopServer()
        onboardingRuntimeControlAuthorized = false
        _ = await waitForRuntimeOperationsToSettle()
        return await Self.probeAppOwnedRuntime()
    }

    private func cancelPendingOnboardingStart() {
        _ = beginRuntimeOperation()
        startAttemptID = nil
        status = .stopped
    }

    private func waitForRuntimeOperationsToSettle(
        timeout: Duration = .seconds(20)
    ) async -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while startAttemptID != nil || stopOperationGeneration != nil {
            guard clock.now < deadline else { return false }
            try? await Task.sleep(for: .milliseconds(100))
        }
        return true
    }

    private func recoverPreviousAppOwnedRuntime(
        disabledModules: [String],
        runtimeFingerprint: String
    ) async -> Bool {
        let probe = await Self.probeAppOwnedRuntime()
        if case .ready(_, appOwned: false) = probe { return false }
        if case .ready(let version, appOwned: true) = probe {
            guard let state = try? await AppRuntimeClient.runtimeState(),
                  let expectedOwnerFingerprint = try? AppRuntimeToken.expectedOwnerFingerprint(),
                  let runtimeIdentity = Self.authenticatedOwnedRuntimeIdentity(
                      state: state,
                      expectedVersion: version,
                      expectedOwnerFingerprint: expectedOwnerFingerprint
                  )
            else { return false }
            guard let processReceipt = await Self.confirmedProcessGenerationReceipt(
                for: runtimeIdentity
            ) else { return false }
            rememberOwnedRuntimeIdentity(runtimeIdentity, processReceipt: processReceipt)
            guard case .unavailable = await stopOwnedRuntimeAndWait() else { return false }
        } else if case .unavailable = probe {
            // Port is available; start the runtime from the restored config.
        } else {
            return false
        }

        startServerForOnboardingActivation()
        guard await waitForRuntimeOperationsToSettle() else { return false }
        guard case .ready(let version, appOwned: true) = await Self.probeAppOwnedRuntime(),
              let state = try? await AppRuntimeClient.runtimeState(),
              let expectedOwnerFingerprint = try? AppRuntimeToken.expectedOwnerFingerprint(),
              let runtimeIdentity = Self.authenticatedOwnedRuntimeIdentity(
                  state: state,
                  expectedVersion: version,
                  expectedOwnerFingerprint: expectedOwnerFingerprint
              ),
              state.disabledModules == disabledModules,
              state.scopeFingerprint == runtimeFingerprint
        else { return false }
        guard let processReceipt = await Self.confirmedProcessGenerationReceipt(for: runtimeIdentity)
        else { return false }
        rememberOwnedRuntimeIdentity(runtimeIdentity, processReceipt: processReceipt)
        return true
    }

    /// AppKit can defer ordinary termination while the Node child consumes its
    /// bounded graceful-shutdown budget. This is the authoritative Quit/logout
    /// path; `prepareForApplicationTermination()` below is only the final
    /// synchronous fail-safe once AppKit is committed to exiting.
    func shutdownForApplicationTermination() async {
        let terminationDeadline = Date().addingTimeInterval(
            Self.applicationTerminationTimeoutSeconds
        )
        if isShuttingDown {
            _ = await waitForRuntimeOperationsToSettle(
                timeout: .milliseconds(max(0, Int(terminationDeadline.timeIntervalSinceNow * 1_000)))
            )
            return
        }
        isShuttingDown = true
        connectorRuntimeStartRequested = false
        degradedRecoveryAttemptID = nil
        stopPolling()

        // Let an explicit Stop that already owns the process finish first. If it
        // reports a surviving process, the generation-safe pass below retries.
        if stopOperationGeneration != nil {
            _ = await waitForRuntimeOperationsToSettle(
                timeout: .milliseconds(max(0, Int(terminationDeadline.timeIntervalSinceNow * 1_000)))
            )
        }

        let managedProcess = serverProcess
        let managedReceipt = serverProcessReceipt
        let runtimeIdentity = ownedRuntimeIdentity
        let runtimeReceipt = ownedRuntimeProcessReceipt
        _ = beginRuntimeOperation()
        stopOperationGeneration = nil
        if let managedProcess {
            detachTerminationHandlerIntentionally(from: managedProcess)
        }

        let remainingBudget = max(0, terminationDeadline.timeIntervalSinceNow)
        if remainingBudget <= Self.forcedTerminationObservationSeconds + 0.2 {
            // A preceding explicit Stop consumed the graceful budget. Signal the
            // still-exact targets now so applicationWillTerminate's fail-safe is
            // reached before the eight-second external acceptance deadline.
            if let managedProcess,
               let managedReceipt,
               managedReceipt.processIdentifier == managedProcess.processIdentifier {
                _ = Self.signalProcess(matching: managedReceipt, signal: SIGKILL)
            }
            if let runtimeIdentity,
               managedProcess?.processIdentifier != runtimeIdentity.processIdentifier {
                if let runtimeReceipt,
                   Self.processMatchesGenerationReceipt(runtimeReceipt) {
                    _ = Self.signalProcess(matching: runtimeReceipt, signal: SIGKILL)
                } else {
                    adoptedRuntimeTerminator(runtimeIdentity)
                }
            }
        } else {
            let gracefulBudget = min(
                Self.gracefulTerminationTimeoutSeconds,
                max(0, remainingBudget - Self.forcedTerminationObservationSeconds - 0.2)
            )
            async let managedTermination: RuntimeTerminationOutcome? = {
                guard let managedProcess else { return nil }
                guard let managedReceipt else { return .identityLost }
                return await Self.terminateOwnedProcess(
                    managedProcess,
                    processReceipt: managedReceipt,
                    gracefulTimeout: gracefulBudget
                )
            }()
            async let adoptedTermination: RuntimeTerminationOutcome? = {
                guard let runtimeIdentity,
                      managedProcess?.processIdentifier != runtimeIdentity.processIdentifier
                else { return nil }
                return await Self.terminateVerifiedAdoptedRuntime(
                    runtimeIdentity,
                    cachedReceipt: runtimeReceipt,
                    gracefulTimeout: gracefulBudget
                )
            }()
            _ = await (managedTermination, adoptedTermination)
        }

        // A start that was preparing credentials when termination began sees
        // the advanced operation generation and never calls Process.run(). Keep
        // AppKit alive for that handoff, but never exceed the acceptance gate's
        // eight-second app-plus-child shutdown boundary.
        while managedProcess == nil,
              startAttemptID != nil,
              Date() < terminationDeadline {
            try? await Task.sleep(for: .milliseconds(50))
        }

        logManager?.detachPipes(stdout: stdoutPipe, stderr: stderrPipe)
        stdoutPipe = nil
        stderrPipe = nil
        // Keep the exact Process/receipt references until
        // applicationWillTerminate. If either bounded async termination attempt
        // failed, the synchronous final callback must still be able to retry the
        // same targets rather than losing them and orphaning the runtime.
        startAttemptID = nil
        status = .stopped
    }

    /// Synchronous last-chance cleanup for an AppKit termination that could not
    /// be deferred. Normal exits have already completed the async method above;
    /// any remaining exact managed PID is force-killed to prevent an orphan.
    func prepareForApplicationTermination() {
        let runtimeIdentity = ownedRuntimeIdentity
        let runtimeReceipt = ownedRuntimeProcessReceipt
        let managedProcess = serverProcess
        let managedReceipt = serverProcessReceipt
        _ = beginRuntimeOperation()
        isShuttingDown = true
        connectorRuntimeStartRequested = false
        startAttemptID = nil
        stopOperationGeneration = nil
        stopPolling()
        logManager?.detachPipes(stdout: stdoutPipe, stderr: stderrPipe)
        stdoutPipe = nil
        stderrPipe = nil
        if let managedProcess {
            detachTerminationHandlerIntentionally(from: managedProcess)
        }
        if let managedProcess,
           let managedReceipt,
           managedReceipt.processIdentifier == managedProcess.processIdentifier {
            _ = Self.signalProcess(matching: managedReceipt, signal: SIGKILL)
        }
        if let runtimeIdentity,
           managedProcess?.processIdentifier != runtimeIdentity.processIdentifier {
            if let runtimeReceipt {
                if Self.processMatchesGenerationReceipt(runtimeReceipt) {
                    _ = Self.signalProcess(matching: runtimeReceipt, signal: SIGKILL)
                } else if Darwin.kill(runtimeIdentity.processIdentifier, 0) == -1,
                          errno == ESRCH {
                    // The verified generation is already gone; avoid spending
                    // the final AppKit deadline on an unnecessary HTTP retry.
                } else {
                    adoptedRuntimeTerminator(runtimeIdentity)
                }
            } else {
                adoptedRuntimeTerminator(runtimeIdentity)
            }
        }
        if let managedProcess {
            clearTerminationHandlerState(for: managedProcess)
        }
        serverProcess = nil
        serverProcessReceipt = nil
        clearOwnedRuntimeIdentity()
    }

    // MARK: - Crash Detection & Auto-Restart

    private func installTerminationHandler(on process: Process) {
        let handlerToken = UUID()
        serverProcessTerminationToken = handlerToken
        intentionalServerProcessTerminationToken = nil
        process.terminationHandler = { [weak self] terminatedProcess in
            let exitCode = terminatedProcess.terminationStatus
            let reason = terminatedProcess.terminationReason
            Task { @MainActor [weak self] in
                guard let self else { return }
                // Ignore a delayed callback from a process that was already
                // stopped/replaced; it must not clobber the current child.
                guard self.serverProcess === terminatedProcess else { return }
                guard Self.shouldHandleTerminationCallback(
                    handlerToken: handlerToken,
                    currentToken: self.serverProcessTerminationToken,
                    intentionalToken: self.intentionalServerProcessTerminationToken
                ) else {
                    if self.serverProcessTerminationToken == handlerToken {
                        self.serverProcessTerminationToken = nil
                    }
                    if self.intentionalServerProcessTerminationToken == handlerToken {
                        self.intentionalServerProcessTerminationToken = nil
                    }
                    return
                }
                self.serverProcessTerminationToken = nil
                self.intentionalServerProcessTerminationToken = nil
                self.logManager?.detachPipes(stdout: self.stdoutPipe, stderr: self.stderrPipe)
                self.stdoutPipe = nil
                self.stderrPipe = nil
                self.serverProcess = nil
                self.serverProcessReceipt = nil
                self.startAttemptID = nil
                self.clearOwnedRuntimeIdentity()

                if self.isShuttingDown {
                    self.status = .stopped
                    return
                }
                let crashGeneration = self.beginRuntimeOperation()
                guard Self.shouldRecoverFromHandlerDeliveredTermination(
                    exitCode: exitCode,
                    reason: reason
                ) else { return }
                let reasonLabel = reason == .uncaughtSignal ? "signal" : "exit"
                let message = "Server process terminated unexpectedly (\(reasonLabel), status: \(exitCode))"
                self.logManager?.append(message, isError: true)

                // A second Taxi copy can make the new child fail with
                // EADDRINUSE. Diagnose that owner instead of repeatedly
                // launching children against the occupied port.
                let probe = await Self.probeAppOwnedRuntime()
                let verifiedEvidence = await Self.verifiedAdoptedRuntimeEvidence(for: probe)
                guard self.operationGate.accepts(crashGeneration) else { return }
                if case .unavailable = probe {
                    self.status = .stopped
                } else {
                    self.connectorRuntimeStartRequested = false
                    self.applyRuntimeProbe(
                        probe,
                        preserveExistingErrorWhenUnavailable: false,
                        verifiedAdoptedIdentity: verifiedEvidence?.identity,
                        verifiedProcessReceipt: verifiedEvidence?.processReceipt
                    )
                    return
                }

                if Self.shouldResumeConnectorRuntimeAfterTermination(
                    requestPending: self.connectorRuntimeStartRequested,
                    autoStartEnabled: self.autoStartEnabled,
                    isShuttingDown: self.isShuttingDown
                ) {
                    self.connectorRuntimeStartRequested = false
                    self.requestConnectorRuntimeStart()
                    return
                }

                if self.autoStartEnabled && self.canAttemptRestart() {
                    self.logManager?.append("Auto-restarting server in 3 seconds...", isError: false)
                    try? await Task.sleep(nanoseconds: 3_000_000_000)
                    guard Self.shouldPerformScheduledRestart(
                        capturedGeneration: crashGeneration,
                        currentGeneration: self.operationGate.generation,
                        autoStartEnabled: self.autoStartEnabled,
                        stopInProgress: self.stopOperationGeneration != nil
                    ), !self.isShuttingDown,
                       self.serverProcess == nil,
                       self.startAttemptID == nil
                    else { return }
                    self.startServer()
                }
            }
        }
    }

    nonisolated static func shouldHandleTerminationCallback(
        handlerToken: UUID,
        currentToken: UUID?,
        intentionalToken: UUID?
    ) -> Bool {
        handlerToken == currentToken && handlerToken != intentionalToken
    }

    /// Detaching Foundation's callback does not retract a block already queued
    /// onto the MainActor. Mark the exact handler generation first so a
    /// controlled Stop/Quit can never be reduced as an unexpected crash.
    private func detachTerminationHandlerIntentionally(from process: Process) {
        if serverProcess === process,
           let currentToken = serverProcessTerminationToken {
            intentionalServerProcessTerminationToken = currentToken
        }
        process.terminationHandler = nil
    }

    private func clearTerminationHandlerState(for process: Process) {
        guard serverProcess === process else { return }
        serverProcessTerminationToken = nil
        intentionalServerProcessTerminationToken = nil
    }

    /// Controlled Stop, failed-launch cleanup, and AppKit termination detach the
    /// handler before signalling. Therefore any callback that remains installed
    /// is an unexpected lifecycle loss, including Node's listener-loss SIGTERM
    /// path when its graceful signal handler exits with status zero.
    nonisolated static func shouldRecoverFromHandlerDeliveredTermination(
        exitCode _: Int32,
        reason _: Process.TerminationReason
    ) -> Bool {
        true
    }

    nonisolated static func shouldPerformScheduledRestart(
        capturedGeneration: UInt64,
        currentGeneration: UInt64,
        autoStartEnabled: Bool,
        stopInProgress: Bool
    ) -> Bool {
        capturedGeneration == currentGeneration
            && autoStartEnabled
            && !stopInProgress
    }

    private func canAttemptRestart() -> Bool {
        let now = Date()
        restartTimestamps = restartTimestamps.filter {
            now.timeIntervalSince($0) < Self.restartWindowSeconds
        }
        guard restartTimestamps.count < Self.maxRestartAttempts else {
            logManager?.append(
                "Auto-restart skipped: \(Self.maxRestartAttempts) restarts within \(Int(Self.restartWindowSeconds / 60)) minutes",
                isError: true
            )
            return false
        }
        restartTimestamps.append(now)
        return true
    }

    private func canAttemptDegradedRecovery() -> Bool {
        let now = Date()
        if let degradedRecoverySuspendedUntil, now < degradedRecoverySuspendedUntil {
            return false
        }
        degradedRecoverySuspendedUntil = nil
        degradedRecoveryTimestamps = degradedRecoveryTimestamps.filter {
            now.timeIntervalSince($0) < Self.restartWindowSeconds
        }
        guard degradedRecoveryTimestamps.count < Self.maxRestartAttempts else {
            degradedRecoverySuspendedUntil = degradedRecoveryTimestamps.first?.addingTimeInterval(
                Self.restartWindowSeconds
            )
            return false
        }
        degradedRecoveryTimestamps.append(now)
        return true
    }

    // MARK: - Static Process Launchers (nonisolated)

    private enum RuntimeTokenLaunchPolicy: Sendable {
        case createIfNeeded
        case existing(String)
    }

    private enum LaunchResult: Sendable {
        case success(
            Process,
            expectedOwnerFingerprint: String,
            runtimeMustMatchLaunchedProcess: Bool
        )
        case failure(String)
    }

    /// Prepare credentials and an unstarted Process off the MainActor. The
    /// caller alone may invoke `run()`, after revalidating its lifecycle epoch.
    private static func prepareServerLaunch(
        stdoutPipe: Pipe?,
        stderrPipe: Pipe?,
        tokenPolicy: RuntimeTokenLaunchPolicy
    ) async -> LaunchResult {
        await withCheckedContinuation { continuation in
            DispatchQueue.global().async {
                let executable: String
                let arguments: [String]
                let runtimeMustMatchLaunchedProcess: Bool
                if let runtime = TaxiConstants.bundledServerRuntime {
                    executable = runtime.node
                    arguments = [runtime.entry, "run", "--http", "--port", "\(TaxiConstants.appOwnedHttpPort)"]
                    runtimeMustMatchLaunchedProcess = true
                } else {
                    guard let npxPath = NodeEnvironment.findTrustedAppRuntimeExecutable(named: "npx") else {
                        continuation.resume(returning: .failure(
                            "Bundled runtime is unavailable and Node.js was not found"
                        ))
                        return
                    }
                    executable = npxPath
                    arguments = [
                        "-y",
                        TaxiConstants.npmPackageSpecifier,
                        "run",
                        "--http",
                        "--port",
                        "\(TaxiConstants.appOwnedHttpPort)",
                    ]
                    runtimeMustMatchLaunchedProcess = false
                }
                let ownerSecret: String
                do {
                    switch tokenPolicy {
                    case .createIfNeeded:
                        _ = try AppRuntimeToken.ensure()
                    case .existing(let existingToken):
                        guard AppRuntimeToken.matchesExisting(existingToken) else {
                            continuation.resume(returning: .failure(
                                "Existing app runtime consent changed before connector start"
                            ))
                            return
                        }
                    }
                    ownerSecret = try AppRuntimeToken.rotateOwnerSecret()
                } catch {
                    continuation.resume(returning: .failure(
                        "Failed to prepare app runtime token: \(error.localizedDescription)"
                    ))
                    return
                }

                let process = Process()
                process.executableURL = URL(fileURLWithPath: executable)
                process.arguments = arguments
                process.standardOutput = stdoutPipe ?? FileHandle.nullDevice
                process.standardError = stderrPipe ?? FileHandle.nullDevice
                var env = NodeEnvironment.buildAppRuntimeEnv(executablePath: executable)
                #if TAXI_ACCEPTANCE_HARNESS
                for (key, value) in NodeEnvironment.appRuntimeAcceptanceOverrides() {
                    env[key] = value
                }
                #endif
                env["TAXI_ALLOW_NETWORK"] = "with-token"
                env["TAXI_APP_OWNED_RUNTIME"] = "1"
                // Pass owner-only credential locations, not credential values.
                // The Node child opens and validates the files itself, keeping
                // secrets out of its exec-time environment (`ps eww`).
                env["TAXI_APP_RUNTIME_TOKEN_PATH"] = AppRuntimeToken.tokenURL.path
                env["TAXI_APP_RUNTIME_OWNER_PATH"] = AppRuntimeToken.ownerSecretURL.path
                if let bridge = TaxiConstants.bundledBridgePath {
                    env["TAXI_BRIDGE_PATH"] = bridge
                }
                process.environment = env

                continuation.resume(returning: .success(
                    process,
                    expectedOwnerFingerprint: AppRuntimeToken.ownerFingerprint(for: ownerSecret),
                    runtimeMustMatchLaunchedProcess: runtimeMustMatchLaunchedProcess
                ))
            }
        }
    }

    // MARK: - Process Utilities

    nonisolated static func classifyRuntimeHealthResponse(
        statusCode: Int?,
        data: Data,
        expectedVersion: String = TaxiConstants.npmPackageVersion
    ) -> RuntimeHealthResponse {
        // Any HTTP response proves that a process owns the port. Only the
        // exact Taxi health contract is allowed to advance to version/auth
        // readiness; other responses block a competing child launch.
        guard statusCode != nil else { return .unavailable }
        guard let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let version = json["version"] as? String,
              version.count <= 64,
              version.range(
                  of: #"^[0-9]+(?:\.[0-9]+){2}(?:[-+][0-9A-Za-z.-]+)?$"#,
                  options: .regularExpression
              ) != nil
        else { return .occupiedUnrecognized }

        let readyContract = statusCode == 200 && (json["status"] as? String) == "ok"
        // The Node listener deliberately binds before its one process-wide
        // catalog warmup. Recognize only its exact bounded-warmup contract as
        // the same Taxi generation; treating that 503 as a port collision made
        // the native supervisor kill every cold restart before it could become
        // ready. This state still grants no ownership or stop authority.
        let warmingContract = statusCode == 503
            && (json["status"] as? String) == "warming"
            && (json["readiness"] as? String) == "warming"
            && (json["listener"] as? String) == "listening"
            && json["appOwned"] is Bool
        guard readyContract || warmingContract else { return .occupiedUnrecognized }

        // Runtimes predating the ownership bit remain diagnosable and usable,
        // but absence or a malformed value can never grant app ownership.
        let appOwned = json["appOwned"] as? Bool ?? false

        guard version == expectedVersion else {
            return .versionMismatch(found: version, expected: expectedVersion)
        }
        return .matching(version: version, appOwned: appOwned)
    }

    nonisolated static func completeRuntimeProbe(
        health: RuntimeHealthResponse,
        authenticatedReady: Bool
    ) -> RuntimeProbeResult {
        switch health {
        case .unavailable:
            return .unavailable
        case .occupiedUnrecognized:
            return .portOccupied
        case .versionMismatch(let found, let expected):
            return .versionMismatch(found: found, expected: expected)
        case .matching(let version, let appOwned):
            return appOwned && authenticatedReady
                ? .ready(version: version, appOwned: appOwned)
                : .authenticationFailed(version: version)
        }
    }

    /// Persisted policy describes a future app-owned start only when a fresh
    /// probe proves that no process is serving the reserved port. Every live,
    /// conflicting, mismatched, or authentication-failed result must be
    /// resolved from authenticated runtime evidence or rejected.
    nonisolated static func runtimeIsConfirmedUnavailable(_ probe: RuntimeProbeResult) -> Bool {
        if case .unavailable = probe { return true }
        return false
    }

    /// Recovery authority comes from an owned live process, never from a port
    /// diagnosis. In particular, a manual runtime or unrelated port collision
    /// must not become a kill target.
    nonisolated static func shouldRecoverOwnedRuntime(
        probe: RuntimeProbeResult,
        managedChildAlive: Bool,
        adoptedGenerationAlive: Bool
    ) -> Bool {
        guard managedChildAlive || adoptedGenerationAlive else { return false }
        if case .ready = probe { return false }
        return true
    }

    nonisolated static func classifyRuntimeTransportFailure(
        code: URLError.Code?
    ) -> RuntimeHealthResponse {
        // A refused localhost connection proves the port is available. A
        // timeout, TLS mismatch, or connection reset can all mean a raw/non-
        // HTTP listener owns it, so fail closed and block a competing launch.
        switch code {
        case .cannotConnectToHost, .cannotFindHost, .notConnectedToInternet:
            return .unavailable
        default:
            return .occupiedUnrecognized
        }
    }

    nonisolated static func probeAppOwnedRuntime() async -> RuntimeProbeResult {
        let health = await probeAppOwnedRuntimeHealth()
        switch health {
        case .matching(_, appOwned: true):
            return completeRuntimeProbe(
                health: health,
                authenticatedReady: await AppRuntimeClient.probe()
            )
        case .matching:
            return completeRuntimeProbe(health: health, authenticatedReady: false)
        case .unavailable, .occupiedUnrecognized, .versionMismatch:
            return completeRuntimeProbe(health: health, authenticatedReady: false)
        }
    }

    /// Recurring menu-bar polling proves endpoint health and generation
    /// ownership without creating MCP sessions or rebuilding the tool catalog.
    /// Full initialize/tools-list readiness remains on startup, onboarding, and
    /// explicit operational diagnosis paths through `probeAppOwnedRuntime()`.
    nonisolated static func probeAppOwnedRuntimeLightweight() async -> LightweightRuntimeProbeObservation {
        let health = await probeAppOwnedRuntimeHealth()
        switch health {
        case .matching(let version, appOwned: true):
            let evidence = await verifiedAdoptedRuntimeEvidence(expectedVersion: version)
            return completeLightweightRuntimeProbe(
                health: health,
                verifiedEvidence: evidence
            )
        case .matching:
            return LightweightRuntimeProbeObservation(
                probe: completeRuntimeProbe(health: health, authenticatedReady: false),
                verifiedEvidence: nil
            )
        case .unavailable, .occupiedUnrecognized, .versionMismatch:
            return LightweightRuntimeProbeObservation(
                probe: completeRuntimeProbe(health: health, authenticatedReady: false),
                verifiedEvidence: nil
            )
        }
    }

    nonisolated static func completeLightweightRuntimeProbe(
        health: RuntimeHealthResponse,
        verifiedEvidence: VerifiedOwnedRuntimeEvidence?
    ) -> LightweightRuntimeProbeObservation {
        LightweightRuntimeProbeObservation(
            probe: completeRuntimeProbe(
                health: health,
                authenticatedReady: verifiedEvidence != nil
            ),
            verifiedEvidence: verifiedEvidence
        )
    }

    private nonisolated static func probeAppOwnedRuntimeHealth() async -> RuntimeHealthResponse {
        guard let url = URL(string: TaxiConstants.appOwnedHealthURL) else { return .unavailable }
        var request = URLRequest(url: url)
        request.timeoutInterval = 1.0

        let health: RuntimeHealthResponse
        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            health = classifyRuntimeHealthResponse(
                statusCode: (response as? HTTPURLResponse)?.statusCode,
                data: data
            )
        } catch let error as URLError {
            health = classifyRuntimeTransportFailure(code: error.code)
        } catch {
            health = classifyRuntimeTransportFailure(code: nil)
        }
        return health
    }

    /// Convert authenticated runtime-state into lifecycle authority only when
    /// its version and current-user owner fingerprint match this installation.
    /// The public `appOwned` health bit alone is never sufficient.
    nonisolated static func authenticatedOwnedRuntimeIdentity(
        state: AppRuntimeState,
        expectedVersion: String,
        expectedOwnerFingerprint: String?
    ) -> AppOwnedRuntimeIdentity? {
        guard state.status == "ok",
              state.version == expectedVersion,
              state.appOwned,
              let expectedOwnerFingerprint,
              state.ownerFingerprint == expectedOwnerFingerprint
        else { return nil }
        return state.ownedIdentity
    }

    nonisolated static func verifiedAdoptedRuntimeIdentity(
        for probe: RuntimeProbeResult
    ) async -> AppOwnedRuntimeIdentity? {
        guard case .ready(let version, appOwned: true) = probe,
              let state = try? await AppRuntimeClient.runtimeState(),
              let expectedOwnerFingerprint = try? AppRuntimeToken.expectedOwnerFingerprint()
        else { return nil }
        return authenticatedOwnedRuntimeIdentity(
            state: state,
            expectedVersion: version,
            expectedOwnerFingerprint: expectedOwnerFingerprint
        )
    }

    /// Bind authenticated owner evidence to one kernel process generation. The
    /// second owner-secret challenge brackets the receipt capture, preventing a
    /// PID that exited and was reused between the runtime-state response and
    /// `proc_pidinfo` from becoming a later termination target.
    nonisolated static func verifiedAdoptedRuntimeEvidence(
        for probe: RuntimeProbeResult
    ) async -> VerifiedOwnedRuntimeEvidence? {
        guard case .ready(let version, appOwned: true) = probe else { return nil }
        return await verifiedAdoptedRuntimeEvidence(expectedVersion: version)
    }

    private nonisolated static func verifiedAdoptedRuntimeEvidence(
        expectedVersion: String
    ) async -> VerifiedOwnedRuntimeEvidence? {
        guard let state = try? await AppRuntimeClient.runtimeState(),
              let expectedOwnerFingerprint = try? AppRuntimeToken.expectedOwnerFingerprint(),
              let identity = authenticatedOwnedRuntimeIdentity(
                  state: state,
                  expectedVersion: expectedVersion,
                  expectedOwnerFingerprint: expectedOwnerFingerprint
              ),
              let receipt = await confirmedProcessGenerationReceipt(for: identity)
        else { return nil }
        return VerifiedOwnedRuntimeEvidence(identity: identity, processReceipt: receipt)
    }

    private nonisolated static func confirmedProcessGenerationReceipt(
        for identity: AppOwnedRuntimeIdentity
    ) async -> RuntimeProcessGenerationReceipt? {
        guard let receipt = processGenerationReceipt(for: identity.processIdentifier),
              let listener = try? await AppRuntimeClient.verifyListenerOwnership(requestTimeout: 1),
              listener.challenge.pid == Int(identity.processIdentifier),
              processMatchesGenerationReceipt(receipt)
        else { return nil }
        return receipt
    }

    /// Stop an adopted runtime without requiring its HTTP listener to remain up
    /// throughout graceful shutdown. The authenticated endpoint establishes the
    /// initial identity; a kernel process-generation receipt keeps later
    /// escalation safe after `httpServer.close()` removes the listener.
    nonisolated static func terminateVerifiedAdoptedRuntime(
        _ expectedIdentity: AppOwnedRuntimeIdentity,
        cachedReceipt: RuntimeProcessGenerationReceipt? = nil,
        gracefulTimeout: TimeInterval = gracefulTerminationTimeoutSeconds
    ) async -> RuntimeTerminationOutcome {
        var receipt: RuntimeProcessGenerationReceipt?
        if let cachedReceipt,
           cachedReceipt.processIdentifier == expectedIdentity.processIdentifier,
           processMatchesGenerationReceipt(cachedReceipt) {
            // The listener may already be gone or unable to answer. A receipt
            // captured while that same PID proved the owner fingerprint remains
            // sufficient to signal only that unchanged process generation.
            receipt = cachedReceipt
        }
        if receipt == nil {
            let initialProbe = await probeAppOwnedRuntime()
            if await verifiedAdoptedRuntimeIdentity(for: initialProbe) == expectedIdentity,
               let captured = await confirmedProcessGenerationReceipt(for: expectedIdentity) {
                receipt = captured
            }
        }
        guard let receipt,
              processMatchesGenerationReceipt(receipt)
        else {
            if Darwin.kill(expectedIdentity.processIdentifier, 0) == -1, errno == ESRCH {
                return .alreadyExited
            }
            return .identityLost
        }
        guard signalProcess(matching: receipt, signal: SIGTERM) else {
            return processMatchesGenerationReceipt(receipt) ? .stillRunning : .alreadyExited
        }

        let gracefulSteps = max(1, Int(ceil(max(0, gracefulTimeout) * 10)))
        for _ in 0..<gracefulSteps {
            try? await Task.sleep(for: .milliseconds(100))
            if !processMatchesGenerationReceipt(receipt) { return .graceful }
        }

        // No endpoint re-probe here: the ordinary Node shutdown hook closes the
        // listener before governed-call drain and audit finalization complete.
        // The unchanged kernel receipt is the PID-reuse-safe escalation gate.
        guard signalProcess(matching: receipt, signal: SIGKILL)
        else {
            return processMatchesGenerationReceipt(receipt) ? .stillRunning : .graceful
        }
        let forcedSteps = max(1, Int(ceil(forcedTerminationObservationSeconds * 10)))
        for _ in 0..<forcedSteps {
            try? await Task.sleep(for: .milliseconds(100))
            if !processMatchesGenerationReceipt(receipt) { return .forced }
        }
        return .stillRunning
    }

    /// AppKit's termination callback is synchronous. Re-read the authenticated
    /// endpoint with a short bound before using the cached identity so PID reuse
    /// cannot turn application shutdown into a signal for another process.
    private nonisolated static func terminateVerifiedAdoptedRuntimeSynchronously(
        _ expectedIdentity: AppOwnedRuntimeIdentity
    ) {
        guard let state = synchronousRuntimeState(
                  timeout: 0.75,
                  expectedProcessIdentifier: expectedIdentity.processIdentifier
              ),
              let expectedOwnerFingerprint = try? AppRuntimeToken.expectedOwnerFingerprint(),
              authenticatedOwnedRuntimeIdentity(
                  state: state,
                  expectedVersion: TaxiConstants.npmPackageVersion,
                  expectedOwnerFingerprint: expectedOwnerFingerprint
              ) == expectedIdentity,
              let receipt = processGenerationReceipt(
                  for: expectedIdentity.processIdentifier
              ),
              let confirmingListener = AppRuntimeClient.verifyListenerOwnershipSynchronously(
                  timeout: 0.25
              ),
              confirmingListener.challenge.pid == Int(expectedIdentity.processIdentifier),
              processMatchesGenerationReceipt(receipt)
        else { return }
        _ = signalProcess(matching: receipt, signal: SIGTERM)
    }

    private nonisolated static func synchronousRuntimeState(
        timeout: TimeInterval,
        expectedProcessIdentifier: Int32
    ) -> AppRuntimeState? {
        let startedAt = Date()
        guard let listener = AppRuntimeClient.verifyListenerOwnershipSynchronously(
                  timeout: min(0.4, timeout)
              ),
              listener.challenge.pid == Int(expectedProcessIdentifier),
              let url = URL(string: TaxiConstants.appOwnedRuntimeStateURL)
        else { return nil }
        let remaining = timeout - Date().timeIntervalSince(startedAt)
        guard remaining > 0 else { return nil }

        var request = URLRequest(url: url)
        request.timeoutInterval = remaining
        request.setValue("Bearer \(listener.authorizationToken)", forHTTPHeaderField: "Authorization")
        let box = SynchronousRuntimeStateBox()
        let semaphore = DispatchSemaphore(value: 0)
        let task = URLSession.shared.dataTask(with: request) { data, response, _ in
            defer { semaphore.signal() }
            guard let http = response as? HTTPURLResponse,
                  http.statusCode == 200,
                  let data,
                  let state = try? JSONDecoder().decode(AppRuntimeState.self, from: data),
                  state.pid == listener.challenge.pid
            else { return }
            box.store(state)
        }
        task.resume()
        guard semaphore.wait(timeout: .now() + remaining) == .success else {
            task.cancel()
            return nil
        }
        return box.load()
    }

    /// Returns the exact version of the authenticated app-owned runtime at the
    /// reserved endpoint. A bare health response is not sufficient: the
    /// runtime must first prove the current-user generation secret, then complete
    /// an MCP initialize/tools-list round trip with generation-scoped authorization.
    nonisolated static func authenticatedRuntimeVersionAtAppEndpoint() async -> String? {
        guard case .ready(let version, _) = await probeAppOwnedRuntime() else { return nil }
        return version
    }

    private nonisolated static func waitForAppOwnedRuntime() async -> RuntimeProbeResult {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(
            by: .milliseconds(Int64(appOwnedReadinessTimeoutSeconds * 1_000))
        )
        var lastProbe: RuntimeProbeResult = .unavailable
        while clock.now < deadline {
            let probe = await boundedAppOwnedRuntimeProbe()
            switch probe {
            case .ready, .portOccupied, .versionMismatch:
                return probe
            case .unavailable, .authenticationFailed:
                lastProbe = probe
            }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
        return lastProbe
    }

    private nonisolated static func boundedAppOwnedRuntimeProbe() async -> RuntimeProbeResult {
        await withTaskGroup(of: RuntimeProbeResult.self) { group in
            group.addTask { await probeAppOwnedRuntime() }
            group.addTask {
                try? await Task.sleep(for: individualReadinessProbeTimeout)
                return .unavailable
            }
            let first = await group.next() ?? .unavailable
            group.cancelAll()
            return first
        }
    }

    private var liveOwnedRuntimeProcessIdentifier: Int32? {
        if let serverProcess,
           let serverProcessReceipt,
           serverProcessReceipt.processIdentifier == serverProcess.processIdentifier,
           Self.processMatchesGenerationReceipt(serverProcessReceipt) {
            return serverProcessReceipt.processIdentifier
        }
        if let ownedRuntimeProcessReceipt,
           Self.processMatchesGenerationReceipt(ownedRuntimeProcessReceipt) {
            return ownedRuntimeProcessReceipt.processIdentifier
        }
        return nil
    }

    /// A listener can disappear while its owned process remains alive (for
    /// example, a transport close followed by a stuck audit finalizer). Confirm
    /// the condition once, stop only the retained process generation, and resume
    /// it only when the user had already enabled runtime recovery.
    private func scheduleDegradedRuntimeRecoveryIfNeeded(
        for observedProbe: RuntimeProbeResult
    ) {
        let managedChildAlive = serverProcessReceipt.map {
            Self.processMatchesGenerationReceipt($0)
        } ?? false
        let adoptedGenerationAlive = ownedRuntimeProcessReceipt.map {
            Self.processMatchesGenerationReceipt($0)
        } ?? false
        guard degradedRecoveryAttemptID == nil,
              degradedRecoverySuspendedUntil.map({ $0 <= Date() }) ?? true,
              !isShuttingDown,
              !onboardingActivationInProgress,
              startAttemptID == nil,
              stopOperationGeneration == nil,
              Self.shouldRecoverOwnedRuntime(
                  probe: observedProbe,
                  managedChildAlive: managedChildAlive,
                  adoptedGenerationAlive: adoptedGenerationAlive
              )
        else { return }

        let attemptID = UUID()
        let capturedGeneration = operationGate.generation
        degradedRecoveryAttemptID = attemptID
        Task {
            try? await Task.sleep(for: Self.degradedRuntimeConfirmationDelay)
            guard degradedRecoveryAttemptID == attemptID else { return }
            guard operationGate.accepts(capturedGeneration),
                  !isShuttingDown,
                  !onboardingActivationInProgress,
                  startAttemptID == nil,
                  stopOperationGeneration == nil
            else {
                degradedRecoveryAttemptID = nil
                return
            }

            let confirmation = await Self.probeAppOwnedRuntimeLightweight()
            guard degradedRecoveryAttemptID == attemptID else { return }
            guard operationGate.accepts(capturedGeneration) else {
                degradedRecoveryAttemptID = nil
                return
            }
            let confirmedManagedChildAlive = serverProcessReceipt.map {
                Self.processMatchesGenerationReceipt($0)
            } ?? false
            let confirmedAdoptedGenerationAlive = ownedRuntimeProcessReceipt.map {
                Self.processMatchesGenerationReceipt($0)
            } ?? false
            guard Self.shouldRecoverOwnedRuntime(
                probe: confirmation.probe,
                managedChildAlive: confirmedManagedChildAlive,
                adoptedGenerationAlive: confirmedAdoptedGenerationAlive
            ) else {
                degradedRecoveryAttemptID = nil
                applyRuntimeProbe(
                    confirmation.probe,
                    preserveExistingErrorWhenUnavailable: false,
                    verifiedAdoptedIdentity: confirmation.verifiedEvidence?.identity,
                    verifiedProcessReceipt: confirmation.verifiedEvidence?.processReceipt
                )
                return
            }

            guard liveOwnedRuntimeProcessIdentifier != nil else {
                degradedRecoveryAttemptID = nil
                if let serverProcess, !serverProcess.isRunning {
                    detachTerminationHandlerIntentionally(from: serverProcess)
                    clearTerminationHandlerState(for: serverProcess)
                    self.serverProcess = nil
                    self.serverProcessReceipt = nil
                }
                clearOwnedRuntimeIdentity()
                applyRuntimeProbe(.unavailable, preserveExistingErrorWhenUnavailable: false)
                return
            }

            guard canAttemptDegradedRecovery() else {
                // This attempt is finished even though the rate limiter is now
                // holding recovery. Clear the in-flight marker so a later poll
                // can retry after `degradedRecoverySuspendedUntil` expires.
                degradedRecoveryAttemptID = nil
                let message = L(
                    "server.runtimeRecoveryExhausted",
                    Self.maxRestartAttempts,
                    Int(Self.restartWindowSeconds / 60)
                )
                logManager?.append(message, isError: true)
                // Launch/process errors are intentionally preserved across an
                // unavailable poll; use that same diagnostic lifetime.
                lastRuntimeDiagnostic = nil
                status = .error(message)
                return
            }

            let shouldRestart = autoStartEnabled
            logManager?.append(
                "Owned runtime process remained alive after authenticated readiness failed; starting bounded recovery",
                isError: true
            )
            degradedRecoveryAttemptID = nil
            stopServer()
            guard await waitForRuntimeOperationsToSettle(
                timeout: .seconds(Int(Self.gracefulTerminationTimeoutSeconds + 3))
            ), !isShuttingDown else { return }

            // A failed/identity-lost stop deliberately retains its target. Do
            // not launch a second runtime merely because the first listener is
            // gone and the port appears free.
            guard serverProcess?.isRunning != true,
                  ownedRuntimeIdentity == nil
            else { return }

            let stoppedProbe = await Self.probeAppOwnedRuntime()
            guard case .unavailable = stoppedProbe else {
                let stoppedEvidence = await Self.verifiedAdoptedRuntimeEvidence(for: stoppedProbe)
                applyRuntimeProbe(
                    stoppedProbe,
                    preserveExistingErrorWhenUnavailable: false,
                    verifiedAdoptedIdentity: stoppedEvidence?.identity,
                    verifiedProcessReceipt: stoppedEvidence?.processReceipt
                )
                return
            }
            if shouldRestart {
                let restartGeneration = operationGate.generation
                logManager?.append("Restarting recovered runtime in 3 seconds...", isError: false)
                try? await Task.sleep(for: .seconds(3))
                guard operationGate.accepts(restartGeneration),
                      autoStartEnabled,
                      !isShuttingDown,
                      serverProcess?.isRunning != true,
                      ownedRuntimeIdentity == nil,
                      startAttemptID == nil,
                      stopOperationGeneration == nil
                else { return }
                startServer()
            } else {
                applyRuntimeProbe(.unavailable, preserveExistingErrorWhenUnavailable: false)
            }
        }
    }

    // MARK: - Display Helpers

    func applyRuntimeProbe(
        _ probe: RuntimeProbeResult,
        preserveExistingErrorWhenUnavailable: Bool,
        verifiedAdoptedIdentity: AppOwnedRuntimeIdentity? = nil,
        verifiedProcessReceipt: RuntimeProcessGenerationReceipt? = nil
    ) {
        if case .unavailable = probe {
            // Keep a deep-link request alive until the managed Process delivers
            // its termination callback or a later retry can launch the child.
        } else {
            connectorRuntimeStartRequested = false
        }
        switch probe {
        case .ready(let version, appOwned: true):
            // A public ownership bit and even the shared HTTP token are not
            // process authority. Only authenticated PID + per-launch owner
            // fingerprint evidence opens lifecycle controls.
            degradedRecoveryAttemptID = nil
            guard let verifiedAdoptedIdentity,
                  let verifiedProcessReceipt,
                  verifiedProcessReceipt.processIdentifier
                    == verifiedAdoptedIdentity.processIdentifier,
                  Self.processMatchesGenerationReceipt(verifiedProcessReceipt)
            else {
                // Do not let a stale /health result restore `.running` after
                // owner challenge or generation attestation has failed. Retain
                // any still-exact prior receipt only as stop authority.
                if liveOwnedRuntimeProcessIdentifier == nil {
                    clearOwnedRuntimeIdentity()
                }
                setRuntimeDiagnostic(
                    L("server.runtimePortOwnerConflict", TaxiConstants.appOwnedHttpPort, version)
                )
                return
            }
            rememberOwnedRuntimeIdentity(
                verifiedAdoptedIdentity,
                processReceipt: verifiedProcessReceipt
            )
            guard ownedRuntimeIdentity == verifiedAdoptedIdentity,
                  ownedRuntimeProcessReceipt == verifiedProcessReceipt
            else {
                clearOwnedRuntimeIdentity()
                setRuntimeDiagnostic(
                    L("server.runtimePortOwnerConflict", TaxiConstants.appOwnedHttpPort, version)
                )
                return
            }
            lastRuntimeDiagnostic = nil
            status = .running
        case .ready(_, appOwned: false):
            degradedRecoveryAttemptID = nil
            clearOwnedRuntimeIdentity()
            lastRuntimeDiagnostic = nil
            status = .running
        case .versionMismatch(let found, let expected):
            degradedRecoveryAttemptID = nil
            if liveOwnedRuntimeProcessIdentifier == nil { clearOwnedRuntimeIdentity() }
            setRuntimeDiagnostic(
                L("server.runtimeVersionConflict", TaxiConstants.appOwnedHttpPort, found, expected)
            )
        case .authenticationFailed(let version):
            degradedRecoveryAttemptID = nil
            if liveOwnedRuntimeProcessIdentifier == nil { clearOwnedRuntimeIdentity() }
            setRuntimeDiagnostic(
                L("server.runtimePortOwnerConflict", TaxiConstants.appOwnedHttpPort, version)
            )
        case .portOccupied:
            degradedRecoveryAttemptID = nil
            if liveOwnedRuntimeProcessIdentifier == nil { clearOwnedRuntimeIdentity() }
            setRuntimeDiagnostic(
                L("server.runtimePortOccupied", TaxiConstants.appOwnedHttpPort)
            )
        case .unavailable:
            if let degradedRecoverySuspendedUntil,
               degradedRecoverySuspendedUntil > Date(),
               case .error = status {
                return
            }
            if let processIdentifier = liveOwnedRuntimeProcessIdentifier {
                setRuntimeDiagnostic(
                    L(
                        "server.runtimeProcessWithoutListener",
                        Int(processIdentifier),
                        TaxiConstants.appOwnedHttpPort
                    )
                )
                return
            }
            degradedRecoveryAttemptID = nil
            clearOwnedRuntimeIdentity()
            if lastRuntimeDiagnostic != nil {
                lastRuntimeDiagnostic = nil
                status = .stopped
            } else if !preserveExistingErrorWhenUnavailable {
                status = .stopped
            } else if case .error = status {
                // Preserve a process launch failure until a healthy runtime or
                // a more actionable port-owner diagnosis supersedes it.
            } else {
                status = .stopped
            }
        }
    }

    private func setRuntimeDiagnostic(_ message: String) {
        if lastRuntimeDiagnostic != message {
            logManager?.append(message, isError: true)
            lastRuntimeDiagnostic = message
        }
        status = .error(message)
    }

    var statusLabel: String {
        switch status {
        case .running: L("server.running")
        case .stopped: L("server.stopped")
        case .checking: L("server.checking")
        case .error(let message): message
        }
    }

    var statusIcon: String {
        switch status {
        case .running: "circle.fill"
        case .stopped: "circle"
        case .checking: "circle.dotted"
        case .error: "exclamationmark.triangle.fill"
        }
    }
}
