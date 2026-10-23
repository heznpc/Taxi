ObjC.import("AppKit");

function fail(message) {
  throw new Error(`request-app-termination: ${message}`);
}

function run(argv) {
  if (argv.length !== 2) {
    fail("expected <pid> <absolute-executable-path>");
  }

  const pid = Number(argv[0]);
  const expectedExecutable = argv[1];
  if (!Number.isSafeInteger(pid) || pid < 2 || !expectedExecutable.startsWith("/")) {
    fail("invalid process identity");
  }

  const application = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid);
  if (!application || application.isNil()) {
    fail(`process ${pid} is not an NSRunningApplication`);
  }

  const executableURL = application.executableURL;
  const actualExecutable =
    executableURL && !executableURL.isNil() ? ObjC.unwrap(executableURL.path) : "";
  if (actualExecutable !== expectedExecutable) {
    fail(`process ${pid} executable mismatch: ${actualExecutable || "unavailable"}`);
  }

  // NSRunningApplication.terminate() follows the normal AppKit termination
  // path, including applicationWillTerminate. A raw signal would not prove
  // that the shipping lifecycle hook stopped its app-owned child.
  if (!Boolean(ObjC.unwrap(application.terminate))) {
    fail(`process ${pid} rejected the termination request`);
  }

  return `requested normal AppKit termination for pid ${pid}`;
}
