import AppKit

let done = CommandLine.arguments[1]
let workspace = NSWorkspace.shared
let initial = workspace.frontmostApplication?.processIdentifier ?? -1
let initialBundle = workspace.frontmostApplication?.bundleIdentifier ?? "unknown"
var activated: [[String: Any]] = []
// Only timing counters: no key values, text, cursor locations, or screenshots.
var previousKeyAge = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .keyDown)
var observedKeyEvents = 0
let token = workspace.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { note in
    if let app = note.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication {
        activated.append(["bundleIdentifier": app.bundleIdentifier ?? "unknown", "pid": app.processIdentifier])
    }
}
FileHandle.standardOutput.write(Data("READY\n".utf8))
let limit = Date().addingTimeInterval(900)
while !FileManager.default.fileExists(atPath: done) && Date() < limit {
    RunLoop.current.run(until: Date().addingTimeInterval(0.02))
    let keyAge = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: .keyDown)
    if keyAge < previousKeyAge { observedKeyEvents += 1 }
    previousKeyAge = keyAge
}
let result: [String: Any] = [
    "activationEvents": activated,
    "sameFrontmostPID": initial == (workspace.frontmostApplication?.processIdentifier ?? -1),
    "initialForegroundBundle": initialBundle,
    "observedKeyActivitySamples": observedKeyEvents,
    "completed": FileManager.default.fileExists(atPath: done)
]
FileHandle.standardOutput.write(try! JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]))
workspace.notificationCenter.removeObserver(token)
