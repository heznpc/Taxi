import Darwin
import Foundation
import XCTest
@testable import TaxiApp

final class SingleInstanceAndRuntimeProbeTests: XCTestCase {
    private func waitForGenerationExit(
        _ receipt: RuntimeProcessGenerationReceipt,
        attempts: Int = 100
    ) async -> Bool {
        for _ in 0..<attempts {
            if !ServerManager.processMatchesGenerationReceipt(receipt) { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return !ServerManager.processMatchesGenerationReceipt(receipt)
    }

    func testRuntimeStartURLPolicyAcceptsOnlyTheCanonicalRoute() throws {
        XCTAssertTrue(
            RuntimeStartURLPolicy.accepts(
                try XCTUnwrap(URL(string: RuntimeStartURLPolicy.canonicalURL))
            )
        )
        for rejected in [
            "taxi://runtime",
            "taxi://runtime/start/",
            "taxi://runtime/start?source=connector",
            "taxi://runtime/start#fragment",
            "taxi://trust/start",
            "https://runtime/start",
        ] {
            XCTAssertFalse(
                RuntimeStartURLPolicy.accepts(try XCTUnwrap(URL(string: rejected))),
                rejected
            )
        }
    }

    func testRuntimeOperationGenerationRejectsStaleWork() {
        var gate = RuntimeOperationGate()
        let startGeneration = gate.advance()
        XCTAssertTrue(gate.accepts(startGeneration))

        let stopGeneration = gate.advance()
        XCTAssertFalse(gate.accepts(startGeneration))
        XCTAssertTrue(gate.accepts(stopGeneration))
    }

    func testReadinessUsesABoundedWallClockBudget() {
        XCTAssertGreaterThan(ServerManager.appOwnedReadinessTimeoutSeconds, 0)
        XCTAssertLessThanOrEqual(ServerManager.appOwnedReadinessTimeoutSeconds, 15)
    }

    func testExplicitAutoStartConsentCommitsOnlyForVerifiedAppOwnedReadiness() {
        let appOwned = ServerManager.RuntimeProbeResult.ready(
            version: "2.16.0",
            appOwned: true
        )
        XCTAssertTrue(
            ServerManager.shouldCommitExplicitAutoStart(
                requested: true,
                probe: appOwned,
                hasVerifiedIdentity: true
            )
        )
        XCTAssertFalse(
            ServerManager.shouldCommitExplicitAutoStart(
                requested: true,
                probe: appOwned,
                hasVerifiedIdentity: false
            )
        )
        XCTAssertFalse(
            ServerManager.shouldCommitExplicitAutoStart(
                requested: false,
                probe: appOwned,
                hasVerifiedIdentity: true
            )
        )

        for rejected in [
            ServerManager.RuntimeProbeResult.ready(version: "2.16.0", appOwned: false),
            .unavailable,
            .portOccupied,
            .versionMismatch(found: "2.15.0", expected: "2.16.0"),
            .authenticationFailed(version: "2.16.0"),
        ] {
            XCTAssertFalse(
                ServerManager.shouldCommitExplicitAutoStart(
                    requested: true,
                    probe: rejected,
                    hasVerifiedIdentity: true
                ),
                "Unexpected auto-start consent for \(rejected)"
            )
        }
    }

    func testScheduledRestartRequiresCurrentGenerationAndAutoStart() {
        XCTAssertTrue(
            ServerManager.shouldPerformScheduledRestart(
                capturedGeneration: 4,
                currentGeneration: 4,
                autoStartEnabled: true,
                stopInProgress: false
            )
        )
        XCTAssertFalse(
            ServerManager.shouldPerformScheduledRestart(
                capturedGeneration: 4,
                currentGeneration: 5,
                autoStartEnabled: true,
                stopInProgress: false
            )
        )
        XCTAssertFalse(
            ServerManager.shouldPerformScheduledRestart(
                capturedGeneration: 4,
                currentGeneration: 4,
                autoStartEnabled: false,
                stopInProgress: false
            )
        )
        XCTAssertFalse(
            ServerManager.shouldPerformScheduledRestart(
                capturedGeneration: 4,
                currentGeneration: 4,
                autoStartEnabled: true,
                stopInProgress: true
            )
        )
    }

    func testPreparedLaunchCannotCommitAfterTerminationInvalidatesItsGeneration() {
        let attemptID = UUID()
        XCTAssertTrue(
            ServerManager.shouldCommitPreparedLaunch(
                capturedGeneration: 8,
                currentGeneration: 8,
                expectedAttemptID: attemptID,
                currentAttemptID: attemptID,
                isShuttingDown: false
            )
        )
        XCTAssertFalse(
            ServerManager.shouldCommitPreparedLaunch(
                capturedGeneration: 8,
                currentGeneration: 9,
                expectedAttemptID: attemptID,
                currentAttemptID: attemptID,
                isShuttingDown: true
            )
        )
        XCTAssertFalse(
            ServerManager.shouldCommitPreparedLaunch(
                capturedGeneration: 8,
                currentGeneration: 8,
                expectedAttemptID: attemptID,
                currentAttemptID: nil,
                isShuttingDown: false
            )
        )
    }

    func testHandlerDeliveredExitZeroStillRequiresRecovery() {
        XCTAssertTrue(
            ServerManager.shouldRecoverFromHandlerDeliveredTermination(
                exitCode: 0,
                reason: .exit
            )
        )
        XCTAssertTrue(
            ServerManager.shouldRecoverFromHandlerDeliveredTermination(
                exitCode: SIGTERM,
                reason: .uncaughtSignal
            )
        )
    }

    func testConnectorRecoveryProbesWithoutTrustingCachedRunningStatus() {
        XCTAssertTrue(
            ServerManager.shouldProbeConnectorRuntimeStart(
                autoStartEnabled: true,
                hasExistingToken: true,
                isShuttingDown: false,
                managedProcessIsRunning: false,
                startInProgress: false,
                stopInProgress: false
            )
        )
        XCTAssertFalse(
            ServerManager.shouldProbeConnectorRuntimeStart(
                autoStartEnabled: false,
                hasExistingToken: true,
                isShuttingDown: false,
                managedProcessIsRunning: false,
                startInProgress: false,
                stopInProgress: false
            )
        )
        XCTAssertFalse(
            ServerManager.shouldProbeConnectorRuntimeStart(
                autoStartEnabled: true,
                hasExistingToken: true,
                isShuttingDown: false,
                managedProcessIsRunning: true,
                startInProgress: false,
                stopInProgress: false
            )
        )
        XCTAssertFalse(
            ServerManager.shouldProbeConnectorRuntimeStart(
                autoStartEnabled: true,
                hasExistingToken: true,
                isShuttingDown: false,
                managedProcessIsRunning: false,
                startInProgress: true,
                stopInProgress: false
            )
        )
        XCTAssertFalse(
            ServerManager.shouldProbeConnectorRuntimeStart(
                autoStartEnabled: true,
                hasExistingToken: false,
                isShuttingDown: false,
                managedProcessIsRunning: false,
                startInProgress: false,
                stopInProgress: false
            )
        )
    }

    func testPendingConnectorRequestResumesOnlyAfterAuthorizedTermination() {
        XCTAssertTrue(
            ServerManager.shouldResumeConnectorRuntimeAfterTermination(
                requestPending: true,
                autoStartEnabled: true,
                isShuttingDown: false
            )
        )
        XCTAssertFalse(
            ServerManager.shouldResumeConnectorRuntimeAfterTermination(
                requestPending: false,
                autoStartEnabled: true,
                isShuttingDown: false
            )
        )
        XCTAssertFalse(
            ServerManager.shouldResumeConnectorRuntimeAfterTermination(
                requestPending: true,
                autoStartEnabled: false,
                isShuttingDown: false
            )
        )
        XCTAssertFalse(
            ServerManager.shouldResumeConnectorRuntimeAfterTermination(
                requestPending: true,
                autoStartEnabled: true,
                isShuttingDown: true
            )
        )
    }

    func testFailedLaunchTerminatorStopsTheOwnedChild() async throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sleep")
        process.arguments = ["30"]
        try process.run()
        XCTAssertTrue(process.isRunning)
        let receipt = try XCTUnwrap(
            ServerManager.processGenerationReceipt(forLaunchedProcess: process)
        )

        await ServerManager.terminateOwnedProcess(process, processReceipt: receipt)

        XCTAssertFalse(process.isRunning)
    }

    func testManagedTerminationHonorsNodeBudgetThenEscalatesAnIgnoringChild() async throws {
        XCTAssertGreaterThan(ServerManager.gracefulTerminationTimeoutSeconds, 5)
        XCTAssertLessThanOrEqual(ServerManager.gracefulTerminationTimeoutSeconds, 7)
        XCTAssertGreaterThan(
            ServerManager.applicationTerminationTimeoutSeconds,
            ServerManager.gracefulTerminationTimeoutSeconds
        )
        XCTAssertLessThanOrEqual(ServerManager.applicationTerminationTimeoutSeconds, 8)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = ["-c", "trap '' TERM; exec /bin/sleep 30"]
        try process.run()
        try await Task.sleep(for: .milliseconds(150))
        XCTAssertTrue(process.isRunning)
        let receipt = try XCTUnwrap(
            ServerManager.processGenerationReceipt(forLaunchedProcess: process)
        )

        let outcome = await ServerManager.terminateOwnedProcess(
            process,
            processReceipt: receipt,
            gracefulTimeout: 0.1
        )

        XCTAssertEqual(outcome, .forced)
        XCTAssertFalse(process.isRunning)
    }

    func testAdoptedTerminationEscalatesFromCachedGenerationAfterListenerLoss() async throws {
        let target = Process()
        target.executableURL = URL(fileURLWithPath: "/bin/sh")
        target.arguments = ["-c", "trap '' TERM; exec /bin/sleep 30"]
        let unrelated = Process()
        unrelated.executableURL = URL(fileURLWithPath: "/bin/sleep")
        unrelated.arguments = ["30"]
        try target.run()
        try unrelated.run()
        defer {
            if target.isRunning { target.terminate() }
            if unrelated.isRunning { unrelated.terminate() }
        }
        try await Task.sleep(for: .milliseconds(150))
        let identity = try XCTUnwrap(
            AppOwnedRuntimeIdentity(
                processIdentifier: Int(target.processIdentifier),
                ownerFingerprint: String(repeating: "d", count: 64)
            )
        )
        let receipt = try XCTUnwrap(
            ServerManager.processGenerationReceipt(for: target.processIdentifier)
        )

        let outcome = await ServerManager.terminateVerifiedAdoptedRuntime(
            identity,
            cachedReceipt: receipt,
            gracefulTimeout: 0.1
        )

        XCTAssertEqual(outcome, .forced)
        XCTAssertFalse(target.isRunning)
        XCTAssertTrue(unrelated.isRunning)
    }

    func testProcessGenerationReceiptRejectsStaleBirthIdentityBeforeSignal() async throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sleep")
        process.arguments = ["30"]
        try process.run()
        defer {
            if process.isRunning { process.terminate() }
        }
        let receipt = try XCTUnwrap(
            ServerManager.processGenerationReceipt(for: process.processIdentifier)
        )
        XCTAssertTrue(ServerManager.processMatchesGenerationReceipt(receipt))

        let staleReceipt = RuntimeProcessGenerationReceipt(
            processIdentifier: receipt.processIdentifier,
            userIdentifier: receipt.userIdentifier,
            startTimeSeconds: receipt.startTimeSeconds,
            startTimeMicroseconds: receipt.startTimeMicroseconds &+ 1,
            executablePath: receipt.executablePath
        )
        XCTAssertFalse(ServerManager.processMatchesGenerationReceipt(staleReceipt))
        XCTAssertFalse(ServerManager.signalProcess(matching: staleReceipt, signal: SIGKILL))
        XCTAssertTrue(process.isRunning)

        let staleTermination = await ServerManager.terminateOwnedProcess(
            process,
            processReceipt: staleReceipt,
            gracefulTimeout: 0
        )
        XCTAssertEqual(staleTermination, .identityLost)
        XCTAssertTrue(process.isRunning)

        _ = await ServerManager.terminateOwnedProcess(
            process,
            processReceipt: receipt
        )
    }

