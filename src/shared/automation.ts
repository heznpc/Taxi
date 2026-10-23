import { runSwift, hasSwiftCommand } from "./swift.js";
import { runJxa } from "./jxa.js";
import { AutomationOutcomeUnknownError, SwiftNotDispatchedError } from "./errors.js";

/** Missing/unsupported Swift commands may use JXA. Once dispatched, failures
 * are uncertain unless the caller explicitly guarantees that replay is safe.
 * Errors can originate from either bridge; they are no longer always JXA. */
export async function runAutomation<T>(options: {
  swift: { command: string; input?: unknown };
  jxa: () => string;
  parse?: (raw: string) => T;
  /** Opt in only for operations whose replay cannot duplicate side effects. */
  retrySafe?: boolean;
}): Promise<T> {
  const input = JSON.stringify(options.swift.input ?? {});
  if (await hasSwiftCommand(options.swift.command)) {
    try {
      return await runSwift<T>(options.swift.command, input);
    } catch (error) {
      if (!(error instanceof SwiftNotDispatchedError) && !options.retrySafe) {
        throw new AutomationOutcomeUnknownError(options.swift.command, "swift", error);
      }
    }
  }
  // Generate/validate before dispatch; a script-generation error has no effect.
  const script = options.jxa();
  try {
    return await runJxa<T>(script);
  } catch (error) {
    if (options.retrySafe) throw error;
    throw new AutomationOutcomeUnknownError(options.swift.command, "jxa", error);
  }
}
