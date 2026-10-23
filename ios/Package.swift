// swift-tools-version: 6.1

import PackageDescription

let package = Package(
    name: "TaxiIOS",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "TaxiServer", targets: ["TaxiServer"]),
    ],
    dependencies: [
        .package(path: "../swift"),
        .package(url: "https://github.com/hummingbird-project/hummingbird.git", from: "2.0.0"),
    ],
    targets: [
        .target(
            name: "TaxiServer",
            dependencies: [
                .product(name: "TaxiKit", package: "swift"),
                .product(name: "Hummingbird", package: "hummingbird"),
            ],
            path: "Sources/TaxiServer"
        ),
        .executableTarget(
            name: "TaxiIOS",
            dependencies: [
                .product(name: "TaxiKit", package: "swift"),
                "TaxiServer",
            ],
            path: "Sources/TaxiIOS",
            // Ship PrivacyInfo.xcprivacy inside the bundle so App Store
            // Connect's privacy-manifest scan picks it up at upload.
            // Apple requires this file for every iOS 17+ submission
            // under the 2024 manifest mandate.
            resources: [
                .copy("Resources/PrivacyInfo.xcprivacy"),
            ]
        ),
        .testTarget(
            name: "TaxiServerTests",
            dependencies: ["TaxiServer"],
            path: "Tests/TaxiServerTests"
        ),
    ]
)