    func testProcessGenerationAncestryRequiresTwoLiveExactReceipts() async throws {
        let output = Pipe()
        let parent = Process()
        parent.executableURL = URL(fileURLWithPath: "/bin/sh")
        parent.arguments = ["-c", "/bin/sleep 30 & child=$!; echo $child; wait $child"]
        parent.standardOutput = output
        try parent.run()

        let line = output.fileHandleForReading.availableData
        let childPID = try XCTUnwrap(
            Int32(String(decoding: line, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines))
        )
        let parentReceipt = try XCTUnwrap(
            ServerManager.processGenerationReceipt(forLaunchedProcess: parent)
        )
        let childReceipt = try XCTUnwrap(
            ServerManager.processGenerationReceipt(for: childPID)
        )
        defer {
            if ServerManager.processMatchesGenerationReceipt(childReceipt) {
                _ = ServerManager.signalProcess(matching: childReceipt, signal: SIGKILL)
            }
            if parent.isRunning {
                parent.terminate()
            }
        }

        XCTAssertTrue(
            ServerManager.processGeneration(childReceipt, isDescendantOf: parentReceipt)
        )
        XCTAssertFalse(
            ServerManager.processGeneration(parentReceipt, isDescendantOf: childReceipt)
        )

        let staleParent = RuntimeProcessGenerationReceipt(
            processIdentifier: parentReceipt.processIdentifier,
            userIdentifier: parentReceipt.userIdentifier,
            startTimeSeconds: parentReceipt.startTimeSeconds,
            startTimeMicroseconds: parentReceipt.startTimeMicroseconds &+ 1,
            executablePath: parentReceipt.executablePath
        )
        XCTAssertFalse(
            ServerManager.processGeneration(childReceipt, isDescendantOf: staleParent)
        )

        let ownerFingerprint = String(repeating: "f", count: 64)
        let childIdentity = try XCTUnwrap(
            AppOwnedRuntimeIdentity(
                processIdentifier: Int(childPID),
                ownerFingerprint: ownerFingerprint
            )
        )
        let childEvidence = VerifiedOwnedRuntimeEvidence(
            identity: childIdentity,
            processReceipt: childReceipt
        )
        XCTAssertTrue(
            ServerManager.launchReadinessEvidenceMatches(
                expectedOwnerFingerprint: ownerFingerprint,
                evidence: childEvidence,
                launchedProcessReceipt: parentReceipt,
                requiresExactProcess: false
            )
        )
        XCTAssertFalse(
            ServerManager.launchReadinessEvidenceMatches(
                expectedOwnerFingerprint: ownerFingerprint,
                evidence: childEvidence,
                launchedProcessReceipt: parentReceipt,
                requiresExactProcess: true
            )
        )
        XCTAssertFalse(
            ServerManager.launchReadinessEvidenceMatches(
                expectedOwnerFingerprint: String(repeating: "e", count: 64),
                evidence: childEvidence,
                launchedProcessReceipt: parentReceipt,
                requiresExactProcess: false
            )
        )

        _ = await ServerManager.terminateOwnedProcess(
            parent,
            processReceipt: parentReceipt,
            gracefulTimeout: 0.1
        )
    }

