#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAC_APP_IDENTIFIER_KEY = "com.apple.application-identifier";
const TEAM_IDENTIFIER_KEY = "com.apple.developer.team-identifier";
const APP_GROUPS_KEY = "com.apple.security.application-groups";
const GET_TASK_ALLOW_KEY = "com.apple.security.get-task-allow";
const DEVELOPER_ID_APPLICATION_OID = "1.2.840.113635.100.6.1.13";

function fail(message) {
  throw new Error(message);
}

function exactArray(actual, expected, label) {
  if (!Array.isArray(actual) || actual.length !== expected.length) {
    fail(`${label} must contain exactly ${expected.join(", ")}`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) fail(`${label} must contain exactly ${expected.join(", ")}`);
  }
}

function validDate(value, label) {
  const parsed = new Date(value);
  if (typeof value !== "string" || !Number.isFinite(parsed.getTime())) fail(`${label} is missing or invalid`);
  return parsed;
}

function assertProfileAppGroups(actual, expected) {
  const allowed = new Set([expected.appGroup, `${expected.teamIdentifier}.*`]);
  if (
    !Array.isArray(actual) ||
    !actual.includes(expected.appGroup) ||
    new Set(actual).size !== actual.length ||
    actual.some((value) => !allowed.has(value))
  ) {
    fail(`profile ${APP_GROUPS_KEY} must authorize Taxi and may contain only the Apple team wildcard`);
  }
}

export function assertDeveloperIdProvisioningProfile(profile, expected, now = new Date()) {
  const expectedApplicationIdentifier = `${expected.teamIdentifier}.${expected.bundleIdentifier}`;
  if (!profile || typeof profile !== "object") fail("decoded provisioning profile is invalid");
  if (typeof profile.name !== "string" || profile.name.trim() === "") fail("profile name is missing");
  if (typeof profile.uuid !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(profile.uuid)) {
    fail("profile UUID is missing or invalid");
  }

  const creationDate = validDate(profile.creationDate, "profile creation date");
  const expirationDate = validDate(profile.expirationDate, "profile expiration date");
  if (!Number.isFinite(now.getTime())) fail("verification time is invalid");
  if (creationDate.getTime() > now.getTime()) fail("profile is not valid yet");
  if (expirationDate.getTime() <= now.getTime()) fail("profile is expired");
  if (expirationDate.getTime() <= creationDate.getTime()) fail("profile validity interval is invalid");

  exactArray(profile.platforms, ["OSX"], "profile platform");
  exactArray(profile.teamIdentifiers, [expected.teamIdentifier], "profile TeamIdentifier");
  exactArray(profile.applicationIdentifierPrefixes, [expected.teamIdentifier], "profile App ID prefix");
  if (profile.provisionsAllDevices !== true || profile.hasProvisionedDevices !== false) {
    fail("profile is not a Developer ID all-devices distribution profile");
  }
  if (profile.betaReportsActive === true) fail("profile is an App Store/TestFlight profile, not Developer ID");

  const entitlements = profile.entitlements;
  if (!entitlements || typeof entitlements !== "object") fail("profile entitlements are missing");
  if (entitlements.applicationIdentifier !== expectedApplicationIdentifier) {
    fail(`profile ${MAC_APP_IDENTIFIER_KEY} does not match the exact Taxi App ID`);
  }
  if (entitlements.teamIdentifier !== expected.teamIdentifier) {
    fail(`profile ${TEAM_IDENTIFIER_KEY} does not match the Taxi team`);
  }
  assertProfileAppGroups(entitlements.appGroups, expected);
  if (entitlements.getTaskAllow === true) fail(`profile ${GET_TASK_ALLOW_KEY} must not enable debugging`);

  if (!Array.isArray(profile.developerCertificates) || profile.developerCertificates.length !== 1) {
    fail("Developer ID distribution profile must contain exactly one signing certificate");
  }
  const [certificate] = profile.developerCertificates;
  if (
    certificate?.organizationUnit !== expected.teamIdentifier ||
    typeof certificate?.commonName !== "string" ||
    !certificate.commonName.startsWith("Developer ID Application: ") ||
    !certificate.commonName.endsWith(` (${expected.teamIdentifier})`) ||
    certificate.hasDeveloperIdApplicationExtension !== true ||
    !/^[0-9a-f]{64}$/.test(certificate.sha256 ?? "")
  ) {
    fail("profile certificate is not a Developer ID Application certificate for the Taxi team");
  }
  return true;
}

