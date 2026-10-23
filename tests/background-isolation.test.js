import { test, expect } from "@jest/globals";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { prepareBackground } from "../dist/work/background.js";
import { backgroundNetwork, publicAddress } from "../dist/work/background-network.js";
import { workSpec, providerArgs, executeProvider } from "../dist/work/provider.js";
import { CodexClient } from "../dist/harness/codex-client.js";

const exec = promisify(execFile);
test("background mode requires explicit model/effort and disables provider integrations", () => {
  expect(() =>
    workSpec.parse({ provider: "codex", workspace: "/tmp/project", prompt: "work", mode: "background-only" }),
  ).toThrow();
  for (const provider of ["codex", "claude"]) {
    const spec = workSpec.parse({
      provider,
      workspace: "/tmp/project",
      prompt: "work",
      mode: "background-only",
      model: "unchanged-model",
      effort: "high",
    });
    const args = providerArgs(spec);
    expect(args).toContain("unchanged-model");
    expect(args.join(" ")).toContain(provider === "codex" ? "mcp_servers={}" : "--strict-mcp-config");
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("--dangerously-skip-permissions");
  }
});

test("proxy refuses local, private and ambiguous addresses", async () => {
  for (const address of [
    "127.0.0.1",
    "10.0.0.1",
    "192.168.1.2",
    "172.16.0.1",
    "169.254.1.1",
    "100.64.1.1",
    "::1",
    "::ffff:127.0.0.1",
    "0.0.0.0",
  ])
    expect(publicAddress(address)).toBe(false);
  expect(publicAddress("1.1.1.1")).toBe(true);
  const proxy = await backgroundNetwork();
  try {
    const { stdout } = await exec(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `
      import net from 'node:net'; const s=net.connect(${proxy.port},'127.0.0.1',()=>s.write('CONNECT 127.0.0.1:443 HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\n\\r\\n'));
      s.on('data',b=>process.stdout.write(b)); s.on('end',()=>process.exit(0));
    `,
      ],
      { timeout: 5000 },
    );
    expect(stdout).toContain("403 Forbidden");
  } finally {
    proxy.close();
  }
});

const macTest = process.platform === "darwin" ? test : test.skip;
macTest(
  "Seatbelt survives child shells, denies host IPC and outside writes, permits project development",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "taxi-boundary-test-"));
    const project = join(root, "project");
    await mkdir(project);
    const guard = await prepareBackground(project, "codex");
    const server = createServer((socket) => socket.end("unguarded service"));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = server.address().port;
    const hostProcess = spawn("/bin/sleep", ["30"]);
    const run = (command, args) =>
      exec(guard.executable, [...guard.prefix, command, ...args], { cwd: project, env: guard.env, timeout: 10000 });
    try {
      await run("/bin/sh", ["-c", `printf ok > output.txt`]);
      expect(await readFile(join(project, "output.txt"), "utf8")).toBe("ok");
      await expect(run("/bin/sh", ["-c", `printf escape > '${join(root, "outside")}'`])).rejects.toThrow();
      await expect(
        run("/usr/bin/osascript", ["-e", 'tell application "System Events" to get count of processes']),
      ).rejects.toThrow();
      await expect(run("/usr/bin/osascript", ["-e", 'tell application "Finder" to activate'])).rejects.toThrow();
      await expect(run("/usr/bin/open", ["-a", "Finder"])).rejects.toThrow();
      await expect(run("/bin/kill", ["-TERM", String(hostProcess.pid)])).rejects.toThrow();
      expect(hostProcess.exitCode).toBeNull();
      await run("/bin/sh", ["-c", "sleep 20 & child=$!; kill $child; wait $child; exit 0"]);
      const native = await run("/usr/bin/osascript", [
        "-l",
        "JavaScript",
        "-e",
        'ObjC.import("AppKit"); Boolean($.NSWorkspace.sharedWorkspace.frontmostApplication.isNil())',
      ]);
      expect(native.stdout.trim()).toBe("true");
      await expect(
        run(process.execPath, ["-e", `require('net').connect(${port},'127.0.0.1').on('error',()=>process.exit(23))`]),
      ).rejects.toMatchObject({ code: 23 });
      // Unsetting the advisory environment does not remove the inherited kernel policy.
      await expect(
        run("/usr/bin/env", [
          "-i",
          "PATH=/usr/bin:/bin",
          "/bin/sh",
          "-c",
          `printf escape > '${join(root, "outside")}'`,
        ]),
      ).rejects.toThrow();
    } finally {
      hostProcess.kill();
      server.close();
      await guard.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);

macTest(
  "both provider launch routes apply the OS boundary before provider code runs",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "taxi-provider-boundary-"));
    const project = join(root, "project");
    const bin = join(root, "bin");
    await mkdir(project);
    await mkdir(bin);
    const original = process.env.PATH;
    const fixture = `#!${process.execPath}\nconst fs=require('fs'); let blocked=false;try{fs.writeFileSync(${JSON.stringify(join(root, "escape"))},'bad')}catch{blocked=true} fs.writeFileSync('result.txt',String(blocked));console.log(JSON.stringify({type:'result',result:'done',is_error:!blocked}));`;
    for (const name of ["codex", "claude"]) await writeFile(join(bin, name), fixture, { mode: 0o700 });
    process.env.PATH = `${bin}:${original}`;
    try {
      for (const provider of ["codex", "claude"]) {
        const result = await executeProvider({
          provider,
          workspace: project,
          prompt: "fixture",
          mode: "background-only",
          model: "test-only",
          effort: "high",
        });
        expect(result.outcome).toBe("returned");
        expect(result.isolation.preflight).toBe("passed");
        expect(await readFile(join(project, "result.txt"), "utf8")).toBe("true");
      }
    } finally {
      process.env.PATH = original;
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);

macTest(
  "native harness app-server inherits the same boundary in its state directory",
  async () => {
    // Production harness workspaces live below .taxi, which is valid only read-only.
    const root = await mkdtemp(join(process.env.HOME, ".taxi-harness-boundary-"));
    const home = join(root, "codex");
    const project = join(root, "workspace");
    await mkdir(home);
    await mkdir(project);
    const binary = join(root, "fixture");
    await writeFile(
      binary,
      `#!${process.execPath}\nconst fs=require('fs'); const cp=require('child_process');
    let blocked=false;try{fs.writeFileSync(${JSON.stringify(join(project, "escape"))},'bad')}catch{blocked=true}
    const gui=cp.spawnSync('/usr/bin/osascript',['-e','tell application "Finder" to activate']).status;
    fs.writeFileSync(process.env.CODEX_HOME+'/boundary.json',JSON.stringify({blocked,gui}));
    require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line); if(m.id) console.log(JSON.stringify({id:m.id,result:{}}))});
  `,
      { mode: 0o700 },
    );
    const original = process.env.TAXI_CODEX_BINARY;
    process.env.TAXI_CODEX_BINARY = binary;
    const client = new CodexClient(home, project);
    try {
      await client.start();
      const result = JSON.parse(await readFile(join(home, "boundary.json"), "utf8"));
      expect(result.blocked).toBe(true);
      expect(result.gui).not.toBe(0);
    } finally {
      client.close();
      if (original === undefined) delete process.env.TAXI_CODEX_BINARY;
      else process.env.TAXI_CODEX_BINARY = original;
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