    func testSingleInstancePolicySelectsOldestLiveMatchingProcess() {
        let now = Date()
        let candidates = [
            RunningApplicationSnapshot(
                processIdentifier: 900,
                bundleIdentifier: "app.taxi",
                launchDate: now,
                isTerminated: false
            ),
            RunningApplicationSnapshot(
                processIdentifier: 100,
                bundleIdentifier: "app.taxi",
                launchDate: now.addingTimeInterval(-60),
                isTerminated: false
            ),
            RunningApplicationSnapshot(
                processIdentifier: 200,
                bundleIdentifier: "app.taxi",
                launchDate: now.addingTimeInterval(-30),
                isTerminated: false
            ),
            RunningApplicationSnapshot(
                processIdentifier: 50,
                bundleIdentifier: "app.taxi",
                launchDate: now.addingTimeInterval(-120),
                isTerminated: true
            ),
            RunningApplicationSnapshot(
                processIdentifier: 25,
                bundleIdentifier: "com.example.Other",
                launchDate: now.addingTimeInterval(-180),
                isTerminated: false
            ),
        ]

        XCTAssertEqual(
            SingleInstancePolicy.existingProcessIdentifier(
                bundleIdentifier: "app.taxi",
                currentProcessIdentifier: 900,
                candidates: candidates
            ),
            100
        )
    }

