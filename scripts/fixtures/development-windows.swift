import AppKit

// Dedicated fixture only: two same-process windows make accidental frontmost
// capture visible. Stdin commands change or close the selected window.
let app = NSApplication.shared
app.setActivationPolicy(.regular)
var windows: [NSWindow] = []
for (index, name) in ["Taxi Fixture Selected", "Taxi Fixture Other"].enumerated() {
    let window = NSWindow(contentRect: NSRect(x: 100 + index * 340, y: 160, width: 320, height: 240),
                          styleMask: [.titled, .closable], backing: .buffered, defer: false)
    window.title = name
    window.isReleasedWhenClosed = false
    window.contentView!.wantsLayer = true
    window.contentView!.layer!.backgroundColor = (index == 0 ? NSColor.systemGreen : NSColor.systemRed).cgColor
    let label = NSTextField(labelWithString: index == 0 ? "SELECTED • READY" : "OTHER • WRONG TARGET")
    label.font = .boldSystemFont(ofSize: 20)
    label.textColor = .white
    label.frame = NSRect(x: 16, y: 110, width: 300, height: 32)
    window.contentView!.addSubview(label)
    window.makeKeyAndOrderFront(nil)
    windows.append(window)
}
app.activate(ignoringOtherApps: true)
DispatchQueue.global().async {
    while let command = readLine() {
        DispatchQueue.main.async {
            if command == "rename" { windows[0].title = "Taxi Fixture Renamed" }
            if command == "close" { windows[0].close() }
            if command == "quit" { app.terminate(nil) }
        }
    }
    DispatchQueue.main.async { app.terminate(nil) }
}
app.run()
