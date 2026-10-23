import { describe, expect, test } from "@jest/globals";
import { readFileSync } from "node:fs";

import {
  maximumObservationGapMilliseconds,
  minimumObservationSamples,
  parseArgs,
} from "../scripts/soak-app-runtime.mjs";

const terminationHelper = readFileSync(new URL("../scripts/request-app-termination.js", import.meta.url), "utf8");
const soakSource = readFileSync(new URL("../scripts/soak-app-runtime.mjs", import.meta.url), "utf8");

const required = [
  "--url",
  "http://127.0.0.1:3848/mcp",
  "--owner-secret-file",
  "/tmp/owner",
  "--expected-version",
  "1.0.0",
  "--app-pid",
  "101",
  "--app-command",
  "/tmp/Taxi.app/Contents/MacOS/Taxi",
  "--app-birth",
  "Sat Sep  5 01:51:30 2026    ",
  "--runtime-pid",
  "102",
];

describe("app-owned runtime soak gate", () => {
  test("requires at least one hour for release-qualified runs", () => {
    expect(parseArgs(required).durationSeconds).toBe(3600);
    expect(() => parseArgs([...required, "--duration-seconds", "3599"])).toThrow(
      "release soak duration must be at least 3600 seconds",
    );
  });

  test("allows an explicitly marked short harness smoke", () => {
    const options = parseArgs([...required, "--duration-seconds", "1", "--allow-short-soak"]);
    expect(options.durationSeconds).toBe(1);
    expect(options.allowShortSoak).toBe(true);
  });

  test("requires dense observations and bounds scheduler or host-sleep gaps", () => {
    expect(minimumObservationSamples(3600, 5)).toBe(648);
    expect(maximumObservationGapMilliseconds(5)).toBe(15_000);
    expect(maximumObservationGapMilliseconds(10)).toBe(30_000);
  });

  test("requires a native app command and birth identity for every soak", () => {
    const withoutCommand = required.filter(
      (value, index) => value !== "--app-command" && required[index - 1] !== "--app-command",
    );
    const withoutBirth = required.filter(
      (value, index) => value !== "--app-birth" && required[index - 1] !== "--app-birth",
    );
    expect(() => parseArgs(withoutCommand)).toThrow(/--app-command/);
    expect(() => parseArgs(withoutBirth)).toThrow(/--app-birth/);
    const observer = soakSource.match(/async function observeRuntime[\s\S]*?\n  }/)?.[0] ?? "";
    expect(observer).toContain("await assertAppProcessGeneration(options)");
    expect(soakSource).toContain('readPsField(options.appPid, "lstart")');
    expect(soakSource).toContain('readPsField(options.appPid, "command")');
    expect(soakSource).toContain("minTools: FULL_SURFACE_MIN_TOOLS");
    expect(soakSource).toContain("requiredTools: FULL_SURFACE_CANARY_TOOLS");
  });

  test("uses an exact NSRunningApplication identity for normal termination", () => {
    expect(terminationHelper).toContain("runningApplicationWithProcessIdentifier");
    expect(terminationHelper).toContain("application.executableURL");
    expect(terminationHelper).toContain("actualExecutable !== expectedExecutable");
    expect(terminationHelper).toContain("application.terminate");
    expect(terminationHelper).not.toContain("forceTerminate");
  });
});