    func testSingleInstancePolicyAllowsLaunchWithoutAnotherMatchingProcess() {
        let candidates = [
            RunningApplicationSnapshot(
                processIdentifier: 900,
                bundleIdentifier: "app.taxi",
                launchDate: Date(),
                isTerminated: false
            ),
        ]

        XCTAssertNil(
            SingleInstancePolicy.existingProcessIdentifier(
                bundleIdentifier: "app.taxi",
                currentProcessIdentifier: 900,
                candidates: candidates
            )
        )
    }

    func testSimultaneousLaunchesChooseOneDeterministicWinner() {
        let sameDate = Date()
        let candidates = [
            RunningApplicationSnapshot(
                processIdentifier: 100,
                bundleIdentifier: "app.taxi",
                launchDate: sameDate,
                isTerminated: false
            ),
            RunningApplicationSnapshot(
                processIdentifier: 200,
                bundleIdentifier: "app.taxi",
                launchDate: sameDate,
                isTerminated: false
            ),
        ]

        XCTAssertNil(
            SingleInstancePolicy.existingProcessIdentifier(
                bundleIdentifier: "app.taxi",
                currentProcessIdentifier: 100,
                candidates: candidates
            )
        )
        XCTAssertEqual(
            SingleInstancePolicy.existingProcessIdentifier(
                bundleIdentifier: "app.taxi",
                currentProcessIdentifier: 200,
                candidates: candidates
            ),
            100
        )
    }

    func testHealthResponseClassifiesAConflictingRuntimeVersion() throws {
        let data = try JSONSerialization.data(withJSONObject: [
            "status": "ok",
            "version": "2.12.1",
            "appOwned": true,
        ])

        XCTAssertEqual(
            ServerManager.classifyRuntimeHealthResponse(
                statusCode: 200,
                data: data,
                expectedVersion: "2.16.0"
            ),
            .versionMismatch(found: "2.12.1", expected: "2.16.0")
        )
    }

    func testExactWarmingHealthContractWaitsForReadinessInsteadOfClaimingThePortIsForeign() throws {
        let data = try JSONSerialization.data(withJSONObject: [
            "status": "warming",
            "readiness": "warming",
            "listener": "listening",
            "version": "2.16.0",
            "appOwned": true,
        ])
        XCTAssertEqual(
            ServerManager.classifyRuntimeHealthResponse(
                statusCode: 503,
                data: data,
                expectedVersion: "2.16.0"
            ),
            .matching(version: "2.16.0", appOwned: true)
        )

        for mutation in [
            ["status": "degraded", "readiness": "warming", "listener": "listening"],
            ["status": "warming", "readiness": "degraded", "listener": "listening"],
            ["status": "warming", "readiness": "warming", "listener": "closing"],
        ] {
            var malformed: [String: Any] = [
                "version": "2.16.0",
                "appOwned": true,
            ]
            malformed.merge(mutation) { _, replacement in replacement }
            let malformedData = try JSONSerialization.data(withJSONObject: malformed)
            XCTAssertEqual(
                ServerManager.classifyRuntimeHealthResponse(
                    statusCode: 503,
                    data: malformedData,
                    expectedVersion: "2.16.0"
                ),
                .occupiedUnrecognized
            )
        }
    }

    func testMatchingHealthStillRequiresAuthenticatedMCPReadiness() throws {
        let data = try JSONSerialization.data(withJSONObject: [
            "status": "ok",
            "version": "2.16.0",
            "appOwned": true,
        ])
        let health = ServerManager.classifyRuntimeHealthResponse(
            statusCode: 200,
            data: data,
            expectedVersion: "2.16.0"
        )

        XCTAssertEqual(
            ServerManager.completeRuntimeProbe(health: health, authenticatedReady: false),
            .authenticationFailed(version: "2.16.0")
        )
        XCTAssertEqual(
            ServerManager.completeRuntimeProbe(health: health, authenticatedReady: true),
            .ready(version: "2.16.0", appOwned: true)
        )
    }

