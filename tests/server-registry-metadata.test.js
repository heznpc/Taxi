import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const serverJson = JSON.parse(readFileSync(join(ROOT, "server.json"), "utf-8"));
const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8"));
const readme = readFileSync(join(ROOT, "README.md"), "utf-8");

describe("MCP registry server metadata", () => {
  test("description stays within the registry 100-character limit", () => {
    expect(serverJson.description.length).toBeLessThanOrEqual(100);
  });

  test("description leads with the local workspace position and identifies the MCP source preview", () => {
    expect(serverJson.description).toMatch(/^local workspace for coordinating AI sessions and tools\./i);
    expect(serverJson.description).toMatch(/macOS source preview/i);
    expect(serverJson.description).toMatch(/\bMCP\b/);
    expect(serverJson.description).not.toMatch(/available (?:now|today)|published|download|install now/i);
    expect(serverJson.description).not.toMatch(/\d+\s+(?:tools?|modules?)/i);
  });

  test("the short registry pitch retains the documented governed MCP and execution boundaries", () => {
    expect(packageJson.description).toMatch(/local workspace for coordinating AI sessions and tools/i);
    expect(packageJson.description).toMatch(/macOS source preview/i);
    expect(packageJson.description).toMatch(/governed MCP access to Mac apps/i);
    const implemented = readme.split("## Currently implemented")[1]?.split("## Build from source")[0] ?? "";
    expect(implemented).toMatch(/task-scoped tool access,\s+approval controls, audit evidence and an emergency stop/);
    expect(implemented).toMatch(/read-only Codex turns in a dedicated\s+profile/);
    expect(implemented).toMatch(/Imported external sessions have no\s+resume authority/);
  });

  test("registry package metadata is preparation, not a published-distribution claim", () => {
    expect(readme).toMatch(
      /npm package, Registry listing, downloadable MCPB release and signed\s+app installer are not yet published/,
    );
    expect(readme).toMatch(/Source preview — build from source/);
    expect(serverJson.repository).toEqual({ url: "https://github.com/heznpc/Taxi", source: "github" });
    expect(serverJson.packages).toEqual([
      expect.objectContaining({ registryType: "npm", identifier: packageJson.name, version: packageJson.version }),
    ]);
  });
});
