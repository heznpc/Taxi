import XCTest
@testable import TaxiApp

final class NodeEnvironmentTests: XCTestCase {
    func testBuildEnvOnlyInheritsPathHomeAndLocale() {
        let inherited = [
            "PATH": "/custom/bin:/usr/bin:/bin",
            "HOME": "/Users/example",
            "LANG": "ko_KR.UTF-8",
            "LC_ALL": "en_US.UTF-8",
            "LC_CTYPE": "UTF-8",
            "LC_TIME": "ko_KR.UTF-8",
            "NODE_OPTIONS": "--require=/tmp/steal-token.cjs",
            "NODE_PATH": "/tmp/attacker-modules",
            "DYLD_INSERT_LIBRARIES": "/tmp/steal-token.dylib",
            "LD_LIBRARY_PATH": "/tmp/attacker-libraries",
            "HTTP_PROXY": "http://127.0.0.1:8080",
            "https_proxy": "http://127.0.0.1:8081",
            "NO_PROXY": "*",
            "TAXI_HTTP_TOKEN": "attacker-token",
            "TAXI_ALLOW_NETWORK": "1",
            "TAXI_CONFIG_PATH": "/tmp/attacker-config.json",
            "CONTROL_PLANE_API_KEY": "secret",
        ]

        let environment = NodeEnvironment.buildEnv(from: inherited)

        XCTAssertEqual(environment["HOME"], "/Users/example")
        XCTAssertEqual(environment["LANG"], "ko_KR.UTF-8")
        XCTAssertEqual(environment["LC_ALL"], "en_US.UTF-8")
        XCTAssertEqual(environment["LC_CTYPE"], "UTF-8")
        XCTAssertEqual(environment["LC_TIME"], "ko_KR.UTF-8")
        XCTAssertEqual(
            environment["PATH"],
            (NodeEnvironment.searchPaths + ["/custom/bin:/usr/bin:/bin"])
                .joined(separator: ":")
        )
        XCTAssertEqual(
            Set(environment.keys),
            ["HOME", "LANG", "LC_ALL", "LC_CTYPE", "LC_TIME", "PATH"]
        )
    }

    func testBuildEnvUsesSafeDefaultsForMissingHomeAndPath() {
        let environment = NodeEnvironment.buildEnv(from: [:])

        XCTAssertEqual(environment["HOME"], NSHomeDirectory())
        XCTAssertEqual(
            environment["PATH"],
            (NodeEnvironment.searchPaths + ["/usr/bin:/bin"])
                .joined(separator: ":")
        )
        XCTAssertEqual(Set(environment.keys), ["HOME", "PATH"])
    }

    func testLaunchSiteCanInjectTrustedTaxiPathsAfterSanitization() {
        var environment = NodeEnvironment.buildAppRuntimeEnv(from: [
            "HOME": "/tmp/attacker-home",
            "PATH": "/tmp/attacker-bin",
            "LANG": "ko_KR.UTF-8",
            "LC_ALL": "../../tmp/attacker-locale",
            "NODE_OPTIONS": "--require=/tmp/steal-token.cjs",
            "TAXI_HTTP_TOKEN": "attacker-token",
            "TAXI_BRIDGE_PATH": "/tmp/attacker-bridge",
        ])

        XCTAssertEqual(environment["HOME"], NSHomeDirectory())
        XCTAssertEqual(environment["PATH"], "/usr/bin:/bin:/usr/sbin:/sbin")
        XCTAssertEqual(environment["LANG"], "ko_KR.UTF-8")
        XCTAssertNil(environment["LC_ALL"])
        XCTAssertNil(environment["NODE_OPTIONS"])

        environment["TAXI_APP_RUNTIME_TOKEN_PATH"] = "/tmp/private/http-token"
        environment["TAXI_BRIDGE_PATH"] = "/Applications/Taxi.app/Contents/Resources/bridge"

        XCTAssertEqual(environment["TAXI_APP_RUNTIME_TOKEN_PATH"], "/tmp/private/http-token")
        XCTAssertEqual(
            environment["TAXI_BRIDGE_PATH"],
            "/Applications/Taxi.app/Contents/Resources/bridge"
        )
    }

    func testAppRuntimeEnvAddsOnlyTheSelectedExecutableDirectoryToPath() {
        let environment = NodeEnvironment.buildAppRuntimeEnv(
            from: ["PATH": "/tmp/attacker-bin"],
            executablePath: "/opt/homebrew/bin/npx"
        )

        XCTAssertEqual(
            environment["PATH"],
            "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        )
    }

    func testAppRuntimeEnvCanLaunchResolvedNpxShebang() throws {
        guard let npxPath = NodeEnvironment.findTrustedAppRuntimeExecutable(named: "npx") else {
            throw XCTSkip("npx is not installed")
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: npxPath)
        process.arguments = ["--version"]
        process.environment = NodeEnvironment.buildAppRuntimeEnv(executablePath: npxPath)
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice

        try process.run()
        process.waitUntilExit()

        XCTAssertEqual(process.terminationStatus, 0)
    }

    func testGeneralExecutableLookupPreservesInheritedPathCompatibility() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("taxi-node-path-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let executableName = "path-only-npx-\(UUID().uuidString)"
        let executable = directory.appendingPathComponent(executableName)
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)

        XCTAssertEqual(
            NodeEnvironment.findExecutable(named: executableName, from: ["PATH": directory.path]),
            executable.path
        )
    }

