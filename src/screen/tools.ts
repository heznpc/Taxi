import type { McpServer } from "../shared/mcp.js";
import { z } from "zod";
import { readFile, stat, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { runJxa } from "../shared/jxa.js";
import type { TaxiConfig } from "../shared/config.js";
import { okUntrusted, errJxaFor } from "../shared/result.js";
import {
  captureScreenScript,
  captureWindowScript,
  captureAreaScript,
  listWindowsScript,
  listCaptureTargetsScript,
  recordScreenScript,
  type WindowCaptureTarget,
} from "./scripts.js";
import { BUFFER } from "../shared/constants.js";

/**
 * Run a JXA capture script that returns { path: string },
 * read the resulting PNG as base64, clean up the temp file,
 * and return MCP image content.
 */
async function captureAndReturn(script: string) {
  const result = await runJxa<{ path: string; capturedAt?: string; target?: WindowCaptureTarget; app?: string }>(
    script,
  );
  const filePath = result.path;
  try {
    // Check file size BEFORE reading into memory to avoid OOM on huge screenshots
    const { size } = await stat(filePath);
    if (size > BUFFER.CAPTURE) {
      try {
        await unlink(filePath);
      } catch {
        /* ignore */
      }
      throw new Error("Screenshot too large (>5MB). Use capture_area for a smaller region or reduce resolution.");
    }
    const buffer = await readFile(filePath);
    if (
      buffer.length < 24 ||
      buffer.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      buffer.toString("ascii", 12, 16) !== "IHDR" ||
      buffer.readUInt32BE(16) === 0 ||
      buffer.readUInt32BE(20) === 0
    ) {
      throw new Error("Capture did not produce a PNG with valid dimensions.");
    }
    const base64 = buffer.toString("base64");
    const evidence = okUntrusted({
      capturedAt: result.capturedAt ?? new Date().toISOString(),
      ...(result.target ? { target: result.target, app: result.app } : {}),
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
      sha256: createHash("sha256").update(buffer).digest("hex"),
      verification: "Image captured; the caller must compare it with the expected state.",
    });
    return {
      ...evidence,
      content: [{ type: "image" as const, data: base64, mimeType: "image/png" }, ...evidence.content],
    };
  } finally {
    try {
      await unlink(filePath);
    } catch {
      // Ignore cleanup errors
    }
  }
}

export function registerScreenTools(server: McpServer, _config: TaxiConfig): void {
  server.registerTool(
    "capture_screen",
    {
      title: "Capture Screen",
      description:
        "Capture a full-screen screenshot as a PNG image. Optionally specify a display number for multi-monitor setups (1 = main display). Requires Screen Recording permission.",
      inputSchema: {
        display: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Display number for multi-monitor setups (1 = main display). Omit for default display."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        sensitiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ display }) => {
      try {
        return await captureAndReturn(captureScreenScript(display));
      } catch (e) {
        return errJxaFor("capture screen", e);
      }
    },
  );

  server.registerTool(
    "capture_window",
    {
      title: "Capture Window",
      description:
        "Capture a window as a PNG with timestamp, dimensions, and hash. For an exact window pass windowId, ownerPid and title from list_windows(captureTargets: true); stale targets fail without falling back. Otherwise capture the frontmost window, optionally activating appName. Requires Screen Recording permission. The caller verifies the expected screen state.",
      inputSchema: {
        windowId: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "CoreGraphics windowId from list_windows(captureTargets: true). Supply ownerPid and title together; does not activate apps.",
          ),
        ownerPid: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Owner process ID from the selected window target. Required together with windowId and title."),
        title: z
          .string()
          .max(10000)
          .optional()
          .describe(
            "Exact title from the selected window target, including an empty title. Required together with windowId and ownerPid.",
          ),
        appName: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Without windowId, activate this application before capture (e.g. 'Safari', 'Xcode'). With windowId, only verify the owner name without activating. Omit all parameters for the frontmost window.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        sensitiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ appName, windowId, ownerPid, title }) => {
      try {
        const hasTarget = windowId !== undefined || ownerPid !== undefined || title !== undefined;
        if (hasTarget && (windowId === undefined || ownerPid === undefined || title === undefined)) {
          throw new Error(
            "Exact capture requires windowId, ownerPid and title together from list_windows(captureTargets: true).",
          );
        }
        const target = hasTarget ? { windowId: windowId!, ownerPid: ownerPid!, title: title! } : undefined;
        return await captureAndReturn(captureWindowScript(appName, target));
      } catch (e) {
        return errJxaFor("capture window", e);
      }
    },
  );

  server.registerTool(
    "capture_area",
    {
      title: "Capture Screen Area",
      description:
        "Capture a screenshot of a specific rectangular region of the screen. Coordinates are in screen pixels with origin at top-left. Requires Screen Recording permission.",
      inputSchema: {
        x: z.number().describe("X coordinate of the top-left corner of the capture region"),
        y: z.number().describe("Y coordinate of the top-left corner of the capture region"),
        width: z.number().min(1).describe("Width of the capture region in pixels"),
        height: z.number().min(1).describe("Height of the capture region in pixels"),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        sensitiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ x, y, width, height }) => {
      try {
        return await captureAndReturn(captureAreaScript(x, y, width, height));
      } catch (e) {
        return errJxaFor("capture area", e);
      }
    },
  );

  server.registerTool(
    "list_windows",
    {
      title: "List Windows",
      description:
        "List visible windows. Set captureTargets to get exact CoreGraphics target objects for capture_window (requires Screen Recording). The default Accessibility listing returns app name, bundle ID, title, position and size.",
      inputSchema: {
        captureTargets: z
          .boolean()
          .optional()
          .default(false)
          .describe("Return capturable window targets for capture_window without activating apps."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        sensitiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ captureTargets }) => {
      try {
        return okUntrusted(await runJxa(captureTargets ? listCaptureTargetsScript() : listWindowsScript()));
      } catch (e) {
        return errJxaFor("list windows", e);
      }
    },
  );

  server.registerTool(
    "record_screen",
    {
      title: "Record Screen",
      description:
        "Record the screen for a specified duration (1-60 seconds). Returns the recording as a .mov file path. Requires Screen Recording permission.",
      inputSchema: {
        duration: z.number().int().min(1).max(60).describe("Recording duration in seconds (1-60)"),
        display: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Display number for multi-monitor setups (1 = main display). Omit for default display."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ duration, display }, extra) => {
      try {
        const progressToken = extra._meta?.progressToken;
        const recordPromise = runJxa<{ path: string; duration: number }>(recordScreenScript(duration, display));

        // Send progress updates while recording
        if (progressToken !== undefined) {
          const start = Date.now();
          let timerCleared = false;
          const timer = setInterval(async () => {
            if (timerCleared) return;
            const elapsed = Math.min(Math.round((Date.now() - start) / 1000), duration);
            try {
              await extra.sendNotification({
                method: "notifications/progress",
                params: {
                  progressToken,
                  progress: elapsed,
                  total: duration,
                  message: `Recording: ${elapsed}/${duration}s`,
                },
              });
            } catch {
              /* notification failure is non-fatal */
            }
            if (elapsed >= duration) {
              timerCleared = true;
              clearInterval(timer);
            }
          }, 500);
          recordPromise.finally(() => {
            timerCleared = true;
            clearInterval(timer);
          });
        }

        const result = await recordPromise;
        const { size } = await stat(result.path);
        if (size > BUFFER.CAPTURE) {
          try {
            await unlink(result.path);
          } catch {
            /* ignore */
          }
          throw new Error("Recording too large (>5MB). Use a shorter duration or smaller region.");
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                path: result.path,
                duration: result.duration,
                message: `Screen recorded for ${result.duration}s. File saved to ${result.path}`,
              }),
            },
          ],
        };
      } catch (e) {
        return errJxaFor("record screen", e);
      }
    },
  );
}
