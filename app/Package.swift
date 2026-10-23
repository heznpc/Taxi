// swift-tools-version: 6.1

import PackageDescription

let package = Package(
    name: "TaxiApp",
    defaultLocalization: "en",
    platforms: [.macOS(.v14)],
    dependencies: [
        // RFC 0007 A.2a: App needs TaxiKit so it can install
        // MCPIntentRouter's host handler at launch.
        .package(path: "../swift"),
        // Shared display-only snapshot contract the app WRITES for the widget.
        .package(path: "widget"),
    ],
    targets: [
        .executableTarget(
            name: "TaxiApp",
            dependencies: [
                .product(name: "TaxiKit", package: "swift"),
                .product(name: "WidgetSnapshotKit", package: "widget"),
            ],
            path: "Sources/TaxiApp",
            exclude: [
                // bundle-app.sh merges this distribution plist into the .app.
                // SwiftPM must not try to compile or copy it as a resource.
                "Resources/Info.plist",
            ],
            resources: [
                .copy("Resources/AppIcon.png"),
                .copy("Resources/AppIcon@2x.png"),
                .copy("Resources/MenuBarIcon.png"),
                .process("Resources/de.lproj"),
                .process("Resources/en.lproj"),
                .process("Resources/es.lproj"),
                .process("Resources/fr.lproj"),
                .process("Resources/ja.lproj"),
                .process("Resources/ko.lproj"),
                .process("Resources/pt-BR.lproj"),
                .process("Resources/zh-Hans.lproj"),
                .process("Resources/zh-Hant.lproj"),
            ]
        ),
        .testTarget(
            name: "TaxiAppTests",
            dependencies: ["TaxiApp"],
            path: "Tests/TaxiAppTests"
        ),
    ]
)