    func testTrustedAppRuntimeLookupIgnoresAttackerPath() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("taxi-untrusted-node-path-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let executableName = "attacker-npx-\(UUID().uuidString)"
        let executable = directory.appendingPathComponent(executableName)
        try Data("#!/bin/sh\nexit 0\n".utf8).write(to: executable)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)

        XCTAssertEqual(
            NodeEnvironment.findExecutable(named: executableName, from: ["PATH": directory.path]),
            executable.path
        )
        XCTAssertNil(NodeEnvironment.findTrustedAppRuntimeExecutable(named: executableName))
    }

    func testGovernedHarnessProducesTheExactCredentialSafeChildEnvironment() {
        let stateRoot = "/tmp/taxi-governed.ABC123"
        let auditKey = String(repeating: "a", count: 64)
        let inherited = [
            "TAXI_FORCE_APP_RUNTIME": "1",
            "CFFIXED_USER_HOME": "\(stateRoot)/home",
            "HOME": "\(stateRoot)/home",
            "PATH": "/tmp/attacker-bin",
            "TAXI_PROFILE": "full",
            "TAXI_TOOL_EXPOSURE": "full",
            "TAXI_MODULE_PACKS": "all",
            "TAXI_REQUIRE_TOOL_SESSION": "false",
            "TAXI_HITL_LEVEL": "sensitive-only",
            "TAXI_HITL_SOCKET_PATH": "\(stateRoot)/hitl.sock",
            "TAXI_CONFIG_PATH": "\(stateRoot)/config.json",
            "TAXI_MEMORY_STORE_PATH": "\(stateRoot)/memory.json",
            "TAXI_VECTOR_STORE_DIR": "\(stateRoot)/audit",
            "TAXI_USAGE_PROFILE_PATH": "\(stateRoot)/usage.json",
            "TAXI_EMERGENCY_STOP_PATH": "\(stateRoot)/emergency-stop",
            "TAXI_TEMP_DIR": "\(stateRoot)/tmp",
            "TAXI_AUDIT_LOG": "true",
            "TAXI_AUDIT_FLUSH_INTERVAL": "25",
            "TAXI_AUDIT_HMAC_KEY": auditKey,
            "TAXI_RATE_LIMIT": "true",
            "TAXI_ELICITATION_DISABLE": "false",
            "TAXI_HTTP_TOKEN": "attacker-token",
            "TAXI_APP_RUNTIME_OWNER_SECRET": "attacker-owner",
            "TAXI_BRIDGE_PATH": "/tmp/attacker-bridge",
            "TAXI_ALLOW_NETWORK": "all",
            "TAXI_NPM_PACKAGE_SPECIFIER": "/tmp/attacker-package",
            "NODE_OPTIONS": "--require=/tmp/steal-token.cjs",
            "NODE_PATH": "/tmp/attacker-modules",
            "DYLD_INSERT_LIBRARIES": "/tmp/steal-token.dylib",
            "LD_LIBRARY_PATH": "/tmp/attacker-libraries",
        ]
        let accepted = [
            "TAXI_PROFILE": "full",
            "TAXI_TOOL_EXPOSURE": "full",
            "TAXI_MODULE_PACKS": "all",
            "TAXI_REQUIRE_TOOL_SESSION": "false",
            "TAXI_HITL_LEVEL": "sensitive-only",
            "TAXI_HITL_SOCKET_PATH": "\(stateRoot)/hitl.sock",
            "TAXI_CONFIG_PATH": "\(stateRoot)/config.json",
            "TAXI_MEMORY_STORE_PATH": "\(stateRoot)/memory.json",
            "TAXI_VECTOR_STORE_DIR": "\(stateRoot)/audit",
            "TAXI_USAGE_PROFILE_PATH": "\(stateRoot)/usage.json",
            "TAXI_EMERGENCY_STOP_PATH": "\(stateRoot)/emergency-stop",
            "TAXI_TEMP_DIR": "\(stateRoot)/tmp",
            "TAXI_AUDIT_LOG": "true",
            "TAXI_AUDIT_FLUSH_INTERVAL": "25",
            "TAXI_AUDIT_HMAC_KEY": auditKey,
            "TAXI_RATE_LIMIT": "true",
            "TAXI_ELICITATION_DISABLE": "false",
        ]

        XCTAssertEqual(NodeEnvironment.appRuntimeAcceptanceOverrides(from: inherited), accepted)

        var child = NodeEnvironment.buildAppRuntimeEnv(
            from: inherited,
            executablePath: "/opt/homebrew/bin/npx"
        )
        for (key, value) in NodeEnvironment.appRuntimeAcceptanceOverrides(from: inherited) {
            child[key] = value
        }
        child["TAXI_ALLOW_NETWORK"] = "with-token"
        child["TAXI_APP_OWNED_RUNTIME"] = "1"
        child["TAXI_APP_RUNTIME_TOKEN_PATH"] = "\(stateRoot)/http-token"
        child["TAXI_APP_RUNTIME_OWNER_PATH"] = "\(stateRoot)/runtime-owner-secret"
        child["TAXI_BRIDGE_PATH"] = "/Applications/Taxi.app/Contents/Resources/taxi/bin/TaxiBridge"

        var expectedChild = accepted
        expectedChild["HOME"] = NSHomeDirectory()
        expectedChild["PATH"] = "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
        expectedChild["TAXI_ALLOW_NETWORK"] = "with-token"
        expectedChild["TAXI_APP_OWNED_RUNTIME"] = "1"
        expectedChild["TAXI_APP_RUNTIME_TOKEN_PATH"] = "\(stateRoot)/http-token"
        expectedChild["TAXI_APP_RUNTIME_OWNER_PATH"] = "\(stateRoot)/runtime-owner-secret"
        expectedChild["TAXI_BRIDGE_PATH"] = "/Applications/Taxi.app/Contents/Resources/taxi/bin/TaxiBridge"

        XCTAssertEqual(child, expectedChild)
    }

    func testSoakHarnessAcceptsOnlyTheFullBundledSurfaceContract() {
        let stateRoot = "/tmp/taxi-soak.ABC123"
        XCTAssertEqual(
            NodeEnvironment.appRuntimeAcceptanceOverrides(from: [
                "TAXI_FORCE_APP_RUNTIME": "1",
                "CFFIXED_USER_HOME": "\(stateRoot)/home",
                "TAXI_PROFILE": "full",
                "TAXI_TOOL_EXPOSURE": "full",
                "TAXI_MODULE_PACKS": "all",
            ]),
            [
                "TAXI_PROFILE": "full",
                "TAXI_TOOL_EXPOSURE": "full",
                "TAXI_MODULE_PACKS": "all",
            ]
        )
    }

    func testAcceptanceOverridesFilterOutOfRootAndMalformedValuesIndividually() {
        let stateRoot = "/tmp/taxi-signed-verify.ABC123"
        let inherited = [
            "TAXI_FORCE_APP_RUNTIME": "1",
            "CFFIXED_USER_HOME": "\(stateRoot)/home",
            "TAXI_CONFIG_PATH": "/Users/example/.config/taxi/config.json",
            "TAXI_MEMORY_STORE_PATH": "\(stateRoot)/nested/../memory.json",
            "TAXI_PROFILE": "full",
            "TAXI_HITL_LEVEL": "all",
            "TAXI_HITL_SOCKET_PATH": "\(stateRoot)/../escaped.sock",
            "TAXI_AUDIT_LOG": "true",
            "TAXI_AUDIT_FLUSH_INTERVAL": "00025",
            "TAXI_AUDIT_HMAC_KEY": "not-a-key",
            "TAXI_RATE_LIMIT": "false",
        ]

        XCTAssertEqual(
            NodeEnvironment.appRuntimeAcceptanceOverrides(from: inherited),
            [
                "TAXI_MEMORY_STORE_PATH": "\(stateRoot)/memory.json",
                "TAXI_PROFILE": "full",
                "TAXI_AUDIT_LOG": "true",
            ]
        )
    }

    func testAcceptanceOverridesRequireCompileHarnessLaunchContract() {
        XCTAssertTrue(NodeEnvironment.appRuntimeAcceptanceOverrides(from: [
            "CFFIXED_USER_HOME": "/tmp/taxi-governed.ABC123/home",
            "TAXI_PROFILE": "full",
        ]).isEmpty)
        XCTAssertTrue(NodeEnvironment.appRuntimeAcceptanceOverrides(from: [
            "TAXI_FORCE_APP_RUNTIME": "1",
            "CFFIXED_USER_HOME": "/Users/example",
            "TAXI_PROFILE": "full",
        ]).isEmpty)
    }

    func testSignedProductionHarnessPassesNoTaxiChildOverrides() {
        let stateRoot = "/tmp/taxi-signed-verify.ABC123"
        let signedLaunchEnvironment = [
            "HOME": "\(stateRoot)/home",
            "CFFIXED_USER_HOME": "\(stateRoot)/home",
        ]

        XCTAssertTrue(
            NodeEnvironment.appRuntimeAcceptanceOverrides(from: signedLaunchEnvironment).isEmpty
        )
        XCTAssertEqual(
            NodeEnvironment.buildAppRuntimeEnv(from: signedLaunchEnvironment),
            [
                "HOME": NSHomeDirectory(),
                "PATH": "/usr/bin:/bin:/usr/sbin:/sbin",
            ]
        )
    }
}
