#!/usr/bin/env node

import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  FULL_SURFACE_CANARY_TOOLS,
  FULL_SURFACE_MIN_TOOLS,
  probeAppRuntime,
  verifyRuntimeIdentityChallenge,
} from "./probe-app-runtime.mjs";

const execFileAsync = promisify(execFile);
const RELEASE_SOAK_SECONDS = 60 * 60;
const MINIMUM_SAMPLE_COVERAGE = 0.9;

function usage() {
  return [
    "Usage: node scripts/soak-app-runtime.mjs --url <mcp-url> --owner-secret-file <path>",
    "       --expected-version <version> --app-pid <pid> --app-command <absolute-path>",
    "       --app-birth <ps-lstart> --runtime-pid <pid>",
    "       [--duration-seconds 3600] [--interval-seconds 5]",
    "       [--mcp-interval-seconds 60] [--max-sustained-cpu 80]",
    "       [--max-high-cpu-seconds 60] [--allow-short-soak]",
    "",
    "The release gate requires at least one hour. --allow-short-soak exists only",
    "to test the harness itself and is reported as a non-release smoke run.",
  ].join("\n");
}

function positiveNumber(value, option) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${option} must be positive`);
  return parsed;
}

function positiveInteger(value, option) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 2) throw new Error(`${option} must be a process id`);
  return parsed;
}

export function parseArgs(argv) {
  const options = {
    url: "",
    ownerSecretFile: "",
    expectedVersion: "",
    appPid: 0,
    appCommand: "",
    appBirth: "",
    runtimePid: 0,
    durationSeconds: RELEASE_SOAK_SECONDS,
    intervalSeconds: 5,
    mcpIntervalSeconds: 60,
    maxSustainedCpu: 80,
    maxHighCpuSeconds: 60,
    allowShortSoak: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help" || option === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (option === "--allow-short-soak") {
      options.allowShortSoak = true;
      continue;
    }
    const value = argv[++index];
    if (value === undefined) throw new Error(`${option} requires a value`);
    switch (option) {
      case "--url":
        options.url = value;
        break;
      case "--owner-secret-file":
        options.ownerSecretFile = value;
        break;
      case "--expected-version":
        options.expectedVersion = value;
        break;
      case "--app-pid":
        options.appPid = positiveInteger(value, option);
        break;
      case "--runtime-pid":
        options.runtimePid = positiveInteger(value, option);
        break;
      case "--app-command":
        options.appCommand = value;
        break;
      case "--app-birth":
        options.appBirth = value;
        break;
      case "--duration-seconds":
        options.durationSeconds = positiveNumber(value, option);
        break;
      case "--interval-seconds":
        options.intervalSeconds = positiveNumber(value, option);
        break;
      case "--mcp-interval-seconds":
        options.mcpIntervalSeconds = positiveNumber(value, option);
        break;
      case "--max-sustained-cpu":
        options.maxSustainedCpu = positiveNumber(value, option);
        break;
      case "--max-high-cpu-seconds":
        options.maxHighCpuSeconds = positiveNumber(value, option);
        break;
      default:
        throw new Error(`unknown option: ${option}`);
    }
  }

  if (!options.url || !options.ownerSecretFile || !options.expectedVersion) {
    throw new Error("--url, --owner-secret-file, and --expected-version are required");
  }
  if (!options.appPid || !options.runtimePid) {
    throw new Error("--app-pid and --runtime-pid are required");
  }
  if (!options.appCommand.startsWith("/") || /[\r\n\0]/.test(options.appCommand)) {
    throw new Error("--app-command must be an absolute single-line executable path");
  }
  if (!options.appBirth.trim() || /[\r\n\0]/.test(options.appBirth)) {
    throw new Error("--app-birth must be a single-line process birth identity");
  }
  if (options.durationSeconds < RELEASE_SOAK_SECONDS && !options.allowShortSoak) {
    throw new Error("release soak duration must be at least 3600 seconds");
  }
  if (options.intervalSeconds > options.maxHighCpuSeconds) {
    throw new Error("--interval-seconds cannot exceed --max-high-cpu-seconds");
  }
  return options;
}

function assertAlive(pid, label) {
  try {
    process.kill(pid, 0);
  } catch (error) {
    throw new Error(`${label} pid ${pid} exited during soak`, { cause: error });
  }
}

async function readProcessSample(pid) {
  const { stdout } = await execFileAsync("/bin/ps", ["-p", String(pid), "-o", "%cpu=,rss=,etime="]);
  const match = stdout.trim().match(/^([0-9.]+)\s+(\d+)\s+(.+)$/);
  if (!match) throw new Error(`could not sample runtime pid ${pid}`);
  return { cpu: Number(match[1]), rssKiB: Number(match[2]), elapsed: match[3].trim() };
}

async function readPsField(pid, field) {
  const { stdout } = await execFileAsync("/bin/ps", ["-p", String(pid), "-o", `${field}=`], {
    env: { ...process.env, LC_ALL: "C" },
  });
  const value = stdout.replace(/[\r\n]+$/, "");
  if (!value.trim()) throw new Error(`could not read ${field} for Taxi app pid ${pid}`);
  return value;
}

export async function assertAppProcessGeneration(options) {
  // Capture birth -> command -> birth in one bounded sequence. Matching both
  // birth reads closes the PID-reuse window around the command observation.
  const birthBefore = await readPsField(options.appPid, "lstart");
  const command = await readPsField(options.appPid, "command");
  const birthAfter = await readPsField(options.appPid, "lstart");
  if (birthBefore !== options.appBirth || birthAfter !== options.appBirth) {
    throw new Error(`Taxi app pid ${options.appPid} no longer has the attested birth identity`);
  }
  if (command !== options.appCommand && !command.startsWith(`${options.appCommand} `)) {
    throw new Error(`Taxi app pid ${options.appPid} no longer matches the attested executable command`);
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export function minimumObservationSamples(durationSeconds, intervalSeconds) {
  return Math.max(2, Math.floor((durationSeconds / intervalSeconds) * MINIMUM_SAMPLE_COVERAGE));
}

export function maximumObservationGapMilliseconds(intervalSeconds) {
  return Math.max(15_000, intervalSeconds * 3_000);
}

export async function runSoak(options) {
  const startedAt = performance.now();
  const deadline = startedAt + options.durationSeconds * 1_000;
  const maximumGapMs = maximumObservationGapMilliseconds(options.intervalSeconds);
  const minimumSamples = minimumObservationSamples(options.durationSeconds, options.intervalSeconds);
  let nextMcpProbeAt = startedAt;
  let previousObservationAt;
  let samples = 0;
  let mcpProbes = 0;
  let highCpuStartedAt;
  let maxCpu = 0;
  let maxRssKiB = 0;
  let firstRssKiB = 0;
  let lastRssKiB = 0;

  async function observeRuntime(observationAt, forceMcp = false) {
    if (previousObservationAt !== undefined && observationAt - previousObservationAt > maximumGapMs) {
      throw new Error(
        `runtime observation gap ${(observationAt - previousObservationAt).toFixed(0)}ms exceeded ${maximumGapMs}ms`,
      );
    }
    previousObservationAt = observationAt;
    await assertAppProcessGeneration(options);
    assertAlive(options.runtimePid, "app-owned runtime");

    const receipt = await verifyRuntimeIdentityChallenge({
      url: options.url,
      ownerSecretFile: options.ownerSecretFile,
      expectedVersion: options.expectedVersion,
      timeoutMs: Math.max(2_000, options.intervalSeconds * 1_000 * 0.8),
    });
    if (receipt.challenge.pid !== options.runtimePid) {
      throw new Error(
        `listener generation changed during soak: expected ${options.runtimePid}, got ${receipt.challenge.pid}`,
      );
    }

    if (forceMcp || observationAt >= nextMcpProbeAt) {
      await probeAppRuntime({
        url: options.url,
        ownerSecretFile: options.ownerSecretFile,
        expectedVersion: options.expectedVersion,
        timeoutMs: 10_000,
        minTools: FULL_SURFACE_MIN_TOOLS,
        requiredTools: FULL_SURFACE_CANARY_TOOLS,
        clientName: "taxi-runtime-soak",
      });
      mcpProbes += 1;
      nextMcpProbeAt = observationAt + options.mcpIntervalSeconds * 1_000;
    }

    const sample = await readProcessSample(options.runtimePid);
    samples += 1;
    if (samples === 1) firstRssKiB = sample.rssKiB;
    lastRssKiB = sample.rssKiB;
    maxCpu = Math.max(maxCpu, sample.cpu);
    maxRssKiB = Math.max(maxRssKiB, sample.rssKiB);

    if (sample.cpu >= options.maxSustainedCpu) {
      highCpuStartedAt ??= observationAt;
      const highCpuSeconds = (observationAt - highCpuStartedAt) / 1_000;
      if (highCpuSeconds >= options.maxHighCpuSeconds) {
        throw new Error(
          `runtime CPU stayed at or above ${options.maxSustainedCpu}% for ${highCpuSeconds.toFixed(1)} seconds`,
        );
      }
    } else {
      highCpuStartedAt = undefined;
    }
  }

  while (performance.now() < deadline) {
    const iterationStartedAt = performance.now();
    await observeRuntime(iterationStartedAt);

    const nextObservationAt = iterationStartedAt + options.intervalSeconds * 1_000;
    const remaining = Math.min(deadline, nextObservationAt) - performance.now();
    if (remaining > 0) {
      await sleep(remaining);
    }
  }

  // A wall-clock deadline alone is not evidence. Take a final generation/MCP
  // observation and reject host sleep, VM pause, or event-loop stalls that
  // skipped the intended sample coverage.
  await observeRuntime(performance.now(), true);
  const observedDurationSeconds = (performance.now() - startedAt) / 1_000;
  if (observedDurationSeconds < options.durationSeconds) {
    throw new Error(`runtime soak ended early after ${observedDurationSeconds.toFixed(3)} seconds`);
  }
  if (samples < minimumSamples) {
    throw new Error(`runtime soak collected ${samples} samples; expected at least ${minimumSamples}`);
  }

  return {
    releaseQualified:
      options.durationSeconds >= RELEASE_SOAK_SECONDS &&
      observedDurationSeconds >= RELEASE_SOAK_SECONDS &&
      samples >= minimumSamples,
    durationSeconds: observedDurationSeconds,
    samples,
    minimumSamples,
    mcpProbes,
    maximumObservationGapMilliseconds: maximumGapMs,
    maxCpuPercent: maxCpu,
    firstRssKiB,
    lastRssKiB,
    maxRssKiB,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await runSoak(options);
  console.log(JSON.stringify(result));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
