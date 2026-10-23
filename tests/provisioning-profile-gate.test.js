import { describe, expect, test } from "@jest/globals";
import {
  assertDeveloperIdProvisioningProfile,
  assertSignedProvisioningContract,
  codesignCertificateExtractionArguments,
} from "../scripts/verify-provisioning-profile.mjs";

const expected = {
  bundleIdentifier: "app.taxi",
  teamIdentifier: "XS7HJJN7GC",
  appGroup: "group.app.taxi",
};
const certificateSha256 = "a".repeat(64);
const verificationTime = new Date("2026-09-05T00:00:00Z");

function profile(overrides = {}) {
  return {
    name: "Taxi Developer ID",
    uuid: "12345678-1234-1234-1234-1234567890AB",
    creationDate: "2026-09-01T00:00:00Z",
    expirationDate: "2038-09-01T00:00:00Z",
    platforms: ["OSX"],
    teamIdentifiers: [expected.teamIdentifier],
    applicationIdentifierPrefixes: [expected.teamIdentifier],
    provisionsAllDevices: true,
    hasProvisionedDevices: false,
    betaReportsActive: undefined,
    entitlements: {
      applicationIdentifier: `${expected.teamIdentifier}.${expected.bundleIdentifier}`,
      teamIdentifier: expected.teamIdentifier,
      appGroups: [expected.appGroup],
      getTaskAllow: false,
    },
    developerCertificates: [
      {
        commonName: `Developer ID Application: Heznpc (${expected.teamIdentifier})`,
        organizationUnit: expected.teamIdentifier,
        hasDeveloperIdApplicationExtension: true,
        sha256: certificateSha256,
      },
    ],
    ...overrides,
  };
}

function signed(overrides = {}) {
  return {
    bundleIdentifier: expected.bundleIdentifier,
    applicationIdentifier: `${expected.teamIdentifier}.${expected.bundleIdentifier}`,
    teamIdentifier: expected.teamIdentifier,
    appGroups: [expected.appGroup],
    hasGetTaskAllow: false,
    signingCertificateSha256: certificateSha256,
    ...overrides,
  };
}

describe("Developer ID provisioning profile gate", () => {
  test("passes the certificate output prefix as the codesign option value", () => {
    expect(codesignCertificateExtractionArguments("/tmp/certificate-", "/Applications/Taxi.app")).toEqual([
      "-d",
      "--extract-certificates=/tmp/certificate-",
      "/Applications/Taxi.app",
    ]);
  });

  test("accepts an unexpired all-devices Taxi profile and Apple's team wildcard", () => {
    expect(assertDeveloperIdProvisioningProfile(profile(), expected, verificationTime)).toBe(true);
    expect(
      assertDeveloperIdProvisioningProfile(
        profile({
          entitlements: {
            ...profile().entitlements,
            appGroups: [expected.appGroup, `${expected.teamIdentifier}.*`],
            getTaskAllow: undefined,
          },
        }),
        expected,
        verificationTime,
      ),
    ).toBe(true);
  });

  test.each([
    ["expired", { expirationDate: "2026-09-04T23:59:59Z" }, /expired/],
    ["not yet valid", { creationDate: "2026-09-06T00:00:00Z" }, /not valid yet/],
    ["wrong platform", { platforms: ["iOS"] }, /platform/],
    ["wrong team", { teamIdentifiers: ["AAAAAAAAAA"] }, /TeamIdentifier/],
    ["wrong prefix", { applicationIdentifierPrefixes: ["AAAAAAAAAA"] }, /App ID prefix/],
    ["development", { provisionsAllDevices: false, hasProvisionedDevices: true }, /all-devices/],
    ["App Store", { provisionsAllDevices: false, betaReportsActive: true }, /all-devices/],
    ["device list", { hasProvisionedDevices: true }, /all-devices/],
  ])("rejects a %s profile", (_label, override, expectedError) => {
    expect(() => assertDeveloperIdProvisioningProfile(profile(override), expected, verificationTime)).toThrow(
      expectedError,
    );
  });

  test.each([
    [
      "wildcard application identifier",
      { applicationIdentifier: `${expected.teamIdentifier}.app.*` },
      /exact Taxi App ID/,
    ],
    ["wrong entitlement team", { teamIdentifier: "AAAAAAAAAA" }, /Taxi team/],
    ["unauthorized app group", { appGroups: [expected.appGroup, "group.attacker"] }, /application-groups/],
    ["missing Taxi app group", { appGroups: [`${expected.teamIdentifier}.*`] }, /application-groups/],
    ["debug permission", { getTaskAllow: true }, /must not enable debugging/],
  ])("rejects profile entitlements with %s", (_label, entitlements, expectedError) => {
    expect(() =>
      assertDeveloperIdProvisioningProfile(
        profile({ entitlements: { ...profile().entitlements, ...entitlements } }),
        expected,
        verificationTime,
      ),
    ).toThrow(expectedError);
  });

  test("rejects non-Developer-ID and ambiguous profile certificates", () => {
    const developmentCertificate = {
      ...profile().developerCertificates[0],
      commonName: `Apple Development: Heznpc (${expected.teamIdentifier})`,
      hasDeveloperIdApplicationExtension: false,
    };
    expect(() =>
      assertDeveloperIdProvisioningProfile(
        profile({ developerCertificates: [developmentCertificate] }),
        expected,
        verificationTime,
      ),
    ).toThrow(/Developer ID Application/);
    expect(() =>
      assertDeveloperIdProvisioningProfile(
        profile({ developerCertificates: [profile().developerCertificates[0], profile().developerCertificates[0]] }),
        expected,
        verificationTime,
      ),
    ).toThrow(/exactly one signing certificate/);
  });

  test("binds final code-sign entitlements and leaf certificate to the embedded profile", () => {
    const validProfile = profile();
    expect(assertSignedProvisioningContract(signed(), validProfile, expected)).toBe(true);
    expect(() =>
      assertSignedProvisioningContract(
        signed({ applicationIdentifier: `${expected.teamIdentifier}.app.attacker` }),
        validProfile,
        expected,
      ),
    ).toThrow(/exact Taxi App ID/);
    expect(() =>
      assertSignedProvisioningContract(
        signed({ appGroups: [expected.appGroup, "group.attacker"] }),
        validProfile,
        expected,
      ),
    ).toThrow(/application-groups/);
    expect(() => assertSignedProvisioningContract(signed({ hasGetTaskAllow: true }), validProfile, expected)).toThrow(
      /must omit/,
    );
    expect(() =>
      assertSignedProvisioningContract(signed({ signingCertificateSha256: "b".repeat(64) }), validProfile, expected),
    ).toThrow(/certificate authorized/);
  });
});
