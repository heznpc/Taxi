import { createHash } from "node:crypto";

/** Versioned JSON canonicalization. Digest commits to the tool and parsed args,
 * including target selectors. It is audit evidence, never reusable authority. */
export function approvalRequestDigest(tool: string, args: Record<string, unknown>): string {
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => canonical(item ?? null));
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, item]) => item !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, canonical(item)]),
      );
    return value;
  }
  return (
    "sha256:v1:" +
    createHash("sha256")
      .update(JSON.stringify(canonical({ tool, args })))
      .digest("hex")
  );
}