export function assertSignedProvisioningContract(signed, profile, expected) {
  const expectedApplicationIdentifier = `${expected.teamIdentifier}.${expected.bundleIdentifier}`;
  if (!signed || typeof signed !== "object") fail("signed entitlements are invalid");
  if (signed.bundleIdentifier !== expected.bundleIdentifier)
    fail("signed bundle identifier is not the expected Taxi ID");
  if (signed.applicationIdentifier !== expectedApplicationIdentifier) {
    fail(`signed ${MAC_APP_IDENTIFIER_KEY} does not match the exact Taxi App ID`);
  }
  if (signed.teamIdentifier !== expected.teamIdentifier) {
    fail(`signed ${TEAM_IDENTIFIER_KEY} does not match the Taxi team`);
  }
  exactArray(signed.appGroups, [expected.appGroup], `signed ${APP_GROUPS_KEY}`);
  if (signed.hasGetTaskAllow) fail(`signed code must omit ${GET_TASK_ALLOW_KEY}`);
  if (signed.signingCertificateSha256 !== profile.developerCertificates[0].sha256) {
    fail("signed code certificate is not the certificate authorized by its embedded profile");
  }
  return true;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
  if (result.status !== 0) fail(options.errorMessage ?? `${command} failed`);
  return result.stdout;
}

function assertRegularFile(path, label) {
  if (!existsSync(path)) fail(`${label} is missing`);
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail(`${label} could not be inspected`);
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size === 0) fail(`${label} must be a non-empty regular file`);
}

function plistValue(path, keyPath, type) {
  return run("/usr/bin/plutil", ["-extract", keyPath, "raw", "-expect", type, "-o", "-", path], {
    errorMessage: `profile field ${keyPath} is missing or invalid`,
  }).trim();
}

function plistHas(path, keyPath) {
  return (
    spawnSync("/usr/bin/plutil", ["-type", keyPath, path], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
    }).status === 0
  );
}

function plistBoolean(path, keyPath) {
  return plistValue(path, keyPath, "bool") === "true";
}

function plistArray(path, keyPath, itemType) {
  const countText = plistValue(path, keyPath, "array");
  if (!/^(?:0|[1-9][0-9]*)$/.test(countText)) fail(`profile field ${keyPath} has an invalid array count`);
  return Array.from({ length: Number(countText) }, (_unused, index) =>
    plistValue(path, `${keyPath}.${index}`, itemType),
  );
}

function strictBase64(value, label) {
  const compact = value.replace(/\s/g, "");
  if (compact.length === 0 || compact.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(compact)) {
    fail(`${label} is not valid base64 DER data`);
  }
  const bytes = Buffer.from(compact, "base64");
  if (bytes.length === 0 || bytes.toString("base64") !== compact) fail(`${label} is not canonical DER data`);
  return bytes;
}

function certificateField(subject, field) {
  const expression = new RegExp(`^[ \\t]*${field}[ \\t]*=[ \\t]*(.+)$`, "m");
  return subject.match(expression)?.[1]?.trim() ?? "";
}

function inspectDeveloperCertificate(base64, index) {
  const certificate = strictBase64(base64, `DeveloperCertificates.${index}`);
  const subject = run("/usr/bin/openssl", ["x509", "-inform", "DER", "-noout", "-subject", "-nameopt", "multiline"], {
    input: certificate,
    errorMessage: `DeveloperCertificates.${index} is not an X.509 certificate`,
  });
  const text = run("/usr/bin/openssl", ["x509", "-inform", "DER", "-noout", "-text"], {
    input: certificate,
    errorMessage: `DeveloperCertificates.${index} could not be inspected`,
  });
  return {
    commonName: certificateField(subject, "commonName"),
    organizationUnit: certificateField(subject, "organizationalUnitName"),
    hasDeveloperIdApplicationExtension: text.includes(DEVELOPER_ID_APPLICATION_OID),
    sha256: createHash("sha256").update(certificate).digest("hex"),
  };
}

export function codesignCertificateExtractionArguments(certificatePrefix, bundlePath) {
  return ["-d", `--extract-certificates=${certificatePrefix}`, bundlePath];
}

function readDecodedProfile(decodedPath) {
  run("/usr/bin/plutil", ["-lint", decodedPath], { errorMessage: "decoded provisioning profile is not a plist" });
  const developerCertificateData = plistArray(decodedPath, "DeveloperCertificates", "data");
  const getTaskAllowPath = `Entitlements.com\\.apple\\.security\\.get-task-allow`;
  return {
    name: plistValue(decodedPath, "Name", "string"),
    uuid: plistValue(decodedPath, "UUID", "string"),
    creationDate: plistValue(decodedPath, "CreationDate", "date"),
    expirationDate: plistValue(decodedPath, "ExpirationDate", "date"),
    platforms: plistArray(decodedPath, "Platform", "string"),
    teamIdentifiers: plistArray(decodedPath, "TeamIdentifier", "string"),
    applicationIdentifierPrefixes: plistArray(decodedPath, "ApplicationIdentifierPrefix", "string"),
    provisionsAllDevices: plistBoolean(decodedPath, "ProvisionsAllDevices"),
    hasProvisionedDevices: plistHas(decodedPath, "ProvisionedDevices"),
    betaReportsActive: plistHas(decodedPath, "Entitlements.beta-reports-active")
      ? plistBoolean(decodedPath, "Entitlements.beta-reports-active")
      : undefined,
    entitlements: {
      applicationIdentifier: plistValue(decodedPath, `Entitlements.com\\.apple\\.application-identifier`, "string"),
      teamIdentifier: plistValue(decodedPath, `Entitlements.com\\.apple\\.developer\\.team-identifier`, "string"),
      appGroups: plistArray(decodedPath, `Entitlements.com\\.apple\\.security\\.application-groups`, "string"),
      getTaskAllow: plistHas(decodedPath, getTaskAllowPath) ? plistBoolean(decodedPath, getTaskAllowPath) : undefined,
    },
    developerCertificates: developerCertificateData.map(inspectDeveloperCertificate),
  };
}

