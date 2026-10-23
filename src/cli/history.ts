import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { PATHS } from "../shared/constants.js";
import { readAuditEntries, type AuditHistoryEntry } from "../shared/audit.js";
import { readModoreSnapshot } from "../interop/modore.js";

export async function runHistory(args = process.argv.slice(3)): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      since: { type: "string" },
      until: { type: "string" },
      tool: { type: "string" },
      timezone: { type: "string", default: "UTC" },
      output: { type: "string" },
      snapshot: { type: "string" },
      limit: { type: "string", default: "10000" },
      offset: { type: "string", default: "0" },
    },
  });
  const since = values.since ?? new Date(Date.now() - 183 * 86400000).toISOString();
  const until = values.until ?? new Date().toISOString();
  for (const value of [since, until]) {
    if (!/T.*(?:Z|[+-]\d{2}:?\d{2})$/.test(value) || !Number.isFinite(Date.parse(value)))
      throw new Error("Dates require an explicit ISO timestamp and timezone");
  }
  if (Date.parse(since) >= Date.parse(until)) throw new Error("since must precede until");
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: values.timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const limit = Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error("limit must be 1..10000");
  const offset = Number(values.offset);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a nonnegative integer");
  const history = await readAuditEntries({
    offset,
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
    tool: values.tool,
    limit,
  });
  const invocations = history.entries.filter((row) => row.kind === "tool");
  const count = (rows: AuditHistoryEntry[], key: (r: AuditHistoryEntry) => string) => {
    const counts: Record<string, number> = {};
    for (const row of rows) {
      const k = key(row);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    return counts;
  };
  const result = {
    schema: "taxi.execution-history",
    schemaVersion: 1,
    observedAt: new Date().toISOString(),
    period: { since, until, timezone: values.timezone, untilExclusive: true },
    source: PATHS.VECTOR_STORE,
    ...history,
    coverage: {
      complete: false,
      truncated: offset > 0 || offset + history.returned < history.total,
      offset,
      nextOffset: offset + history.returned < history.total ? offset + history.returned : null,
      notes: [
        "Retained audit rows only; disabled, rotated-away and external AI session history are not reconstructed.",
        "Approvals are not invocations. Tool rows may include pre-execution denials. Counts are observed records, not user demand.",
        "Test versus real usage is unclassified. Legacy duplicate records cannot be deduplicated without stable invocation identity.",
        "Args may be redacted. API success does not establish target change or goal verification.",
      ],
    },
    counts: {
      returnedInvocations: invocations.length,
      byTool: count(invocations, (r) => r.tool),
      byDay: count(invocations, (r) => formatter.format(new Date(r.timestamp))),
    },
    modore: values.snapshot ? await readModoreSnapshot(values.snapshot) : undefined,
  };
  const json = JSON.stringify(result, null, 2) + "\n";
  if (values.output) await writeFile(values.output, json, { mode: 0o600, flag: "wx" });
  else console.log(json);
}
