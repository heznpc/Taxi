import { beforeEach, afterEach, describe, test, expect } from "@jest/globals";
import { mkdtemp, writeFile, mkdir, rm, symlink, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RepositoryStore } from "../dist/repository/store.js";

let root, store, head;
const git = (...args) =>
  execFileSync("/usr/bin/git", ["-C", root, ...args], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    },
  }).trim();
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "taxi-repo-test-"));
  git("init", "-q");
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/main.ts"), "export const answer = 42;\n// unique fixture phrase\n");
  await writeFile(join(root, "README.md"), "# Fixture\n");
  await writeFile(join(root, ".env"), "SECRET=never-return\n");
  await writeFile(join(root, "secret.key"), "never-return");
  await writeFile(join(root, ".gitignore"), "ignored.txt\n");
  await symlink("/etc/passwd", join(root, "linked.txt"));
  git("add", ".");
  git("commit", "-qm", "first fixture");
  head = git("rev-parse", "HEAD");
  store = await RepositoryStore.open(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("read-only local repository store", () => {
  test("reports live HEAD/dirty but reads pinned committed bytes", async () => {
    expect(await store.status()).toMatchObject({ head, dirty: false });
    await writeFile(join(root, "src/main.ts"), "not committed\n");
    expect(await store.status()).toMatchObject({ head, dirty: true });
    expect((await store.read("src/main.ts")).content).toContain("answer = 42");
    expect(git("rev-parse", "HEAD")).toBe(head);
  });
  test("lists allowed regular source blobs only and paginates", async () => {
    const tree = await store.tree();
    expect(tree.files.map((f) => f.path)).toEqual([".gitignore", "README.md", "src/main.ts"]);
    expect(await store.tree("HEAD", "", 0, 1)).toMatchObject({ total: 3, nextOffset: 1 });
  });
  test.each(["../README.md", "/etc/passwd", ".git/config", ".env", "secret.key", "linked.txt", "src/../../etc/passwd"])(
    "rejects excluded path %s",
    async (path) => {
      await expect(store.read(path)).rejects.toThrow();
    },
  );
  test("untracked/ignored files and parent directories cannot be read", async () => {
    await writeFile(join(root, "untracked.md"), "private");
    await writeFile(join(root, "ignored.txt"), "private");
    await expect(store.read("untracked.md")).rejects.toThrow();
    await expect(store.read("ignored.txt")).rejects.toThrow();
    await expect(RepositoryStore.open(join(root, "src"))).rejects.toThrow("worktree root");
  });
  test("line reads and literal searches carry the commit", async () => {
    expect(await store.read("src/main.ts", "HEAD", 2, 1)).toMatchObject({
      commit: head,
      startLine: 2,
      content: "// unique fixture phrase",
    });
    expect(await store.search("unique fixture")).toMatchObject({
      commit: head,
      matches: ["src/main.ts:2:// unique fixture phrase"],
    });
    expect((await store.search("never-return")).matches).toEqual([]);
    expect((await store.search("not found")).matches).toEqual([]);
    expect((await store.log()).commits[0]).toEqual({
      commit: head,
      date: expect.any(String),
      subject: "first fixture",
    });
  });
  test("commit and staged diffs exclude credential paths and never execute configured helpers", async () => {
    const marker = join(root, "helper-ran");
    await writeFile(join(root, ".gitattributes"), "*.ts diff=malicious\n");
    git("config", "diff.malicious.command", `touch ${marker}`);
    git("config", "diff.malicious.textconv", `touch ${marker}`);
    git("config", "core.fsmonitor", `touch ${marker}`);
    await writeFile(join(root, "src/main.ts"), "export const answer = 43;\n");
    await writeFile(join(root, ".env"), "NEW_SECRET=never-export\n");
    git("-c", "core.fsmonitor=false", "add", ".");
    const staged = await store.diff(head, "HEAD", "", true);
    expect(staged.patch).toContain("+export const answer = 43;");
    expect(staged.patch).not.toContain("NEW_SECRET");
    await store.search("answer");
    await store.status();
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
    git("-c", "core.fsmonitor=false", "commit", "-qm", "second fixture");
    expect((await store.diff(head)).patch).toContain("+export const answer = 43;");
    expect((await store.read("src/main.ts", head)).content).toContain("42");
  });
  test.each(["--help", "HEAD..HEAD", "HEAD:path", "HEAD@{1}", "HEAD; touch /tmp/never"])(
    "rejects non-single revision %s",
    async (ref) => {
      await expect(store.revision(ref)).rejects.toThrow();
    },
  );
  test("oversized and binary committed files are rejected", async () => {
    await writeFile(join(root, "big.txt"), "a".repeat(513 * 1024));
    await writeFile(join(root, "binary.txt"), Buffer.from([0, 1, 2]));
    git("add", ".");
    git("commit", "-qm", "size fixture");
    await expect(store.read("big.txt")).rejects.toThrow("512 KiB");
    await expect(store.read("binary.txt")).rejects.toThrow("Binary");
  });
});

test('character cap returns only whole lines and continuation does not skip content', async () => {
  const lines = Array.from({ length: 200 }, (_, i) => `${i}:` + 'a'.repeat(600));
  await writeFile(join(root, 'large.txt'), lines.join('\n'));
  git('add', 'large.txt'); git('commit', '-qm', 'large fixture');
  const revision = git('rev-parse', 'HEAD');
  const collected = []; let next = 1;
  while (next !== null) {
    const page = await store.read('large.txt', revision, next, 200);
    expect(page.content.length).toBeLessThanOrEqual(60000);
    collected.push(...page.content.split('\n'));
    if (page.nextLine !== null) expect(page.nextLine).toBeGreaterThan(next);
    next = page.nextLine;
  }
  expect(collected).toEqual(lines);
});
test('a single oversized line fails explicitly without an endless continuation', async () => {
  await writeFile(join(root, 'wide.txt'), 'ok\n' + 'x'.repeat(60001));
  git('add', 'wide.txt'); git('commit', '-qm', 'wide fixture');
  const first = await store.read('wide.txt');
  expect(first).toMatchObject({ content: 'ok', truncated: true, nextLine: 2 });
  await expect(store.read('wide.txt', first.commit, first.nextLine)).rejects.toThrow('Single line exceeds');
});
