import AppKit
import CryptoKit
import SwiftUI
import XCTest
@testable import TaxiApp

@MainActor
final class HarnessViewTests: XCTestCase {
    func testNativeHarnessProofIsBoundToExactActionPath() {
        let owner = String(repeating: "q", count: 43)
        let nonce = UUID().uuidString.lowercased()
        let path = "/app/harness/tasks/11111111-1111-4111-8111-111111111111/run"
        let payload = Data("taxi-app-response-v1\n\(nonce)\n1234\n1.0.0\nPOST\n\(path)".utf8)
        let proof = HMAC<SHA256>.authenticationCode(for: payload, using: SymmetricKey(data: Data(owner.utf8)))
            .map { String(format: "%02x", $0) }.joined()
        XCTAssertTrue(AppRuntimeToken.runtimeResponseProofIsValid(proof, nonce: nonce, processIdentifier: 1234,
            version: "1.0.0", method: "POST", path: path, ownerSecret: owner))
        XCTAssertFalse(AppRuntimeToken.runtimeResponseProofIsValid(proof, nonce: nonce, processIdentifier: 1234,
            version: "1.0.0", method: "POST", path: "/app/harness/settings", ownerSecret: owner))
        XCTAssertFalse(AppRuntimeToken.runtimeResponseProofIsValid(proof, nonce: nonce, processIdentifier: 1234,
            version: "1.0.0", method: "POST", path: path + "/untrusted", ownerSecret: owner))
    }

    func testNewDashboardProofPathsRemainBoundAndRejectUnknownRoutes() {
        let owner = String(repeating: "q", count: 43)
        let nonce = UUID().uuidString.lowercased()
        for path in ["/app/harness/catalog", "/app/harness/tasks/11111111-1111-4111-8111-111111111111/links"] {
            let payload = Data("taxi-app-response-v1\n\(nonce)\n1234\n1.0.0\nPOST\n\(path)".utf8)
            let proof = HMAC<SHA256>.authenticationCode(for: payload, using: SymmetricKey(data: Data(owner.utf8)))
                .map { String(format: "%02x", $0) }.joined()
            XCTAssertTrue(AppRuntimeToken.runtimeResponseProofIsValid(proof, nonce: nonce, processIdentifier: 1234,
                version: "1.0.0", method: "POST", path: path, ownerSecret: owner))
            XCTAssertFalse(AppRuntimeToken.runtimeResponseProofIsValid(proof, nonce: nonce, processIdentifier: 1234,
                version: "1.0.0", method: "POST", path: path + "/execute", ownerSecret: owner))
        }
    }

    func testNativeHarnessViewRendersSavedStateAndUnverifiedEvidence() throws {
        let store = HarnessStore()
        let settings = HarnessSettings(usageEnabled: false, taskSavingsEnabled: false, compactionEnabled: true,
            model: "gpt-6-sol", effort: "medium", compactionFrom: "gpt-6-astra", compactionTo: "gpt-5.6-sol")
        store.settings = settings
        store.snapshot = HarnessSnapshot(
            core: .init(name: "@heznpc/quota-core", version: "0.2.0", installed: true),
            provider: .init(installed: true, home: "/tmp/taxi-render-fixture/codex", authentication: "login-required", permissions: "read-only"),
            settings: settings, compaction: .init(configured: true, effective: false, state: "relay-not-connected"),
            usageStatus: "disabled", usage: [], tasks: [], runs: [], busy: false)
        if let snapshotPath = ProcessInfo.processInfo.environment["TAXI_DASHBOARD_SNAPSHOT"] {
            store.snapshot = try JSONDecoder().decode(HarnessSnapshot.self, from: Data(contentsOf: URL(fileURLWithPath: snapshotPath)))
            store.selectedTaskID = store.snapshot?.tasks.first(where: { $0.parentId == nil })?.id
            store.settings = store.snapshot?.settings
            XCTAssertGreaterThan(store.snapshot?.externalSessions.count ?? 0, 0)
        }
        let view = NSHostingView(rootView: HarnessView(store: store, refreshOnAppear: false).environment(\.colorScheme, .light).background(Color.white))
        view.frame = NSRect(x: 0, y: 0, width: 900, height: 1000)
        let window = NSWindow(contentRect: view.frame, styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .aqua)
        window.contentView = view
        window.orderFront(nil)
        defer { window.orderOut(nil); window.close() }
        view.layoutSubtreeIfNeeded()
        window.displayIfNeeded()
        let bitmap = try XCTUnwrap(view.bitmapImageRepForCachingDisplay(in: view.bounds))
        view.cacheDisplay(in: view.bounds, to: bitmap)
        XCTAssertGreaterThan(bitmap.pixelsWide, 500)
        XCTAssertGreaterThan(bitmap.pixelsHigh, 500)
        let image = try XCTUnwrap(bitmap.representation(using: .png, properties: [:]))
        XCTAssertGreaterThan(image.count, 5000)
        if let directory = ProcessInfo.processInfo.environment["TAXI_RENDER_OUTPUT"] {
            try image.write(to: URL(fileURLWithPath: directory).appendingPathComponent("harness-view.png"))
        }
    }
}