    func testLightweightPollCannotReportReadyWithoutGenerationAuthenticatedRuntimeState() throws {
        let health = ServerManager.RuntimeHealthResponse.matching(
            version: "2.16.0",
            appOwned: true
        )
        let rejected = ServerManager.completeLightweightRuntimeProbe(
            health: health,
            verifiedEvidence: nil
        )
        XCTAssertEqual(rejected.probe, .authenticationFailed(version: "2.16.0"))
        XCTAssertNil(rejected.verifiedEvidence)

        let evidence = VerifiedOwnedRuntimeEvidence(
            identity: try XCTUnwrap(
                AppOwnedRuntimeIdentity(
                    processIdentifier: 4242,
                    ownerFingerprint: String(repeating: "a", count: 64)
                )
            ),
            processReceipt: RuntimeProcessGenerationReceipt(
                processIdentifier: 4242,
                userIdentifier: 501,
                startTimeSeconds: 1,
                startTimeMicroseconds: 2,
                executablePath: "/private/var/empty/taxi-node"
            )
        )
        let accepted = ServerManager.completeLightweightRuntimeProbe(
            health: health,
            verifiedEvidence: evidence
        )
        XCTAssertEqual(accepted.probe, .ready(version: "2.16.0", appOwned: true))
        XCTAssertEqual(accepted.verifiedEvidence, evidence)
    }

    func testOnlyFreshUnavailableProbeCanUseFutureStartConfigPolicy() {
        XCTAssertTrue(ServerManager.runtimeIsConfirmedUnavailable(.unavailable))
        XCTAssertFalse(
            ServerManager.runtimeIsConfirmedUnavailable(
                .ready(version: "2.16.0", appOwned: true)
            )
        )
        XCTAssertFalse(
            ServerManager.runtimeIsConfirmedUnavailable(
                .ready(version: "2.16.0", appOwned: false)
            )
        )
        XCTAssertFalse(ServerManager.runtimeIsConfirmedUnavailable(.portOccupied))
        XCTAssertFalse(
            ServerManager.runtimeIsConfirmedUnavailable(
                .versionMismatch(found: "2.15.0", expected: "2.16.0")
            )
        )
        XCTAssertFalse(
            ServerManager.runtimeIsConfirmedUnavailable(
                .authenticationFailed(version: "2.16.0")
            )
        )
    }

    func testDegradedReadinessRecoveryRequiresAnOwnedLiveProcess() {
        XCTAssertTrue(
            ServerManager.shouldRecoverOwnedRuntime(
                probe: .unavailable,
                managedChildAlive: true,
                adoptedGenerationAlive: false
            )
        )
        XCTAssertTrue(
            ServerManager.shouldRecoverOwnedRuntime(
                probe: .unavailable,
                managedChildAlive: false,
                adoptedGenerationAlive: true
            )
        )
        XCTAssertFalse(
            ServerManager.shouldRecoverOwnedRuntime(
                probe: .unavailable,
                managedChildAlive: false,
                adoptedGenerationAlive: false
            )
        )
        XCTAssertTrue(
            ServerManager.shouldRecoverOwnedRuntime(
                probe: .portOccupied,
                managedChildAlive: true,
                adoptedGenerationAlive: true
            )
        )
        XCTAssertTrue(
            ServerManager.shouldRecoverOwnedRuntime(
                probe: .authenticationFailed(version: "1.0.0"),
                managedChildAlive: true,
                adoptedGenerationAlive: false
            )
        )
        XCTAssertTrue(
            ServerManager.shouldRecoverOwnedRuntime(
                probe: .versionMismatch(found: "0.9.0", expected: "1.0.0"),
                managedChildAlive: false,
                adoptedGenerationAlive: true
            )
        )
        XCTAssertFalse(
            ServerManager.shouldRecoverOwnedRuntime(
                probe: .ready(version: "1.0.0", appOwned: false),
                managedChildAlive: true,
                adoptedGenerationAlive: true
            )
        )
        XCTAssertFalse(
            ServerManager.shouldRecoverOwnedRuntime(
                probe: .authenticationFailed(version: "1.0.0"),
                managedChildAlive: false,
                adoptedGenerationAlive: false
            )
        )
    }

    func testTerminationCallbackTokenRejectsControlledAndReplacedHandlers() {
        let active = UUID()
        XCTAssertTrue(
            ServerManager.shouldHandleTerminationCallback(
                handlerToken: active,
                currentToken: active,
                intentionalToken: nil
            )
        )
        XCTAssertFalse(
            ServerManager.shouldHandleTerminationCallback(
                handlerToken: active,
                currentToken: active,
                intentionalToken: active
            )
        )
        XCTAssertFalse(
            ServerManager.shouldHandleTerminationCallback(
                handlerToken: active,
                currentToken: UUID(),
                intentionalToken: nil
            )
        )
    }

    func testManualRuntimeNeverAdvancesToBearerReadiness() throws {
        let data = try JSONSerialization.data(withJSONObject: [
            "status": "ok",
            "version": "2.16.0",
            "appOwned": false,
        ])
        let health = ServerManager.classifyRuntimeHealthResponse(
            statusCode: 200,
            data: data,
            expectedVersion: "2.16.0"
        )

        XCTAssertEqual(
            ServerManager.completeRuntimeProbe(health: health, authenticatedReady: true),
            .authenticationFailed(version: "2.16.0")
        )
    }

