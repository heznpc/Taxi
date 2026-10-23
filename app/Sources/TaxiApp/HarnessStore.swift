import Foundation

@MainActor
@Observable
final class HarnessStore {
    var snapshot: HarnessSnapshot?
    var settings: HarnessSettings?
    var selectedTaskID: String?
    var error: String?
    var busy = false
    // A retry after a lost HTTP response must reuse the same request identity.
    private struct Failure: Decodable { let error: String }
    private var pendingRun: (taskID: String, body: Data)?

    private func request<T: Decodable & Sendable>(_ path: String = "", body: Data? = nil) async throws -> T {
        let listener = try await AppRuntimeClient.verifyListenerOwnership()
        guard var url = URLComponents(string: TaxiConstants.appOwnedIdentityChallengeURL) else {
            throw URLError(.badURL)
        }
        url.path = "/app/harness" + path
        url.query = nil
        guard let endpoint = url.url else { throw URLError(.badURL) }
        var request = URLRequest(url: endpoint)
        request.httpMethod = body == nil ? "GET" : "POST"
        request.httpBody = body
        request.timeoutInterval = 45
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let nonce = AppRuntimeClient.authorizeMCPRequest(&request, listener: listener)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse,
              AppRuntimeToken.runtimeResponseProofIsValid(
                http.value(forHTTPHeaderField: "X-Taxi-Runtime-Proof"), nonce: nonce,
                processIdentifier: listener.challenge.pid, version: listener.challenge.version,
                method: request.httpMethod ?? "GET", path: url.path,
                ownerSecret: listener.responseProofKey
              ) else { throw URLError(.secureConnectionFailed) }
        guard http.statusCode == 200 else {
            let code = (try? JSONDecoder().decode(Failure.self, from: data).error) ?? "harness_unavailable"
            throw NSError(domain: "TaxiHarness", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: code])
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
    func refresh(reloadSettings: Bool = false) async {
        do {
            let value: HarnessSnapshot = try await request()
            snapshot = value
            if settings == nil || reloadSettings { settings = value.settings }
            error = nil
        } catch { self.error = error.localizedDescription }
    }
    func saveSettings() async {
        guard let settings else { return }
        busy = true
        defer { busy = false }
        do { snapshot = try await request("/settings", body: JSONEncoder().encode(settings)); error = nil }
        catch { self.error = error.localizedDescription }
    }
    func collectUsage() async {
        busy = true
        defer { busy = false }
        do { snapshot = try await request("/usage", body: Data("{}".utf8)); error = nil }
        catch { self.error = error.localizedDescription }
    }
    @discardableResult
    func create(original: String, decisions: String, questions: String, criteria: String, evidence: String, phase: String) async -> Bool {
        func lines(_ text: String) -> [String] { text.split(separator: "\n").map(String.init).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty } }
        busy = true
        defer { busy = false }
        do {
            struct Created: Decodable, Sendable { let task: HarnessTask }
            let body = try JSONSerialization.data(withJSONObject: ["originalRequest": original, "phase": phase,
                "decisions": lines(decisions), "openQuestions": lines(questions),
                "completionCriteria": lines(criteria), "evidenceRefs": lines(evidence)])
            let created: Created = try await request("/tasks", body: body)
            selectedTaskID = created.task.id
            await refresh()
            return true
        } catch {
            self.error = error.localizedDescription
            return false
        }
    }
    func handoff(_ task: HarnessTask, phase: String) async {
        busy = true
        defer { busy = false }
        do {
            struct Created: Decodable, Sendable { let task: HarnessTask }
            let created: Created = try await request("/tasks/\(task.id)/handoff", body: try JSONSerialization.data(withJSONObject: ["phase": phase]))
            selectedTaskID = created.task.id
            await refresh()
        } catch { self.error = error.localizedDescription }
    }
    func importCatalog(_ data: Data) async {
        busy = true
        defer { busy = false }
        do { snapshot = try await request("/catalog", body: data); error = nil }
        catch { self.error = error.localizedDescription }
    }
    func link(taskID: String, sessionKey: String, parentSessionKey: String?, phase: String, evidence: String, registeredBy: String) async {
        busy = true
        defer { busy = false }
        do {
            var value: [String: Any] = ["sessionKey": sessionKey, "phase": phase, "evidence": evidence, "registeredBy": registeredBy]
            value["parentSessionKey"] = parentSessionKey ?? NSNull()
            struct Linked: Decodable, Sendable { let link: HarnessSessionLink }
            let _: Linked = try await request("/tasks/\(taskID)/links", body: JSONSerialization.data(withJSONObject: value))
            await refresh()
        } catch { self.error = error.localizedDescription }
    }
    func run(_ task: HarnessTask, prompt: String, changeModel: Bool, allowRouting: Bool, usePhasePreference: Bool) async {
        guard let settings else { return }
        busy = true
        defer { busy = false }
        do {
            if pendingRun == nil {
                let body = try JSONSerialization.data(withJSONObject: ["requestId": UUID().uuidString.lowercased(),
                    "action": changeModel ? "model-only" : "keep", "prompt": prompt,
                    "model": settings.model, "effort": settings.effort,
                    "allowTaskRouting": allowRouting, "usePhasePreference": usePhasePreference, "confirmReadOnlyRun": true])
                pendingRun = (task.id, body)
            }
            guard let pendingRun, pendingRun.taskID == task.id else {
                throw NSError(domain: "TaxiHarness", code: 0, userInfo: [NSLocalizedDescriptionKey: L("harness.retryOriginal")])
            }
            struct Started: Decodable, Sendable { let run: HarnessRun }
            let _: Started = try await request("/tasks/\(task.id)/run", body: pendingRun.body)
            self.pendingRun = nil
            await refresh()
        } catch {
            let failure = error as NSError
            if failure.domain == "TaxiHarness" && [400, 403, 404, 409].contains(failure.code) { pendingRun = nil }
            self.error = error.localizedDescription
        }
    }
}
