// swift-tools-version: 6.1

import PackageDescription

let package = Package(
    name: "TaxiBridge",
    platforms: [.macOS(.v14), .iOS(.v17)],
    products: [
        .library(name: "TaxiKit", targets: ["TaxiKit"]),
    ],
    targets: [
        .target(
            name: "TaxiKit",
            path: "Sources/TaxiKit"
        ),
        .executableTarget(
            name: "TaxiBridge",
            dependencies: ["TaxiKit"],
            path: "Sources/TaxiBridge"
        ),
        .testTarget(
            name: "TaxiKitTests",
            dependencies: ["TaxiKit"],
            path: "Tests/TaxiKitTests"
        ),
    ]
)