    func testHealthWithoutOwnershipContractCannotAuthorizeBearerProbe() throws {
        let data = try JSONSerialization.data(withJSONObject: [
            "status": "ok",
            "version": "2.16.0",
        ])

        XCTAssertEqual(
            ServerManager.completeRuntimeProbe(
                health: ServerManager.classifyRuntimeHealthResponse(
                    statusCode: 200,
                    data: data,
                    expectedVersion: "2.16.0"
                ),
                authenticatedReady: true
            ),
            .authenticationFailed(version: "2.16.0")
        )
    }

    func testMalformedHttpResponseStillIdentifiesAnOccupiedPort() {
        XCTAssertEqual(
            ServerManager.classifyRuntimeHealthResponse(
                statusCode: 503,
                data: Data("not-json".utf8),
                expectedVersion: "2.16.0"
            ),
            .occupiedUnrecognized
        )
        XCTAssertEqual(
            ServerManager.completeRuntimeProbe(
                health: .occupiedUnrecognized,
                authenticatedReady: false
            ),
            .portOccupied
        )
    }

    func testNoHttpResponseMeansThePortIsAvailable() {
        XCTAssertEqual(
            ServerManager.classifyRuntimeHealthResponse(
                statusCode: nil,
                data: Data(),
                expectedVersion: "2.16.0"
            ),
            .unavailable
        )
    }

    func testRefusedConnectionAllowsLaunchButAmbiguousTransportFailuresBlockIt() {
        XCTAssertEqual(
            ServerManager.classifyRuntimeTransportFailure(code: .cannotConnectToHost),
            .unavailable
        )
        XCTAssertEqual(
            ServerManager.classifyRuntimeTransportFailure(code: .timedOut),
            .occupiedUnrecognized
        )
        XCTAssertEqual(
            ServerManager.classifyRuntimeTransportFailure(code: .networkConnectionLost),
            .occupiedUnrecognized
        )
        XCTAssertEqual(
            ServerManager.classifyRuntimeTransportFailure(code: nil),
            .occupiedUnrecognized
        )
    }

    func testUntrustedHealthVersionCannotInjectDiagnosticText() throws {
        let data = try JSONSerialization.data(withJSONObject: [
            "status": "ok",
            "version": "2.12.1\nBearer private-value",
            "appOwned": true,
        ])

        XCTAssertEqual(
            ServerManager.classifyRuntimeHealthResponse(
                statusCode: 200,
                data: data,
                expectedVersion: "2.16.0"
            ),
            .occupiedUnrecognized
        )
    }

    func testVersionConflictIsShownAndLoggedWithoutSecretsOrRepeatedSpam() async {
        await MainActor.run {
            let manager = ServerManager()
            let logs = LogManager()
            manager.logManager = logs

            let conflict = ServerManager.RuntimeProbeResult.versionMismatch(
                found: "2.12.1",
                expected: "2.16.0"
            )
            manager.applyRuntimeProbe(conflict, preserveExistingErrorWhenUnavailable: false)
            manager.applyRuntimeProbe(conflict, preserveExistingErrorWhenUnavailable: false)

            guard case .error(let message) = manager.status else {
                return XCTFail("Expected a visible port-owner diagnostic")
            }
            XCTAssertTrue(message.contains("3848"))
            XCTAssertTrue(message.contains("2.12.1"))
            XCTAssertTrue(message.contains("2.16.0"))
            XCTAssertFalse(message.localizedCaseInsensitiveContains("token"))
            XCTAssertEqual(logs.entries.count, 1)
            XCTAssertEqual(logs.entries.first?.message, message)
            XCTAssertEqual(logs.entries.first?.isError, true)

            manager.applyRuntimeProbe(.unavailable, preserveExistingErrorWhenUnavailable: true)
            XCTAssertEqual(manager.status, .stopped)
        }
    }

    func testUnavailableOwnedGenerationIsDiagnosedAndRetainsStopAuthority() async throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sleep")
        process.arguments = ["30"]
        try process.run()
        defer {
            if process.isRunning { process.terminate() }
        }
        let identity = try XCTUnwrap(
            AppOwnedRuntimeIdentity(
                processIdentifier: Int(process.processIdentifier),
                ownerFingerprint: String(repeating: "c", count: 64)
            )
        )
        let receipt = try XCTUnwrap(
            ServerManager.processGenerationReceipt(for: process.processIdentifier)
        )

        await MainActor.run {
            let manager = ServerManager()
            manager.applyRuntimeProbe(
                .ready(version: "2.16.0", appOwned: true),
                preserveExistingErrorWhenUnavailable: false,
                verifiedAdoptedIdentity: identity,
                verifiedProcessReceipt: receipt
            )
            manager.applyRuntimeProbe(
                .unavailable,
                preserveExistingErrorWhenUnavailable: false
            )

            guard case .error(let message) = manager.status else {
                return XCTFail("Expected a live-process-without-listener diagnostic")
            }
            XCTAssertTrue(message.contains("\(process.processIdentifier)"))
            XCTAssertTrue(message.contains("3848"))
            XCTAssertTrue(manager.canStopRuntime)
            manager.prepareForApplicationTermination()
        }

