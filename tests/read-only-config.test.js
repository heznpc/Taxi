import { afterAll, describe, expect, test } from "@jest/globals";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOnlyConfigFileSnapshot } from "../dist/shared/config.js";

const scratch = mkdtempSync(join(tmpdir(), "taxi-read-only-config-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe("read-only config file snapshots", () => {
  test("returns content and metadata from one bounded regular-file descriptor", () => {
    const path = join(scratch, "config.json");
    writeFileSync(path, '{"profile":"starter"}\n', { mode: 0o600 });

    expect(readOnlyConfigFileSnapshot(path, { label: "test config" })).toMatchObject({
      content: '{"profile":"starter"}\n',
      mode: 0o600,
      size: 22,
      uid: process.getuid(),
    });
  });

  test("does not follow a symlink at the selected config path", () => {
    const target = join(scratch, "target.json");
    const link = join(scratch, "linked.json");
    writeFileSync(target, "{}\n", { mode: 0o600 });
    symlinkSync(target, link);

    expect(() => readOnlyConfigFileSnapshot(link, { label: "linked config" })).toThrow(/symbolic link/);
  });

  test("rejects directories and content above the caller's byte limit", () => {
    const directory = join(scratch, "directory.json");
    const oversized = join(scratch, "oversized.json");
    mkdirSync(directory);
    writeFileSync(oversized, "12345", { mode: 0o600 });

    expect(() => readOnlyConfigFileSnapshot(directory, { label: "directory config" })).toThrow(/not a regular file/);
    expect(() => readOnlyConfigFileSnapshot(oversized, { label: "large config", maxBytes: 4 })).toThrow(
      /4-byte diagnostic read limit/,
    );
  });

  test("returns undefined for an absent optional config", () => {
    expect(readOnlyConfigFileSnapshot(join(scratch, "missing.json"))).toBeUndefined();
  });
});