function decodeProfile(profilePath, directory) {
  assertRegularFile(profilePath, "provisioning profile");
  const decodedPath = join(directory, "profile.plist");
  run("/usr/bin/security", ["cms", "-D", "-i", profilePath, "-o", decodedPath], {
    errorMessage: "provisioning profile CMS decoding failed",
  });
  assertRegularFile(decodedPath, "decoded provisioning profile");
  return readDecodedProfile(decodedPath);
}

function readSignedBundle(bundlePath, directory) {
  const infoPath = join(bundlePath, "Contents", "Info.plist");
  assertRegularFile(infoPath, "signed bundle Info.plist");
  const entitlementsPath = join(directory, "signed-entitlements.plist");
  run("/usr/bin/codesign", ["-d", "--entitlements", entitlementsPath, "--xml", bundlePath], {
    errorMessage: "signed bundle entitlements could not be extracted",
  });
  assertRegularFile(entitlementsPath, "signed bundle entitlements");
  run("/usr/bin/plutil", ["-lint", entitlementsPath], { errorMessage: "signed bundle entitlements are invalid" });

  const certificatePrefix = join(directory, "signing-certificate-");
  run("/usr/bin/codesign", codesignCertificateExtractionArguments(certificatePrefix, bundlePath), {
    errorMessage: "signed bundle certificate could not be extracted",
  });
  const leafCertificatePath = `${certificatePrefix}0`;
  assertRegularFile(leafCertificatePath, "signed bundle leaf certificate");
  const appIdentifierPath = "com\\.apple\\.application-identifier";
  const teamIdentifierPath = "com\\.apple\\.developer\\.team-identifier";
  const appGroupsPath = "com\\.apple\\.security\\.application-groups";
  const getTaskAllowPath = "com\\.apple\\.security\\.get-task-allow";
  return {
    bundleIdentifier: plistValue(infoPath, "CFBundleIdentifier", "string"),
    applicationIdentifier: plistValue(entitlementsPath, appIdentifierPath, "string"),
    teamIdentifier: plistValue(entitlementsPath, teamIdentifierPath, "string"),
    appGroups: plistArray(entitlementsPath, appGroupsPath, "string"),
    hasGetTaskAllow: plistHas(entitlementsPath, getTaskAllowPath),
    signingCertificateSha256: createHash("sha256").update(readFileSync(leafCertificatePath)).digest("hex"),
  };
}

function argument(name) {
  const inline = process.argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? (process.argv[index + 1] ?? "") : "";
}

async function main() {
  const bundlePath = argument("--bundle");
  const explicitProfilePath = argument("--profile");
  const expected = {
    bundleIdentifier: argument("--expected-bundle-id"),
    teamIdentifier: argument("--expected-team-id"),
    appGroup: argument("--expected-app-group"),
  };
  if ((bundlePath === "") === (explicitProfilePath === "")) fail("supply exactly one of --bundle or --profile");
  if (!/^[A-Za-z0-9.-]+$/.test(expected.bundleIdentifier)) fail("--expected-bundle-id is required");
  if (!/^[A-Z0-9]{10}$/.test(expected.teamIdentifier)) fail("--expected-team-id is required");
  if (!/^group\.[A-Za-z0-9.-]+$/.test(expected.appGroup)) fail("--expected-app-group is required");

  const directory = mkdtempSync(join(tmpdir(), "taxi-profile-verification-"));
  try {
    const profilePath = explicitProfilePath || join(bundlePath, "Contents", "embedded.provisionprofile");
    const profile = decodeProfile(profilePath, directory);
    assertDeveloperIdProvisioningProfile(profile, expected);
    if (bundlePath) {
      const signed = readSignedBundle(bundlePath, directory);
      assertSignedProvisioningContract(signed, profile, expected);
    }
    console.log(`ok: Developer ID provisioning contract verified for ${expected.bundleIdentifier}`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`provisioning-profile: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