        let generationExited = await waitForGenerationExit(receipt)
        XCTAssertTrue(generationExited)
    }

    func testVerifiedExternalRuntimeTerminatesOnlyItsExactGenerationWithAppLifecycle() async throws {
        let target = Process()
        target.executableURL = URL(fileURLWithPath: "/bin/sleep")
        target.arguments = ["30"]
        let unrelated = Process()
        unrelated.executableURL = URL(fileURLWithPath: "/bin/sleep")
        unrelated.arguments = ["30"]
        try target.run()
        try unrelated.run()
        defer {
            if target.isRunning { target.terminate() }
            if unrelated.isRunning { unrelated.terminate() }
        }
        let identity = try XCTUnwrap(
            AppOwnedRuntimeIdentity(
                processIdentifier: Int(target.processIdentifier),
                ownerFingerprint: String(repeating: "a", count: 64)
            )
        )
        let receipt = try XCTUnwrap(
            ServerManager.processGenerationReceipt(forLaunchedProcess: target)
        )
        await MainActor.run {
            let manager = ServerManager()
            manager.applyRuntimeProbe(
                .ready(version: "2.16.0", appOwned: true),
                preserveExistingErrorWhenUnavailable: false,
                verifiedAdoptedIdentity: identity,
                verifiedProcessReceipt: receipt
            )
            XCTAssertEqual(manager.status, .running)
            XCTAssertTrue(manager.canStopRuntime)

            manager.prepareForApplicationTermination()
        }

        let generationExited = await waitForGenerationExit(receipt)
        XCTAssertTrue(generationExited)
        XCTAssertTrue(unrelated.isRunning)
    }

    func testPublicOwnershipBitAloneNeverGrantsTerminationAuthority() async {
        let recorder = RuntimeTerminationRecorder()
        await MainActor.run {
            let manager = ServerManager(adoptedRuntimeTerminator: { identity in
                recorder.record(identity.processIdentifier)
            })
            manager.applyRuntimeProbe(
                .ready(version: "2.16.0", appOwned: true),
                preserveExistingErrorWhenUnavailable: false
            )
            guard case .error(let message) = manager.status else {
                return XCTFail("Expected ownership evidence failure")
            }
            XCTAssertTrue(message.contains("3848"))
            XCTAssertFalse(manager.canStopRuntime)
            manager.prepareForApplicationTermination()
        }

        XCTAssertTrue(recorder.processIdentifiers.isEmpty)
    }

    func testStaleReadyCannotRestoreRunningAfterGenerationEvidenceExpires() async throws {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sleep")
        process.arguments = ["30"]
        try process.run()
        defer {
            if process.isRunning { process.terminate() }
        }
        let identity = try XCTUnwrap(
            AppOwnedRuntimeIdentity(
                processIdentifier: Int(process.processIdentifier),
                ownerFingerprint: String(repeating: "b", count: 64)
            )
        )
        let receipt = try XCTUnwrap(
            ServerManager.processGenerationReceipt(forLaunchedProcess: process)
        )
        let manager = await MainActor.run { () -> ServerManager in
            let manager = ServerManager()
            manager.applyRuntimeProbe(
                .ready(version: "2.16.0", appOwned: true),
                preserveExistingErrorWhenUnavailable: false,
                verifiedAdoptedIdentity: identity,
                verifiedProcessReceipt: receipt
            )
            XCTAssertEqual(manager.status, .running)
            return manager
        }

        XCTAssertTrue(ServerManager.signalProcess(matching: receipt, signal: SIGTERM))
        let generationExited = await waitForGenerationExit(receipt)
        XCTAssertTrue(generationExited)
        XCTAssertFalse(ServerManager.processMatchesGenerationReceipt(receipt))

        await MainActor.run {
            manager.applyRuntimeProbe(
                .ready(version: "2.16.0", appOwned: true),
                preserveExistingErrorWhenUnavailable: false,
                verifiedAdoptedIdentity: identity,
                verifiedProcessReceipt: receipt
            )
            guard case .error = manager.status else {
                return XCTFail("A stale /health result must not publish running")
            }
            XCTAssertFalse(manager.canStopRuntime)
        }
    }

    func testAuthenticatedManualRuntimeIsDisplayedButNotTerminatedWithApp() async {
        let recorder = RuntimeTerminationRecorder()
        await MainActor.run {
            let manager = ServerManager(adoptedRuntimeTerminator: { identity in
                recorder.record(identity.processIdentifier)
            })
            manager.applyRuntimeProbe(
                .ready(version: "2.16.0", appOwned: false),
                preserveExistingErrorWhenUnavailable: false
            )
            XCTAssertEqual(manager.status, .running)
            XCTAssertFalse(manager.canStopRuntime)

            manager.prepareForApplicationTermination()
        }

        XCTAssertTrue(recorder.processIdentifiers.isEmpty)
    }

    func testAuthenticatedIdentityFailsClosedForEveryMismatch() throws {
        let fingerprint = String(repeating: "b", count: 64)
        let state = AppRuntimeState(
            status: "ok",
            version: "2.16.0",
            appOwned: true,
            pid: 4242,
            ownerFingerprint: fingerprint,
            tokenFingerprint: String(repeating: "a", count: 64),
            disabledModules: [],
            scopeFingerprint: String(repeating: "c", count: 64),
            enabledModules: ["calendar"],
            unavailableModules: [],
            effectiveHitlLevel: .sensitiveOnly,
            effectiveHitlWhitelist: []
        )
        XCTAssertEqual(
            ServerManager.authenticatedOwnedRuntimeIdentity(
                state: state,
                expectedVersion: "2.16.0",
                expectedOwnerFingerprint: fingerprint
            )?.processIdentifier,
            4242
        )
        XCTAssertNil(
            ServerManager.authenticatedOwnedRuntimeIdentity(
                state: state,
                expectedVersion: "2.15.0",
                expectedOwnerFingerprint: fingerprint
            )
        )
        XCTAssertNil(
            ServerManager.authenticatedOwnedRuntimeIdentity(
                state: state,
                expectedVersion: "2.16.0",
                expectedOwnerFingerprint: String(repeating: "d", count: 64)
            )
        )
        XCTAssertNil(
            ServerManager.authenticatedOwnedRuntimeIdentity(
                state: AppRuntimeState(
                    status: "ok",
                    version: "2.16.0",
                    appOwned: false,
                    pid: 4242,
                    ownerFingerprint: fingerprint,
                    tokenFingerprint: String(repeating: "a", count: 64),
                    disabledModules: [],
                    scopeFingerprint: String(repeating: "c", count: 64),
                    enabledModules: ["calendar"],
                    unavailableModules: [],
                    effectiveHitlLevel: .sensitiveOnly,
                    effectiveHitlWhitelist: []
                ),
                expectedVersion: "2.16.0",
                expectedOwnerFingerprint: fingerprint
            )
        )
        XCTAssertNil(
            ServerManager.authenticatedOwnedRuntimeIdentity(
                state: AppRuntimeState(
                    status: "ok",
                    version: "2.16.0",
                    appOwned: true,
                    pid: 1,
                    ownerFingerprint: fingerprint,
                    tokenFingerprint: String(repeating: "a", count: 64),
                    disabledModules: [],
                    scopeFingerprint: String(repeating: "c", count: 64),
                    enabledModules: ["calendar"],
                    unavailableModules: [],
                    effectiveHitlLevel: .sensitiveOnly,
                    effectiveHitlWhitelist: []
                ),
                expectedVersion: "2.16.0",
                expectedOwnerFingerprint: fingerprint
            )
        )
    }

    func testGenerationVerifiedSignalLeavesUnrelatedMatchingProcessRunning() async throws {
        let target = Process()
        target.executableURL = URL(fileURLWithPath: "/bin/sleep")
        target.arguments = ["30"]
        let unrelated = Process()
        unrelated.executableURL = URL(fileURLWithPath: "/bin/sleep")
        unrelated.arguments = ["30"]
        try target.run()
        try unrelated.run()
        defer {
            if target.isRunning { target.terminate() }
            if unrelated.isRunning { unrelated.terminate() }
        }
        let receipt = try XCTUnwrap(
            ServerManager.processGenerationReceipt(forLaunchedProcess: target)
        )

        XCTAssertTrue(ServerManager.signalProcess(matching: receipt, signal: SIGTERM))
        let generationExited = await waitForGenerationExit(receipt)
        XCTAssertTrue(generationExited)
        XCTAssertTrue(unrelated.isRunning)
    }

    func testUnavailableRuntimeClearsExpiredAdoptedTerminationResponsibility() async throws {
        let recorder = RuntimeTerminationRecorder()
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/sleep")
        process.arguments = ["30"]
        try process.run()
        defer {
            if process.isRunning { process.terminate() }
        }
        let identity = try XCTUnwrap(
            AppOwnedRuntimeIdentity(
                processIdentifier: Int(process.processIdentifier),
                ownerFingerprint: String(repeating: "f", count: 64)
            )
        )
        let receipt = try XCTUnwrap(
            ServerManager.processGenerationReceipt(forLaunchedProcess: process)
        )
        let manager = await MainActor.run { () -> ServerManager in
            let manager = ServerManager(adoptedRuntimeTerminator: { terminatedIdentity in
                recorder.record(terminatedIdentity.processIdentifier)
            })
            manager.applyRuntimeProbe(
                .ready(version: "2.16.0", appOwned: true),
                preserveExistingErrorWhenUnavailable: false,
                verifiedAdoptedIdentity: identity,
                verifiedProcessReceipt: receipt
            )
            XCTAssertTrue(manager.canStopRuntime)
            return manager
        }

        XCTAssertTrue(ServerManager.signalProcess(matching: receipt, signal: SIGTERM))
        let generationExited = await waitForGenerationExit(receipt)
        XCTAssertTrue(generationExited)

        await MainActor.run {
            manager.applyRuntimeProbe(
                .unavailable,
                preserveExistingErrorWhenUnavailable: false
            )
            XCTAssertFalse(manager.canStopRuntime)
            manager.prepareForApplicationTermination()
        }

        XCTAssertTrue(recorder.processIdentifiers.isEmpty)
    }
}

private final class RuntimeTerminationRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var values: [Int32] = []

    var processIdentifiers: [Int32] {
        lock.withLock { values }
    }

    func record(_ processIdentifier: Int32) {
        lock.withLock { values.append(processIdentifier) }
    }
}
