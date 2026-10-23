import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "@jest/globals";

const root = new URL("..", import.meta.url);
const src = readFileSync(new URL("swift/Sources/TaxiKit/AppEntities.swift", root), "utf8");
const generated = readFileSync(new URL("swift/Sources/TaxiKit/Generated/MCPIntents.swift", root), "utf8");

describe("Taxi AppEntity scaffold", () => {
  test("defines workflow-domain entities backed by EntityStringQuery", () => {
    expect(src).toContain("public protocol TaxiStringBackedEntity: AppEntity");
    expect(src).toContain("public struct TaxiStringEntityQuery");
    expect(src).toContain("public struct TaxiCalendarEventQuery");
    expect(src).toContain("public struct TaxiReminderQuery");
    expect(src).toContain("public struct TaxiContactQuery");
    expect(src).toContain("EntityStringQuery");
    expect(src).toContain("public struct TaxiCalendarEventEntity");
    expect(src).toContain("public struct TaxiReminderEntity");
    expect(src).toContain("public struct TaxiContactEntity");
  });

  test("does not use deprecated Assistant schema macros", () => {
    expect(src).not.toMatch(/@Assistant(?:Intent|Entity|Enum)\b/);
    expect(src).not.toMatch(/Assistant(?:Intent|Entity|Enum)\(schema:/);
  });

  test("keeps workflow entities plain until matching schema constants are usable", () => {
    expect(src).not.toMatch(/@AppEntity\s*\(\s*schema:/);
    expect(generated).not.toMatch(/@AppIntent\s*\(\s*schema:/);
    expect(src).not.toMatch(/AssistantSchema\.(?:IntentSchema|EntitySchema)\s*\(/);
  });

  test("compiles and rejects synthetic entities for write intent routing", () => {
    if (process.platform !== "darwin") return;

    const sdk = spawnSync("xcrun", ["--sdk", "macosx", "--show-sdk-path"], {
      encoding: "utf8",
    });
    expect(sdk.status).toBe(0);

    const probe = `
#if canImport(AppIntents)
import AppIntents
import Foundation

func probeTaxiEntities() async throws {
    let query = TaxiStringEntityQuery<TaxiCalendarEventEntity>()
    let events = try await query.entities(for: ["event-1"])
    _ = events.first?.displayRepresentation
    let synthetic = TaxiStringEntityQuery<TaxiReminderEntity>.syntheticEntity(id: " reminder-1 ")
    precondition(synthetic.id == "reminder-1")
    precondition(synthetic.isSynthetic)
    precondition(synthetic.subtitle == TaxiStringEntityQuery<TaxiReminderEntity>.syntheticSubtitle)
    do {
        _ = try requireResolvedTaxiEntityId(synthetic, tool: "complete_reminder")
        preconditionFailure("synthetic entity should be rejected for write routing")
    } catch TaxiAppEntityResolutionError.unresolvedEntity(let type, let id, let tool) {
        precondition(type.contains("TaxiReminderEntity"))
        precondition(id == "reminder-1")
        precondition(tool == "complete_reminder")
    }
    let resolved = TaxiReminderEntity(id: "reminder-1", title: "Pay invoice", subtitle: "Today")
    precondition(!resolved.isSynthetic)
    let resolvedId = try requireResolvedTaxiEntityId(resolved, tool: "complete_reminder")
    precondition(resolvedId == "reminder-1")
    _ = TaxiCalendarEventEntity.defaultQuery
    _ = TaxiReminderEntity.defaultQuery
    _ = TaxiContactEntity.defaultQuery
    _ = TaxiContactEntity(id: "contact-1", title: "Ren", subtitle: nil)
}

@main
struct ProbeMain {
    static func main() async throws {
        try await probeTaxiEntities()
    }
}
#endif
`;

    const temp = mkdtempSync(join(tmpdir(), "taxi-appentities-"));
    const exe = join(temp, "probe");
    const probePath = join(temp, "Probe.swift");
    writeFileSync(probePath, probe);
    try {
      const result = spawnSync(
        "xcrun",
        [
          "swiftc",
          "-target",
          "arm64-apple-macos14.0",
          "-sdk",
          sdk.stdout.trim(),
          "swift/Sources/TaxiKit/Types.swift",
          "swift/Sources/TaxiKit/EventKitService.swift",
          "swift/Sources/TaxiKit/ContactsService.swift",
          "swift/Sources/TaxiKit/AppEntities.swift",
          probePath,
          "-o",
          exe,
        ],
        {
          cwd: new URL(".", root),
          encoding: "utf8",
        },
      );

      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const run = spawnSync(exe, [], { encoding: "utf8" });
      expect(run.stderr).toBe("");
      expect(run.status).toBe(0);
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });

  test("generated AppIntents use entity parameters and guard write routes", () => {
    expect(generated).toContain("public var id: TaxiCalendarEventEntity");
    expect(generated).toContain("public var id: TaxiReminderEntity");
    expect(generated).toContain("public var id: TaxiContactEntity");
    expect(generated).toContain('args: ["id": id.id]');
    expect(generated).toContain('args["id"] = try requireResolvedTaxiEntityId(id, tool: "complete_reminder")');
    expect(generated).toContain('args["id"] = try requireResolvedTaxiEntityId(id, tool: "add_contact_email")');
    expect(generated).toContain('args["id"] = try requireResolvedTaxiEntityId(id, tool: "add_contact_phone")');
    expect(generated).toContain(
      "intent.id = TaxiStringEntityQuery<TaxiCalendarEventEntity>.syntheticEntity(id: id)",
    );
    expect(generated).toContain("intent.id = TaxiStringEntityQuery<TaxiReminderEntity>.syntheticEntity(id: id)");
    expect(generated).toContain("intent.id = TaxiStringEntityQuery<TaxiContactEntity>.syntheticEntity(id: id)");
  });
});
