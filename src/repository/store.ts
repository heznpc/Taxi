import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename } from "node:path";
import { createHash } from "node:crypto";

const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_FILE = 512 * 1024;
const TEXT_EXTENSIONS =
  /\.(?:md|txt|ts|tsx|js|jsx|mjs|cjs|json|yaml|yml|toml|swift|py|sh|bash|zsh|html|css|scss|xml|plist|strings|sql|graphql|proto|rs|go|c|h|cpp|hpp|java|kt|rb|lock|gitignore|gitattributes)$/i;
const DENIED =
  /(?:^|\/)(?:\.git|\.env(?:\..*)?|\.ssh|\.aws|\.npmrc|\.netrc|credentials?(?:\..*)?|secrets?(?:\..*)?|id_rsa|id_ed25519|AuthKey_[^/]*)(?:\/|$)|\.(?:pem|p8|p12|pfx|key|keychain|db|sqlite|jsonl)$/i;

/** Only ordinary tracked source/text blobs; no filesystem reads through MCP. */
export function allowedRepoPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 1000 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path.split("/").some((part) => !part || part === "." || part === "..") &&
    !Array.from(path).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) &&
    !DENIED.test(path) &&
    (TEXT_EXTENSIONS.test(path) ||
      /^(?:LICENSE|NOTICE|Dockerfile|Makefile|\.gitignore|\.gitattributes)$/.test(basename(path)))
  );
}

export class RepositoryStore {
  private constructor(readonly root: string) {}

  static async open(root: string): Promise<RepositoryStore> {
    const canonical = await realpath(root);
    const store = new RepositoryStore(canonical);
    if ((await store.git(["rev-parse", "--show-toplevel"])).trim() !== canonical) {
      throw new Error("--root must be the Git worktree root, not a parent or subdirectory.");
    }
    await store.revision("HEAD");
    return store;
  }

  /** Fixed Git verbs, argv (never shell), no external diff/textconv or inherited Git overrides. */
  private git(args: string[], allowNoMatch = false): Promise<string> {
    const env: NodeJS.ProcessEnv = {
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: process.env.HOME,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_LITERAL_PATHSPECS: "1",
      LC_ALL: "C",
    };
    return new Promise((resolve, reject) => {
      execFile(
        "/usr/bin/git",
        [
          "--no-pager",
          "-c",
          "core.fsmonitor=false",
          "-c",
          "core.hooksPath=/dev/null",
          "-c",
          "color.ui=false",
          "-C",
          this.root,
          ...args,
        ],
        { env, timeout: 10_000, maxBuffer: MAX_OUTPUT, encoding: "utf8" },
        (error, stdout) => {
          if (error && !(allowNoMatch && error.code === 1)) {
            reject(
              new Error("Repository query failed or exceeded its size/time limit. Use a narrower path or revision."),
            );
          } else resolve(stdout);
        },
      );
    });
  }

