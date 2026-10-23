import { Script } from "node:vm";
import { describe, test, expect } from "@jest/globals";
import { captureWindowScript, listCaptureTargetsScript } from "../dist/screen/scripts.js";

const target = { windowId: 42, ownerPid: 123, title: "Simulator: selected device" };
function window(t = target) {
  return {
    kCGWindowLayer: 0,
    kCGWindowNumber: t.windowId,
    kCGWindowOwnerPID: t.ownerPid,
    kCGWindowName: t.title,
    kCGWindowOwnerName: "Simulator",
    kCGWindowBounds: { X: 10, Y: 20, Width: 300, Height: 400 },
  };
}
function host(before, after = before, granted = true) {
  const commands = [];
  let reads = 0;
  const Application = () => {
    throw new Error("Explicit targets must not activate apps");
  };
  Application.currentApplication = () => ({ doShellScript: (command) => commands.push(command) });
  return {
    commands,
    context: {
      Application,
      ObjC: { import() {}, bindFunction() {}, castRefToObject: (x) => x, deepUnwrap: (x) => x },
      $: {
        CGPreflightScreenCaptureAccess: () => granted,
        CGWindowListCopyWindowInfo: () => (reads++ === 0 ? before : after),
        kCGWindowListOptionOnScreenOnly: 1,
        kCGWindowListExcludeDesktopElements: 2,
      },
    },
  };
}

describe("exact window capture", () => {
  test("selects the requested window among same-app windows without activation", () => {
    const h = host([window({ ...target, windowId: 9, title: "Other device" }), window()]);
    const result = JSON.parse(new Script(captureWindowScript("Simulator", target)).runInNewContext(h.context));
    expect(result.target).toEqual(target);
    expect(result.app).toBe("Simulator");
    expect(Number.isNaN(Date.parse(result.capturedAt))).toBe(false);
    expect(h.commands).toHaveLength(1);
    expect(h.commands[0]).toContain("-l 42 ");
  });

  test.each([{ windowId: 43 }, { ownerPid: 124 }, { title: "New device" }])(
    "rejects stale identity %j without capturing another window",
    (change) => {
      const h = host([window({ ...target, ...change })]);
      expect(() => new Script(captureWindowScript(undefined, target)).runInNewContext(h.context)).toThrow(
        "Capture target is stale or unavailable",
      );
      expect(h.commands).toEqual([]);
    },
  );

  test.each([
    { after: [] },
    { after: [window({ ...target, title: "Changed during capture" })] },
    { after: [window({ ...target, ownerPid: 124 })] },
  ])("discards the captured image if the target disappears or changes", ({ after }) => {
    const h = host([window()], after);
    expect(() => new Script(captureWindowScript(undefined, target)).runInNewContext(h.context)).toThrow(
      "Capture target changed during capture",
    );
    expect(h.commands).toHaveLength(2);
    expect(h.commands[1]).toMatch(/^\/bin\/rm -f /);
  });

  test("treats window titles as data, including quotes and script fragments", () => {
    const strange = { ...target, title: '\"; throw new Error(\"injected\"); // 日本語\n$(touch /tmp/never)' };
    const h = host([window(strange)]);
    const result = JSON.parse(new Script(captureWindowScript(undefined, strange)).runInNewContext(h.context));
    expect(result.target).toEqual(strange);
    expect(h.commands[0]).not.toContain(strange.title);
  });

  test("lists capture-compatible IDs and excludes non-window layers", () => {
    const h = host([window(), { ...window(), kCGWindowLayer: 24 }]);
    expect(JSON.parse(new Script(listCaptureTargetsScript()).runInNewContext(h.context))).toEqual([
      { app: "Simulator", target, position: [10, 20], size: [300, 400] },
    ]);
    expect(h.commands).toEqual([]);
  });

  test("denied Screen Recording stops before enumeration or capture", () => {
    const h = host([window()], undefined, false);
    expect(() => new Script(captureWindowScript(undefined, target)).runInNewContext(h.context)).toThrow(
      "Screen Recording permission denied",
    );
    expect(h.commands).toEqual([]);
  });
});
