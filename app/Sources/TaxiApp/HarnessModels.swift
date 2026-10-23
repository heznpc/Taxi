import Foundation

struct HarnessModelPreference: Codable, Sendable {
    var model: String
    var effort: String
}
struct HarnessSettings: Codable, Sendable {
    var usageEnabled: Bool
    var taskSavingsEnabled: Bool
    var compactionEnabled: Bool
    var model: String
    var effort: String
    var compactionFrom: String
    var compactionTo: String
    var phasePreferences: [String: HarnessModelPreference] = [:]
}
struct HarnessTask: Codable, Identifiable, Sendable {
    let id: String
    let parentId: String?
    let originalRequest: String
    let decisions: [String]
    let openQuestions: [String]
    let completionCriteria: [String]
    let evidenceRefs: [String]
    let threadId: String?
    let handoff: String?
    let phase: String
    let modelPreference: HarnessModelPreference?
    let status: String?
    let executionOwner: String?
}
struct HarnessEvent: Codable, Sendable {
    let from: String
    let to: String
    let phase: String
    let requestedEffort: String?
    let reasoningEffort: String?
    let responseModel: String?
    let savingsReason: String?
    let errorCode: String?
    let turnId: String?
}
struct HarnessRun: Codable, Identifiable, Sendable {
    let id: String
    let taskId: String
    let action: String
    let event: HarnessEvent
    let acknowledgedModel: String?
    let output: String
    let dispatched: Bool
    let completionVerified: Bool
    let settings: HarnessSettings
    let modelSelection: HarnessModelSelection?
}
struct HarnessModelSelection: Codable, Sendable {
    let status: String
    let phase: String
    let source: String?
    let reason: String
    let selection: Choice?
    struct Choice: Codable, Sendable { let provider: String; let model: String; let effort: String? }
}
struct HarnessUsage: Codable, Identifiable, Sendable {
    let bucket: String
    let label: String
    let usedPercent: Double?
    let resetsAtMs: Double?
    let observedAtMs: Double
    var id: String { bucket }
}
struct HarnessSnapshot: Codable, Sendable {
    struct Core: Codable, Sendable { let name: String; let version: String; let installed: Bool }
    struct Provider: Codable, Sendable { let installed: Bool; let home: String; let authentication: String; let permissions: String }
    struct Compaction: Codable, Sendable { let configured: Bool; let effective: Bool; let state: String }
    let core: Core
    let provider: Provider
    let settings: HarnessSettings
    let compaction: Compaction
    let usageStatus: String
    let usage: [HarnessUsage]
    let tasks: [HarnessTask]
    let runs: [HarnessRun]
    let busy: Bool
    var externalSessions: [HarnessExternalSession] = []
    var catalogImports: [HarnessCatalogImport] = []
    var sessionLinks: [HarnessSessionLink] = []
}

struct HarnessExternalSession: Codable, Identifiable, Sendable {
    let key: String
    let provider: String
    let providerSessionId: String?
    let profileKey: String?
    let workspacePath: String?
    let lastActivityAt: String?
    let provenance: String
    let title: String?
    let importedAt: String
    let catalogGeneratedAt: String
    let presentInLatestImport: Bool
    let source: String
    let status: String
    let authority: String
    let freshness: String
    var id: String { key }
}
struct HarnessCatalogImport: Codable, Sendable {
    struct Scan: Codable, Sendable { let complete: Bool; let truncated: Bool; let errors: [String] }
    let generatedAt: String
    let importedAt: String
    let source: String
    let scan: Scan
    let sessionCount: Int
    let freshness: String
}
struct HarnessSessionLink: Codable, Identifiable, Sendable {
    let id: String
    let taskId: String
    let sessionKey: String
    let parentSessionKey: String?
    let phase: String
    let evidence: String
    let registeredBy: String
    let createdAt: String
}