  async revision(ref: string): Promise<string> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_./~^{}@-]{0,199}$/.test(ref) || ref.includes("..") || ref.includes("@{")) {
      throw new Error("Use one local commit or ref; ranges and option-like revisions are not accepted.");
    }
    const oid = (await this.git(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`])).trim();
    if (!/^[a-f0-9]{40,64}$/.test(oid)) throw new Error("Revision did not resolve to a commit.");
    return oid;
  }

  async status() {
    const head = await this.revision("HEAD");
    const branch = (await this.git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const porcelain = await this.git([
      "status",
      "--porcelain=v1",
      "--untracked-files=normal",
      "--ignore-submodules=all",
      "-z",
    ]);
    return {
      repository: basename(this.root),
      branch,
      head,
      dirty: porcelain.length > 0,
      observedAt: new Date().toISOString(),
      contentSource: "Git commit objects (default HEAD)",
      diffScopes: ["commits", "staged"],
      workingTreeNote:
        "Dirty includes uncommitted changes. File reads/search use the reported commit; unstaged and untracked content is not exported.",
    };
  }

  private async entries(commit: string) {
    const raw = await this.git(["ls-tree", "-r", "-z", commit]);
    return raw
      .split("\0")
      .filter(Boolean)
      .flatMap((line) => {
        const match = /^(100644|100755) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
        return match && allowedRepoPath(match[3]!) ? [{ path: match[3]!, oid: match[2]! }] : [];
      });
  }

  async tree(ref = "HEAD", prefix = "", offset = 0, limit = 200) {
    const commit = await this.revision(ref);
    const files = (await this.entries(commit)).filter((file) => file.path.startsWith(prefix));
    return {
      commit,
      source: "commit",
      total: files.length,
      files: files.slice(offset, offset + limit),
      nextOffset: offset + limit < files.length ? offset + limit : null,
    };
  }

  async read(path: string, ref = "HEAD", startLine = 1, limit = 200) {
    if (!allowedRepoPath(path)) throw new Error("Path is outside the allowed source/text policy.");
    const commit = await this.revision(ref);
    const entry = (await this.entries(commit)).find((file) => file.path === path);
    if (!entry)
      throw new Error("File is not a regular allowed blob in this commit (symlinks/submodules are excluded).");
    const size = Number((await this.git(["cat-file", "-s", entry.oid])).trim());
    if (size > MAX_FILE) throw new Error("File exceeds the 512 KiB source limit.");
    const text = await this.git(["cat-file", "blob", entry.oid]);
    if (text.includes("\0")) throw new Error("Binary files are not exported.");
    const lines = text.split("\n");
    const selected = lines.slice(startLine - 1, startLine - 1 + limit);
    const returned: string[] = [];
    let length = 0;
    for (const line of selected) {
      if (line.length > 60_000) {
        if (returned.length === 0)
          throw new Error("Single line exceeds the 60000 character limit; line cannot be exported.");
        break;
      }
      const addition = line.length + (returned.length ? 1 : 0);
      if (length + addition > 60_000) break;
      returned.push(line);
      length += addition;
    }
    const content = returned.join("\n");
    return {
      path,
      commit,
      blob: entry.oid,
      sha256: createHash("sha256").update(text).digest("hex"),
      startLine,
      totalLines: lines.length,
      content,
      truncated: returned.length < selected.length,
      nextLine: startLine - 1 + returned.length < lines.length ? startLine + returned.length : null,
    };
  }

  async log(ref = "HEAD", limit = 20) {
    const commit = await this.revision(ref);
    const text = await this.git([
      "log",
      "--no-show-signature",
      `--max-count=${limit}`,
      "--format=%H%x00%cI%x00%s%x00",
      commit,
    ]);
    const fields = text.split("\0");
    const commits = [];
    for (let index = 0; index + 2 < fields.length; index += 3) {
      commits.push({
        commit: fields[index]!.trim(),
        date: fields[index + 1],
        subject: fields[index + 2]!.slice(0, 500),
      });
    }
    return { head: commit, commits };
  }

  async search(query: string, ref = "HEAD", prefix = "", limit = 50) {
    if (query.includes("\n") || query.includes("\r") || query.includes("\0")) {
      throw new Error("Search query must be one literal line.");
    }
    const commit = await this.revision(ref);
    const paths = (await this.entries(commit)).map((file) => file.path).filter((path) => path.startsWith(prefix));
    const matches: string[] = [];
    let truncated = false;
    let searchedFiles = 0;
    const deadline = Date.now() + 10_000;
    for (let index = 0; index < paths.length; index += 100) {
      if (Date.now() > deadline) {
        truncated = true;
        break;
      }
      const output = await this.git(
        [
          "grep",
          "-n",
          "-I",
          "-F",
          "--no-textconv",
          "-m",
          "5",
          "-e",
          query,
          commit,
          "--",
          ...paths.slice(index, index + 100),
        ],
        true,
      );
      searchedFiles += Math.min(100, paths.length - index);
      matches.push(
        ...output
          .split("\n")
          .filter(Boolean)
          .map((line) => line.slice(commit.length + 1, commit.length + 4001)),
      );
      if (matches.length >= limit) {
        truncated = true;
        break;
      }
    }
    return {
      commit,
      matches: matches.slice(0, limit),
      truncated,
      searchedFiles,
      totalFiles: paths.length,
      maxMatchesPerFile: 5,
      note: "Literal, case-sensitive search of allowed committed files. Each match is path:line:text; long lines are capped at 4000 characters.",
    };
  }

  async diff(base: string, target = "HEAD", path = "", staged = false) {
    if (path && !allowedRepoPath(path)) throw new Error("Diff path must be an allowed source/text file.");
    const from = await this.revision(base);
    const to = await this.revision(target);
    const files = new Set([...(await this.entries(from)), ...(await this.entries(to))].map((file) => file.path));
    // Staged blobs are separately filtered. --no-renames prevents a denied old
    // filename being included as the other side of an allowed rename.
    if (staged) {
      const indexed = await this.git(["ls-files", "--stage", "-z"]);
      for (const row of indexed.split("\0")) {
        const match = /^(100644|100755) [a-f0-9]+ 0\t([\s\S]+)$/.exec(row);
        if (match && allowedRepoPath(match[2]!)) files.add(match[2]!);
      }
    }
    const changed = (
      await this.git([
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-renames",
        "--name-only",
        "-z",
        ...(staged ? ["--cached", from] : [from, to]),
        "--",
      ])
    ).split("\0");
    const selected = changed.filter((file) => files.has(file) && (!path || file === path));
    if (selected.length > 200 && !path)
      throw new Error("Specify one path for diffs in repositories with more than 200 allowed files.");
    if (!selected.length) return { base: from, target: staged ? "index" : to, patch: "", truncated: false };
    const patch = await this.git([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--no-color",
      "--unified=3",
      ...(staged ? ["--cached", from] : [from, to]),
      "--",
      ...selected,
    ]);
    return {
      base: from,
      target: staged ? "index" : to,
      patch: patch.slice(0, 60_000),
      truncated: patch.length > 60_000,
    };
  }
}
