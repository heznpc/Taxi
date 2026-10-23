import { describe, expect, test } from "@jest/globals";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => readFileSync(join(ROOT, path), "utf8");
const aggregateCount = /\b\d+\s+(?:tools?|modules?)\b/i;
const visibleText = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const position = /local workspace for coordinating AI sessions and tools/i;

describe("public positioning surfaces", () => {
  test("README distinguishes source-preview capabilities from planned execution", () => {
    const readme = read("README.md");
    const intro = readme.split("## Build from source")[0];
    expect(intro).toMatch(position);
    expect(intro).toMatch(/Task Dashboard/);
    expect(intro).toMatch(/handoffs/);
    expect(intro).toMatch(/model preferences/i);
    expect(intro).toMatch(/Notes.*Mail.*Calendar/s);
    expect(intro).toMatch(/Source preview.*build from source/);
    expect(intro).toMatch(/not yet published/);
    expect(intro).toMatch(/read-only Codex turns/);
    expect(intro).toMatch(/Imported external sessions have no\s+resume authority/);
    expect(intro).not.toMatch(aggregateCount);
    expect(readme).toMatch(/\*\*Design intent:/);
    expect(readme).toMatch(/\*\*Planned:/);
    expect(readme).toMatch(/\*\*Non-goals/);
    expect(readme).toMatch(/## Currently implemented/);
    expect(readme).toMatch(/\*\*Redacted — public data boundary:/);
    expect(readme).not.toMatch(/npx\s|npm install.*@heznpc\/taxi/);
  });

  test("landing metadata and hero describe the workspace and its source status", () => {
    const page = read("docs/index.html");
    const head = page.split("</head>")[0];
    const aboveFold = visibleText(page.split("<!-- Hero -->")[1]?.split("<!-- Modules -->")[0] ?? "");
    expect(head).toMatch(position);
    expect(head).toMatch(/macOS source preview/i);
    expect(head).not.toMatch(aggregateCount);
    expect(aboveFold).toMatch(position);
    expect(aboveFold).toMatch(/Task Dashboard/);
    expect(aboveFold).toMatch(/Source preview/);
    expect(aboveFold).toMatch(/Per-call approval/);
    expect(aboveFold).toMatch(/Audit chain/);
    expect(aboveFold).not.toMatch(aggregateCount);
    expect(page).not.toMatch(/AirMCP|npmjs\.com|releases\/latest/);
  });

  test("docs and package entry points share the same position", () => {
    const docsHome = read("docs/site/src/content/docs/index.mdx");
    const packageMetadata = JSON.parse(read("package.json"));
    for (const copy of [docsHome, packageMetadata.description]) {
      expect(copy).toMatch(position);
      expect(copy).toMatch(/macOS/i);
      expect(copy).toMatch(/source preview/i);
      expect(copy).not.toMatch(aggregateCount);
    }
    expect(packageMetadata.keywords).toEqual(
      expect.arrayContaining(["mcp-server", "ai-workspace", "ai-sessions", "task-handoffs"]),
    );
    const installation = read("docs/site/src/content/docs/getting-started/installation.md");
    expect(installation).toMatch(/not yet published/);
    expect(installation).toContain('"/absolute/path/to/Taxi/dist/index.js"');
    expect(installation).not.toMatch(/npx\s|Node.js 20/);
  });

  test("every locale preserves the source-status keys and count-free marquee", () => {
    const en = JSON.parse(read("docs/locales/en.json"));
    const localeDir = join(ROOT, "docs", "locales");
    for (const file of readdirSync(localeDir).filter((name) => name.endsWith(".json"))) {
      const locale = JSON.parse(readFileSync(join(localeDir, file), "utf8"));
      expect(Object.keys(locale).sort()).toEqual(Object.keys(en).sort());
      const marquee = [
        "meta_title",
        "meta_description",
        "hero_tagline",
        "hero_sub",
        "platforms_title",
        "platforms_sub",
        "why_title",
        "tryit_footer",
      ]
        .map((key) => locale[key])
        .join(" ");
      expect(marquee).toMatch(/Taxi/);
      expect(marquee).not.toMatch(/\d/);
      expect(locale.install_note).toContain("22");
      expect(locale.install_sub).toMatch(/npm.*Registry.*MCPB/);
      expect(locale.hero_tag).toBeTruthy();
    }
  });

  test("generated llms summary identifies implemented and planned boundaries", () => {
    const intro = read("llms.txt").split("## Links")[0];
    expect(intro).toMatch(position);
    expect(intro).toMatch(/source preview/i);
    expect(intro).toMatch(/read-only Codex/);
    expect(intro).toMatch(/observation-only/);
    expect(intro).toMatch(/planned/i);
    expect(intro).not.toMatch(aggregateCount);
    expect(intro).not.toMatch(/not another agent/);
  });

  test("registry metadata describes the workspace without a catalog-size pitch", () => {
    const server = JSON.parse(read("server.json"));
    const smithery = parseYaml(read("smithery.yaml"));
    const descriptions = [
      server.description,
      JSON.parse(read("mcp.json")).mcpServers.taxi.description,
      JSON.parse(read("glama.json")).description,
      JSON.parse(read(".claude-plugin/plugin.json")).description,
      JSON.parse(read("mcpb/manifest.template.json")).long_description,
      smithery.description,
    ];
    for (const description of descriptions) {
      expect(description).toMatch(/local.*workspace/i);
      expect(description).toMatch(/MCP/);
      expect(description).toMatch(/macOS/i);
      expect(description).not.toMatch(aggregateCount);
    }
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(smithery.startCommand.configSchema.required).toContain("serverPath");
  });

  test("source client and support entries do not fetch unpublished packages", () => {
    expect(read("docs/TERMS_OF_SERVICE.md")).toContain("**Package identifier (not yet published):** `@heznpc/taxi`");
    for (const path of [".github/ISSUE_TEMPLATE/config.yml", ".github/ISSUE_TEMPLATE/bug_report.yml"]) {
      expect(read(path)).toContain("node dist/index.js");
      expect(read(path)).not.toMatch(/npx\s/);
    }
    const plugin = JSON.parse(read(".mcp.json")).mcpServers.taxi;
    expect(plugin.command).toBe("node");
    expect(plugin.args).toEqual(["${CLAUDE_PLUGIN_ROOT}/dist/index.js", "run"]);
  });

  test("stats sync cannot repopulate count-led public descriptions", () => {
    const statsSync = read("scripts/count-stats.mjs");
    for (const target of [
      "docs/index.html",
      "docs/site/src/content/docs/index.mdx",
      "docs/locales/",
      "server.json",
      "mcp.json",
      "glama.json",
      "smithery.yaml",
      ".claude-plugin/plugin.json",
    ]) {
      expect(statsSync).not.toContain(`syncFile("${target}`);
    }
  });
});
