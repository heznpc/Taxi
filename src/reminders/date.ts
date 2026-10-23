import { z } from "zod";
import { InvalidAutomationInputError } from "../shared/errors.js";

/** Explicit instants only: no host-local parsing, rolled dates or leap seconds.
 * Reminder precision is whole seconds; canonical representation is UTC. */
export function normalizeReminderDate(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.0{1,3})?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  const invalid = () => {
    throw new InvalidAutomationInputError(
      "dueDate must be a valid ISO 8601 timestamp with seconds and explicit timezone (Z or ±HH:MM).",
    );
  };
  if (!match) return invalid();
  const [, year, month, day, hour, minute, second, zone] = match;
  const y = Number(year),
    m = Number(month),
    d = Number(day);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (
    y < 1 ||
    m < 1 ||
    m > 12 ||
    d < 1 ||
    d > days[m - 1]! ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    (zone !== "Z" && (Number(zone!.slice(1, 3)) > 23 || Number(zone!.slice(4)) > 59 || zone === "-00:00"))
  )
    return invalid();
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return invalid();
  const normalized = new Date(timestamp).toISOString();
  if (normalized.length !== 24 || normalized.startsWith("0000")) return invalid();
  return normalized.replace(".000Z", "Z");
}
export const reminderDateSchema = z
  .string()
  .max(64)
  .transform((value, ctx) => {
    try {
      return normalizeReminderDate(value);
    } catch (error) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: (error as Error).message });
      return z.NEVER;
    }
  });
