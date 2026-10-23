#!/bin/bash
# Codesign + notarize + staple Taxi.app for release-quality distribution
# outside the App Store. Turns an ad-hoc-signed bundle from
# scripts/bundle-app.sh into something Gatekeeper accepts on a fresh Mac
# without a right-click-Open override.
#
# Required environment (set in GitHub Actions secrets for the CD workflow):
#   APPLE_DEVELOPER_ID          — Developer ID Application certificate
#                                 common name, e.g. "Developer ID Application:
#                                 Heznpc (TEAMID)"
#   TAXI_APP_PROVISIONING_PROFILE_PATH
#                               — Developer ID profile for app.taxi
#   TAXI_WIDGET_PROVISIONING_PROFILE_PATH
#                               — Developer ID profile for app.taxi.Widget
#
# Notarization credentials — supply exactly ONE of the two sets below.
# They are tried in this order, most robust first:
#
#   1. App Store Connect API key (preferred; no 2FA, one key for the whole team)
#      APPLE_API_KEY_PATH       — path to AuthKey_<KEYID>.p8
#      APPLE_API_KEY_ID         — 10-char key ID
#      APPLE_API_ISSUER_ID      — issuer UUID
#
#   2. Stored keychain profile (preferred for local runs; defaults to AC_API)
#      NOTARY_KEYCHAIN_PROFILE  — profile name saved by
#                                 `xcrun notarytool store-credentials`
#
# Optional environment:
#   APP_BUNDLE_PATH             — default: Taxi.app (relative to repo root)
#   SKIP_NOTARIZATION=1         — codesign + staple only; useful for local
#                                 smoke tests when notarytool credentials
#                                 aren't available.
#   TAXI_SIGNED_VERIFICATION_OUTPUT
#                               — write a private machine-readable proof only
#                                 after the signed lifecycle gate and the
#                                 post-runtime static verification both pass.
#
# Usage:
#   bash scripts/notarize-app.sh
#   SKIP_NOTARIZATION=1 bash scripts/notarize-app.sh  # sign only, no net
#
# Outputs (when notarization succeeds):
#   Taxi.app — re-signed with Developer ID + stapled notarization ticket
#
# Exit codes:
#   0  success
#   1  missing env / bundle / signing failure
#   2  notarization rejected by Apple

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
APP_BUNDLE="${APP_BUNDLE_PATH:-$PROJECT_DIR/Taxi.app}"
# shellcheck source=scripts/lib/signing-identity.sh
source "$SCRIPT_DIR/lib/signing-identity.sh"

# ── Preconditions ────────────────────────────────────────────────────
if [ ! -d "$APP_BUNDLE" ]; then
  echo "notarize-app: app bundle not found — run scripts/bundle-app.sh first" >&2
  exit 1
fi
if /usr/libexec/PlistBuddy -c "Print :TaxiAcceptanceHarnessBuild" \
  "$APP_BUNDLE/Contents/Info.plist" >/dev/null 2>&1; then
  echo "notarize-app: refusing to sign an acceptance-harness build; run scripts/bundle-app.sh bundle" >&2
  exit 1
fi

need_var() {
  if [ -z "${!1:-}" ]; then
    echo "notarize-app: required env var $1 is unset" >&2
    exit 1
  fi
}
need_var APPLE_DEVELOPER_ID
need_var TAXI_APP_PROVISIONING_PROFILE_PATH
need_var TAXI_WIDGET_PROVISIONING_PROFILE_PATH

# ── Resolve notarytool credentials ───────────────────────────────────
# Built once here so `submit` and the failure-path `log` call can never
# authenticate two different ways. NOTARY_AUTH_KIND drives the diagnostics
# printed when Apple refuses the credentials outright.
NOTARY_AUTH=()
NOTARY_AUTH_KIND=""
if [ "${SKIP_NOTARIZATION:-}" != "1" ]; then
  if [ -n "${APPLE_API_KEY_PATH:-}" ] || [ -n "${APPLE_API_KEY_ID:-}" ] || [ -n "${APPLE_API_ISSUER_ID:-}" ]; then
    need_var APPLE_API_KEY_PATH
    need_var APPLE_API_KEY_ID
    need_var APPLE_API_ISSUER_ID
    if [ ! -f "$APPLE_API_KEY_PATH" ]; then
      echo "notarize-app: APPLE_API_KEY_PATH points at no file" >&2
      exit 1
    fi
    NOTARY_AUTH=(--key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY_ID" --issuer "$APPLE_API_ISSUER_ID")
    NOTARY_AUTH_KIND="api-key"
  else
    NOTARY_KEYCHAIN_PROFILE="${NOTARY_KEYCHAIN_PROFILE:-AC_API}"
    NOTARY_AUTH=(--keychain-profile "$NOTARY_KEYCHAIN_PROFILE")
    NOTARY_AUTH_KIND="keychain-profile"
  fi
fi

# The certificate subject is public in every distributed binary. Refuse to
# sign before both the configured identity and the installed certificate prove
# that the certificate is a Developer ID Application identity for Taxi's team.
TAXI_SIGNING_KEYCHAIN="${TAXI_SIGNING_KEYCHAIN:-}" \
  bash "$SCRIPT_DIR/verify-signing-identity.sh"

PROFILE_VERIFIER="$SCRIPT_DIR/verify-provisioning-profile.mjs"
TAXI_APP_BUNDLE_ID="app.taxi"
TAXI_WIDGET_BUNDLE_ID="app.taxi.Widget"
TAXI_APP_GROUP="group.app.taxi"
WIDGET_APPEX="$APP_BUNDLE/Contents/PlugIns/TaxiWidget.appex"
if [ ! -f "$PROFILE_VERIFIER" ] || [ ! -d "$WIDGET_APPEX" ]; then
  echo "notarize-app: provisioning verifier or required TaxiWidget.appex is missing" >&2
  exit 1
fi

verify_profile_source() {
  local profile_path="$1"
  local bundle_id="$2"
  node "$PROFILE_VERIFIER" \
    --profile="$profile_path" \
    --expected-bundle-id="$bundle_id" \
    --expected-team-id="$TAXI_SIGNING_TEAM_ID" \
    --expected-app-group="$TAXI_APP_GROUP"
}

verify_embedded_profile() {
  local bundle_path="$1"
  local bundle_id="$2"
  node "$PROFILE_VERIFIER" \
    --bundle="$bundle_path" \
    --expected-bundle-id="$bundle_id" \
    --expected-team-id="$TAXI_SIGNING_TEAM_ID" \
    --expected-app-group="$TAXI_APP_GROUP"
}

# Reject expired, development, App Store, wrong-team, wildcard, or wrong-app
# profiles before any bundle bytes are changed. Profile verification is repeated
# against the embedded bytes and final code-sign entitlements after signing.
verify_profile_source "$TAXI_APP_PROVISIONING_PROFILE_PATH" "$TAXI_APP_BUNDLE_ID"
verify_profile_source "$TAXI_WIDGET_PROVISIONING_PROFILE_PATH" "$TAXI_WIDGET_BUNDLE_ID"

# ── Codesign with Developer ID (replaces the ad-hoc sign) ────────────
# --deep signs embedded plugins/frameworks too (Taxi.app carries
# TaxiWidget.appex). --options=runtime enables hardened runtime,
# which notarytool requires. --timestamp embeds a trusted timestamp
# (notarization rejects un-timestamped signatures).
echo "notarize-app: codesigning with the verified Heznpc Developer ID …"

# Each embedded .appex carries its own entitlements (e.g. an app-group so the
# widget can read the host app's shared container). `codesign --remove-signature`
# drops the entitlements together with the signature, and re-signing WITHOUT
# `--entitlements` silently ships a widget with none — `codesign --verify` still
# passes, so the loss is invisible until the widget fails at runtime. Extract
# each appex's source entitlements for exact validation, then apply the canonical
# release allowlist on the Developer ID re-sign. (The plists persist on disk
# across the two find|while subshells, keyed by a hash of the appex path.)
ENT_DIR="$(mktemp -d)"
trap 'rm -rf "$ENT_DIR"' EXIT
SOURCE_MAIN_ENTITLEMENTS_FILE="$SCRIPT_DIR/lib/main-app-entitlements.plist"
SOURCE_WIDGET_ENTITLEMENTS_FILE="$SCRIPT_DIR/lib/widget-entitlements.plist"
MAIN_ENTITLEMENTS="$ENT_DIR/main-app-developer-id-entitlements.plist"
WIDGET_ENTITLEMENTS="$ENT_DIR/widget-developer-id-entitlements.plist"

MAIN_BASE_ENTITLEMENTS=(
  "com.apple.security.app-sandbox"
  "com.apple.security.application-groups"
  "com.apple.security.automation.apple-events"
)

WIDGET_BASE_ENTITLEMENTS=(
  "com.apple.security.app-sandbox"
  "com.apple.security.application-groups"
  "com.apple.security.personal-information.calendars"
  "com.apple.security.personal-information.reminders"
)

verify_main_entitlement_allowlist() {
  local entitlements_file="$1"
  local stage="$2"
  local signing_kind="$3"
  local allowlist_copy="$ENT_DIR/main-$stage-allowlist-check.plist"
  local allowed_key
  local remaining

  if ! /bin/cp "$entitlements_file" "$allowlist_copy"; then
    echo "notarize-app: $stage main-app entitlement allowlist could not be inspected" >&2
    return 1
  fi
  for allowed_key in "${MAIN_BASE_ENTITLEMENTS[@]}"; do
    /usr/libexec/PlistBuddy -c "Delete :$allowed_key" "$allowlist_copy" >/dev/null 2>&1 || true
  done
  if [ "$signing_kind" = "developer-id" ]; then
    for allowed_key in com.apple.application-identifier com.apple.developer.team-identifier; do
      /usr/libexec/PlistBuddy -c "Delete :$allowed_key" "$allowlist_copy" >/dev/null 2>&1 || true
    done
  fi
  if ! remaining="$(/usr/bin/plutil -p "$allowlist_copy" 2>/dev/null | /usr/bin/tr -d '[:space:]')"; then
    echo "notarize-app: $stage main-app entitlement allowlist could not be inspected" >&2
    return 1
  fi
  if [ "$remaining" != "{}" ]; then
    echo "notarize-app: $stage main-app contains an unexpected entitlement" >&2
    return 1
  fi
}

verify_main_entitlements() {
  local entitlements_file="$1"
  local stage="$2"
  local signing_kind="$3"
  local app_identifier_type
  local app_identifier
  local team_identifier_type
  local team_identifier
  local sandbox_type
  local sandbox_enabled
  local app_groups_type
  local app_groups
  local app_groups_compact
  local automation_type
  local automation_allowed

  if ! /usr/bin/plutil -lint "$entitlements_file" >/dev/null 2>&1; then
    echo "notarize-app: $stage main-app entitlements are missing or invalid" >&2
    return 1
  fi
  if ! verify_main_entitlement_allowlist "$entitlements_file" "$stage" "$signing_kind"; then
    return 1
  fi
  if [ "$signing_kind" = "developer-id" ]; then
    app_identifier_type="$(
      /usr/bin/plutil -type 'com\.apple\.application-identifier' \
        "$entitlements_file" 2>/dev/null || true
    )"
    app_identifier="$(
      /usr/libexec/PlistBuddy -c "Print :com.apple.application-identifier" \
        "$entitlements_file" 2>/dev/null || true
    )"
    if [ "$app_identifier_type" != "string" ] || [ "$app_identifier" != "$TAXI_SIGNING_TEAM_ID.$TAXI_APP_BUNDLE_ID" ]; then
      echo "notarize-app: $stage main-app application identifier is not the exact Taxi identity" >&2
      return 1
    fi
    team_identifier_type="$(
      /usr/bin/plutil -type 'com\.apple\.developer\.team-identifier' \
        "$entitlements_file" 2>/dev/null || true
    )"
    team_identifier="$(
      /usr/libexec/PlistBuddy -c "Print :com.apple.developer.team-identifier" \
        "$entitlements_file" 2>/dev/null || true
    )"
    if [ "$team_identifier_type" != "string" ] || [ "$team_identifier" != "$TAXI_SIGNING_TEAM_ID" ]; then
      echo "notarize-app: $stage main-app team identifier is not the Taxi team" >&2
      return 1
    fi
  fi
  sandbox_type="$(
    /usr/bin/plutil -type 'com\.apple\.security\.app-sandbox' \
      "$entitlements_file" 2>/dev/null || true
  )"
  if [ "$sandbox_type" != "bool" ]; then
    echo "notarize-app: $stage main-app sandbox entitlement must be a boolean" >&2
    return 1
  fi
  sandbox_enabled="$(
    /usr/libexec/PlistBuddy -c "Print :com.apple.security.app-sandbox" \
      "$entitlements_file" 2>/dev/null || true
  )"
  if [ "$sandbox_enabled" != "false" ]; then
    echo "notarize-app: $stage main-app must remain outside the App Sandbox" >&2
    return 1
  fi
  app_groups_type="$(
    /usr/bin/plutil -type 'com\.apple\.security\.application-groups' \
      "$entitlements_file" 2>/dev/null || true
  )"
  if [ "$app_groups_type" != "array" ]; then
    echo "notarize-app: $stage main-app application-groups entitlement must be an array" >&2
    return 1
  fi
  app_groups="$(
    /usr/libexec/PlistBuddy -c "Print :com.apple.security.application-groups" \
      "$entitlements_file" 2>/dev/null || true
  )"
  app_groups_compact="$(printf '%s' "$app_groups" | /usr/bin/tr -d '[:space:]')"
  if [ "$app_groups_compact" != "Array{group.app.taxi}" ]; then
    echo "notarize-app: $stage main-app application-groups must contain only group.app.taxi" >&2
    return 1
  fi
  automation_type="$(
    /usr/bin/plutil -type 'com\.apple\.security\.automation\.apple-events' \
      "$entitlements_file" 2>/dev/null || true
  )"
  if [ "$automation_type" != "bool" ]; then
    echo "notarize-app: $stage main-app Apple Events automation entitlement must be a boolean" >&2
    return 1
  fi
  automation_allowed="$(
    /usr/libexec/PlistBuddy -c "Print :com.apple.security.automation.apple-events" \
      "$entitlements_file" 2>/dev/null || true
  )"
  if [ "$automation_allowed" != "true" ]; then
    echo "notarize-app: $stage main-app entitlements are missing Apple Events automation access" >&2
    return 1
  fi
}

verify_widget_entitlement_allowlist() {
  local entitlements_file="$1"
  local stage="$2"
  local signing_kind="$3"
  local allowlist_copy="$ENT_DIR/widget-$stage-allowlist-check.plist"
  local allowed_key
  local remaining

  if ! /bin/cp "$entitlements_file" "$allowlist_copy"; then
    echo "notarize-app: $stage widget entitlement allowlist could not be inspected" >&2
    return 1
  fi
  for allowed_key in "${WIDGET_BASE_ENTITLEMENTS[@]}"; do
    /usr/libexec/PlistBuddy -c "Delete :$allowed_key" "$allowlist_copy" >/dev/null 2>&1 || true
  done
  if [ "$signing_kind" = "developer-id" ]; then
    for allowed_key in com.apple.application-identifier com.apple.developer.team-identifier; do
      /usr/libexec/PlistBuddy -c "Delete :$allowed_key" "$allowlist_copy" >/dev/null 2>&1 || true
    done
  fi
  if ! remaining="$(/usr/bin/plutil -p "$allowlist_copy" 2>/dev/null | /usr/bin/tr -d '[:space:]')"; then
    echo "notarize-app: $stage widget entitlement allowlist could not be inspected" >&2
    return 1
  fi
  if [ "$remaining" != "{}" ]; then
    echo "notarize-app: $stage widget contains an unexpected entitlement" >&2
    return 1
  fi
}

verify_widget_entitlements() {
  local entitlements_file="$1"
  local stage="$2"
  local signing_kind="$3"
  local app_identifier_type
  local app_identifier
  local team_identifier_type
  local team_identifier
  local sandbox_type
  local sandbox_enabled
  local app_groups_type
  local app_groups
  local app_groups_compact
  local capability
  local capability_type
  local capability_allowed

  if ! /usr/bin/plutil -lint "$entitlements_file" >/dev/null 2>&1; then
    echo "notarize-app: $stage widget entitlements are missing or invalid" >&2
    return 1
  fi
  if ! verify_widget_entitlement_allowlist "$entitlements_file" "$stage" "$signing_kind"; then
    return 1
  fi
  if [ "$signing_kind" = "developer-id" ]; then
    app_identifier_type="$(
      /usr/bin/plutil -type 'com\.apple\.application-identifier' \
        "$entitlements_file" 2>/dev/null || true
    )"
    app_identifier="$(
      /usr/libexec/PlistBuddy -c "Print :com.apple.application-identifier" \
        "$entitlements_file" 2>/dev/null || true
    )"
    if [ "$app_identifier_type" != "string" ] || [ "$app_identifier" != "$TAXI_SIGNING_TEAM_ID.$TAXI_WIDGET_BUNDLE_ID" ]; then
      echo "notarize-app: $stage widget application identifier is not the exact Taxi identity" >&2
      return 1
    fi
    team_identifier_type="$(
      /usr/bin/plutil -type 'com\.apple\.developer\.team-identifier' \
        "$entitlements_file" 2>/dev/null || true
    )"
    team_identifier="$(
      /usr/libexec/PlistBuddy -c "Print :com.apple.developer.team-identifier" \
        "$entitlements_file" 2>/dev/null || true
    )"
    if [ "$team_identifier_type" != "string" ] || [ "$team_identifier" != "$TAXI_SIGNING_TEAM_ID" ]; then
      echo "notarize-app: $stage widget team identifier is not the Taxi team" >&2
      return 1
    fi
  fi
  sandbox_type="$(
    /usr/bin/plutil -type 'com\.apple\.security\.app-sandbox' \
      "$entitlements_file" 2>/dev/null || true
  )"
  if [ "$sandbox_type" != "bool" ]; then
    echo "notarize-app: $stage widget sandbox entitlement must be a boolean" >&2
    return 1
  fi
  sandbox_enabled="$(
    /usr/libexec/PlistBuddy -c "Print :com.apple.security.app-sandbox" \
      "$entitlements_file" 2>/dev/null || true
  )"
  if [ "$sandbox_enabled" != "true" ]; then
    echo "notarize-app: $stage widget must enable the App Sandbox" >&2
    return 1
  fi
  app_groups_type="$(
    /usr/bin/plutil -type 'com\.apple\.security\.application-groups' \
      "$entitlements_file" 2>/dev/null || true
  )"
  if [ "$app_groups_type" != "array" ]; then
    echo "notarize-app: $stage widget application-groups entitlement must be an array" >&2
    return 1
  fi
  app_groups="$(
    /usr/libexec/PlistBuddy -c "Print :com.apple.security.application-groups" \
      "$entitlements_file" 2>/dev/null || true
  )"
  app_groups_compact="$(printf '%s' "$app_groups" | /usr/bin/tr -d '[:space:]')"
  if [ "$app_groups_compact" != "Array{group.app.taxi}" ]; then
    echo "notarize-app: $stage widget application-groups must contain only group.app.taxi" >&2
    return 1
  fi
  for capability in calendars reminders; do
    capability_type="$(
      /usr/bin/plutil -type "com\.apple\.security\.personal-information\.$capability" \
        "$entitlements_file" 2>/dev/null || true
    )"
    if [ "$capability_type" != "bool" ]; then
      echo "notarize-app: $stage widget $capability entitlement must be a boolean" >&2
      return 1
    fi
    capability_allowed="$(
      /usr/libexec/PlistBuddy -c "Print :com.apple.security.personal-information.$capability" \
        "$entitlements_file" 2>/dev/null || true
    )"
    if [ "$capability_allowed" != "true" ]; then
      echo "notarize-app: $stage widget $capability entitlement must be enabled" >&2
      return 1
    fi
  done
}

# Inspect the source signature before changing it, but never promote its plist
# wholesale into a Developer ID signature. A stray development/debug entitlement
# in the ad-hoc input must fail closed instead of becoming part of the release.
SOURCE_MAIN_ENTITLEMENTS="$ENT_DIR/source-main-app.plist"
if ! codesign -d --entitlements "$SOURCE_MAIN_ENTITLEMENTS" --xml \
  "$APP_BUNDLE" >/dev/null 2>&1; then
  echo "notarize-app: could not extract main-app entitlements" >&2
  exit 1
fi
if ! verify_main_entitlements "$SOURCE_MAIN_ENTITLEMENTS" "source" "ad-hoc"; then
  exit 1
fi

# Start from the canonical ad-hoc capability allowlists, then add the two
# identity entitlements only for this Developer ID signing pass. Putting these
# identifiers in the local/ad-hoc signature makes macOS kill that build before
# launch because no Developer ID profile authorizes it.
if ! verify_main_entitlements "$SOURCE_MAIN_ENTITLEMENTS_FILE" "canonical source" "ad-hoc" ||
  ! verify_widget_entitlements "$SOURCE_WIDGET_ENTITLEMENTS_FILE" "canonical source" "ad-hoc" ||
  ! /bin/cp "$SOURCE_MAIN_ENTITLEMENTS_FILE" "$MAIN_ENTITLEMENTS" ||
  ! /bin/cp "$SOURCE_WIDGET_ENTITLEMENTS_FILE" "$WIDGET_ENTITLEMENTS" ||
  ! /usr/bin/plutil -insert 'com\.apple\.application-identifier' -string \
    "$TAXI_SIGNING_TEAM_ID.$TAXI_APP_BUNDLE_ID" "$MAIN_ENTITLEMENTS" ||
  ! /usr/bin/plutil -insert 'com\.apple\.developer\.team-identifier' -string \
    "$TAXI_SIGNING_TEAM_ID" "$MAIN_ENTITLEMENTS" ||
  ! /usr/bin/plutil -insert 'com\.apple\.application-identifier' -string \
    "$TAXI_SIGNING_TEAM_ID.$TAXI_WIDGET_BUNDLE_ID" "$WIDGET_ENTITLEMENTS" ||
  ! /usr/bin/plutil -insert 'com\.apple\.developer\.team-identifier' -string \
    "$TAXI_SIGNING_TEAM_ID" "$WIDGET_ENTITLEMENTS"; then
  echo "notarize-app: Developer ID entitlement construction failed" >&2
  exit 1
fi
if ! verify_main_entitlements "$MAIN_ENTITLEMENTS" "allowlisted" "developer-id"; then
  exit 1
fi
echo "  constructed allowlisted main-app entitlements"
if ! verify_widget_entitlements "$WIDGET_ENTITLEMENTS" "allowlisted" "developer-id"; then
  exit 1
fi
echo "  constructed allowlisted widget entitlements"

find "$APP_BUNDLE" -name "*.appex" -print0 2>/dev/null | while IFS= read -r -d '' appex; do
  ent_file="$ENT_DIR/$(printf '%s' "$appex" | shasum -a 256 | cut -d' ' -f1).plist"
  if ! codesign -d --entitlements "$ent_file" --xml "$appex" >/dev/null 2>&1; then
    echo "notarize-app: could not extract widget entitlements" >&2
    exit 1
  fi
  if ! verify_widget_entitlements "$ent_file" "source" "ad-hoc"; then
    exit 1
  fi
  echo "  validated source widget entitlements"
  codesign --remove-signature "$appex" 2>/dev/null || true
done

# macOS resolves each profile relative to the code object it authorizes. Embed
# the app and extension profiles at their respective Contents roots before the
# inside-out signing pass; never reuse the host profile for the extension.
APP_EMBEDDED_PROFILE="$APP_BUNDLE/Contents/embedded.provisionprofile"
WIDGET_EMBEDDED_PROFILE="$WIDGET_APPEX/Contents/embedded.provisionprofile"
if ! /usr/bin/install -m 0644 "$TAXI_APP_PROVISIONING_PROFILE_PATH" "$APP_EMBEDDED_PROFILE" ||
  ! /usr/bin/install -m 0644 "$TAXI_WIDGET_PROVISIONING_PROFILE_PATH" "$WIDGET_EMBEDDED_PROFILE" ||
  ! /usr/bin/cmp -s "$TAXI_APP_PROVISIONING_PROFILE_PATH" "$APP_EMBEDDED_PROFILE" ||
  ! /usr/bin/cmp -s "$TAXI_WIDGET_PROVISIONING_PROFILE_PATH" "$WIDGET_EMBEDDED_PROFILE"; then
  echo "notarize-app: provisioning profile embedding failed" >&2
  exit 1
fi
echo "  embedded distinct app and widget Developer ID profiles"

# The self-contained app embeds executable Node and Swift bridge binaries.
# They are nested code and must receive the same Developer ID + hardened
# runtime treatment before the outer bundle is signed.
#
# The Node binary additionally needs JIT entitlements: V8 requires
# writable-then-executable pages, which the hardened runtime forbids by
# default. Signing node without them produces a bundle that signs, notarizes,
# and staples cleanly but whose embedded runtime dies with SIGTRAP before
# main() — verify-bundle-structure.sh catches this because it executes the
# bundled runtime, but only after a wasted notarization round-trip. The
# Swift bridge performs no JIT and must stay on the default (stricter)
# entitlement set.
NODE_RUNTIME_ENTITLEMENTS="$SCRIPT_DIR/lib/node-runtime-entitlements.plist"
if [ ! -f "$NODE_RUNTIME_ENTITLEMENTS" ]; then
  echo "notarize-app: node runtime entitlements file missing" >&2
  exit 1
fi
while IFS= read -r -d '' dylib; do
  echo "  signing embedded Node dylib"
  if ! codesign --force --options=runtime --timestamp \
    --sign "$APPLE_DEVELOPER_ID" \
    "$dylib" >/dev/null 2>&1; then
    echo "notarize-app: embedded Node dylib signing failed" >&2
    exit 1
  fi
done < <(find "$APP_BUNDLE/Contents/Resources/taxi/runtime/lib" -type f -name '*.dylib' -print0 2>/dev/null)
for nested in \
  "$APP_BUNDLE/Contents/Resources/taxi/runtime/bin/node" \
  "$APP_BUNDLE/Contents/Resources/taxi/bin/TaxiBridge"; do
  if [ ! -x "$nested" ]; then
    echo "notarize-app: required embedded executable missing" >&2
    exit 1
  fi
  echo "  signing embedded executable"
  NESTED_SIGN_ARGS=(--force --options=runtime --timestamp)
  if [ "$(basename "$nested")" = "node" ]; then
    NESTED_SIGN_ARGS+=(--entitlements "$NODE_RUNTIME_ENTITLEMENTS")
  fi
  if ! codesign "${NESTED_SIGN_ARGS[@]}" \
    --sign "$APPLE_DEVELOPER_ID" \
    "$nested" >/dev/null 2>&1; then
    echo "notarize-app: embedded executable signing failed" >&2
    exit 1
  fi
done
codesign --remove-signature "$APP_BUNDLE" 2>/dev/null || true

# Sign embedded extensions first (innermost-out), applying the canonical widget
# allowlist rather than promoting the source signature's complete plist.
find "$APP_BUNDLE" -name "*.appex" -print0 2>/dev/null | while IFS= read -r -d '' appex; do
  echo "  signing embedded extension"
  ent_hash="$(printf '%s' "$appex" | shasum -a 256 | cut -d' ' -f1)"
  final_ent_file="$ENT_DIR/final-$ent_hash.plist"
  codesign --force --options=runtime --timestamp \
    --entitlements "$WIDGET_ENTITLEMENTS" \
    --sign "$APPLE_DEVELOPER_ID" \
    "$appex" >/dev/null 2>&1 || {
      echo "notarize-app: extension signing failed" >&2
      exit 1
    }
  if ! codesign -d --entitlements "$final_ent_file" --xml \
    "$appex" >/dev/null 2>&1; then
    echo "notarize-app: could not inspect re-signed widget entitlements" >&2
    exit 1
  fi
  if ! verify_widget_entitlements "$final_ent_file" "re-signed" "developer-id"; then
    exit 1
  fi
  if ! verify_embedded_profile "$appex" "$TAXI_WIDGET_BUNDLE_ID"; then
    exit 1
  fi
done

# Finally sign the outer bundle WITHOUT --deep. The appex(es) were already
# signed (with their entitlements) inside-out above, and `--deep` would RE-SIGN
# them WITHOUT entitlements, silently undoing that preservation. The
# `codesign --verify --deep --strict` below still validates the whole tree, so
# any nested code that genuinely went unsigned is caught loudly, not shipped.
if ! codesign --force --options=runtime --timestamp \
  --entitlements "$MAIN_ENTITLEMENTS" \
  --sign "$APPLE_DEVELOPER_ID" \
  "$APP_BUNDLE" >/dev/null 2>&1; then
  echo "notarize-app: outer bundle signing failed" >&2
  exit 1
fi

# ── Verify signature before submitting to Apple ─────────────────────
echo "notarize-app: verifying signature …"
codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE" >/dev/null 2>&1 || {
  echo "notarize-app: codesign verification failed — refusing to submit" >&2
  exit 1
}
FINAL_MAIN_ENTITLEMENTS="$ENT_DIR/final-main-app.plist"
if ! codesign -d --entitlements "$FINAL_MAIN_ENTITLEMENTS" --xml \
  "$APP_BUNDLE" >/dev/null 2>&1; then
  echo "notarize-app: could not inspect re-signed main-app entitlements" >&2
  exit 1
fi
if ! verify_main_entitlements "$FINAL_MAIN_ENTITLEMENTS" "re-signed" "developer-id"; then
  exit 1
fi
verify_embedded_profile "$APP_BUNDLE" "$TAXI_APP_BUNDLE_ID"
echo "notarize-app: required main-app entitlements preserved"

if [ "${SKIP_NOTARIZATION:-}" = "1" ]; then
  echo "notarize-app: SKIP_NOTARIZATION=1 — signed but not notarized"
  exit 0
fi

# ── Notarize via notarytool ─────────────────────────────────────────
# notarytool needs a .zip or .dmg, not an .app directory directly.
ZIP_PATH="$PROJECT_DIR/Taxi-notarize.zip"
echo "notarize-app: preparing notarization archive"
rm -f "$ZIP_PATH"
if ! ditto -c -k --keepParent "$APP_BUNDLE" "$ZIP_PATH" >/dev/null 2>&1; then
  echo "notarize-app: notarization archive creation failed" >&2
  exit 1
fi

echo "notarize-app: submitting to Apple (this takes 2-10 minutes) …"
set +e
SUBMIT_OUTPUT="$(
  xcrun notarytool submit "$ZIP_PATH" \
    "${NOTARY_AUTH[@]}" \
    --wait \
    --output-format json 2>&1
)"
SUBMIT_EXIT=$?
set -e

NOTARY_STATUS="$(printf '%s' "$SUBMIT_OUTPUT" | node -e '
  let input = "";
  process.stdin.on("data", chunk => { input += chunk; });
  process.stdin.on("end", () => {
    try { process.stdout.write(String(JSON.parse(input).status ?? "")); } catch {}
  });
')"
SUBMISSION_ID="$(printf '%s' "$SUBMIT_OUTPUT" | node -e '
  let input = "";
  process.stdin.on("data", chunk => { input += chunk; });
  process.stdin.on("end", () => {
    try { process.stdout.write(String(JSON.parse(input).id ?? "")); } catch {}
  });
')"

# notarytool --wait reports `Accepted` on success. Anything else is a hard
# failure. Fetch the private issue log only to emit sanitized code and
# Taxi.app-relative coordinates; never print its URL, submission ID, account,
# team, certificate subject, or raw messages into the public Actions log.
if [ "$SUBMIT_EXIT" -ne 0 ] || [ "$NOTARY_STATUS" != "Accepted" ]; then
  echo "notarize-app: notarization failed; raw account, certificate, and submission metadata is suppressed" >&2

  # Two failures land here and they need completely different fixes:
  #
  #   a) Apple accepted the submission and rejected the binary. There is a
  #      submission ID, and the sanitized issue log below says what to change.
  #   b) notarytool never created a submission — credentials were refused, the
  #      API key/profile is invalid, or the Program License Agreement
  #      is unaccepted. No submission ID exists, so the log path cannot run.
  #
  # Case (b) previously printed the suppression notice and nothing else, leaving
  # an operator with a red release and no way to distinguish rejected credentials
  # from a rejected binary. Classify it without echoing notarytool's raw output,
  # which carries the account and team.
  if ! [[ "$SUBMISSION_ID" =~ ^[0-9A-Fa-f-]{36}$ ]]; then
    echo "notarize-app: Apple never accepted the submission, so this is a credential or account" >&2
    echo "notarize-app: problem rather than a rejected build. Check, in this order:" >&2
    case "$NOTARY_AUTH_KIND" in
      api-key)
        echo "notarize-app:   1. APPLE_API_KEY_ID and APPLE_API_ISSUER_ID must belong to the same key" >&2
        echo "notarize-app:      as the .p8 at APPLE_API_KEY_PATH — a mismatched pair is refused" >&2
        echo "notarize-app:   2. the key needs the Admin (or App Manager) role in App Store Connect" >&2
        echo "notarize-app:   3. a revoked key keeps its .p8 file but stops authenticating" >&2
        ;;
      keychain-profile)
        echo "notarize-app:   1. NOTARY_KEYCHAIN_PROFILE must name a profile saved by" >&2
        echo "notarize-app:      'xcrun notarytool store-credentials' on THIS machine and keychain" >&2
        echo "notarize-app:   2. a locked login keychain makes the stored profile unreadable" >&2
        ;;
    esac
    echo "notarize-app:   the Apple Developer Program License Agreement must also be accepted at" >&2
    echo "notarize-app:   developer.apple.com — notarytool refuses before submitting while it is pending" >&2
    echo "notarize-app: verify the same credentials locally with: xcrun notarytool history <same auth flags>" >&2
    exit 2
  fi

  if [[ "$SUBMISSION_ID" =~ ^[0-9A-Fa-f-]{36}$ ]]; then
    set +e
    NOTARY_LOG="$(
      xcrun notarytool log "$SUBMISSION_ID" \
        "${NOTARY_AUTH[@]}" \
        --output-format json 2>/dev/null
    )"
    LOG_EXIT=$?
    set -e
    if [ "$LOG_EXIT" -eq 0 ]; then
      printf '%s' "$NOTARY_LOG" | node "$SCRIPT_DIR/sanitize-notary-log.mjs" || true
    fi
  fi
  exit 2
fi
echo "notarize-app: notarization accepted"

# ── Staple the ticket onto the .app so Gatekeeper works offline ─────
# Without stapling, first-launch requires an internet connection to
# fetch the notarization verdict from Apple. Stapling embeds the
# verdict so the app opens on a fresh Mac with no network.
echo "notarize-app: stapling notarization ticket …"
if ! xcrun stapler staple "$APP_BUNDLE" >/dev/null 2>&1; then
  echo "notarize-app: ticket stapling failed" >&2
  exit 1
fi
if ! xcrun stapler validate "$APP_BUNDLE" >/dev/null 2>&1; then
  echo "notarize-app: stapled ticket validation failed" >&2
  exit 1
fi

rm -f "$ZIP_PATH"
echo "notarize-app: running final signed-artifact verification …"
APP_BUNDLE_PATH="$APP_BUNDLE" bash "$SCRIPT_DIR/verify-signed-app.sh"

# The lifecycle gate launches and then crash-terminates the exact candidate.
# Re-read every distribution property after that hour-long exercise so a
# post-launch mutation, damaged staple, or invalidated nested signature cannot
# inherit the earlier green result.
echo "notarize-app: re-checking the exact artifact after runtime verification …"
if ! codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE" >/dev/null 2>&1; then
  echo "notarize-app: post-runtime code-sign verification failed" >&2
  exit 1
fi
POST_RUNTIME_SIGN_INFO="$(codesign -dv --verbose=4 "$APP_BUNDLE" 2>&1)"
POST_RUNTIME_AUTHORITY="$({
  printf '%s\n' "$POST_RUNTIME_SIGN_INFO" |
    sed -nE 's/^Authority=(Developer ID Application:.*)$/\1/p' |
    head -1
} || true)"
POST_RUNTIME_TEAM="$({
  printf '%s\n' "$POST_RUNTIME_SIGN_INFO" |
    sed -nE 's/^TeamIdentifier=([A-Z0-9]+)$/\1/p' |
    head -1
} || true)"
POST_RUNTIME_CDHASH="$({
  printf '%s\n' "$POST_RUNTIME_SIGN_INFO" |
    sed -nE 's/^CDHash=([0-9A-Fa-f]+)$/\1/p' |
    head -1
} || true)"
if ! is_taxi_developer_id_authority "$POST_RUNTIME_AUTHORITY" ||
  [ "$POST_RUNTIME_TEAM" != "$TAXI_SIGNING_TEAM_ID" ] ||
  ! [[ "$POST_RUNTIME_CDHASH" =~ ^[0-9A-Fa-f]{40,64}$ ]] ||
  printf '%s\n' "$POST_RUNTIME_SIGN_INFO" | grep -q '^Signature=adhoc$' ||
  ! printf '%s\n' "$POST_RUNTIME_SIGN_INFO" | grep -q '^Runtime Version='; then
  echo "notarize-app: post-runtime Developer ID or hardened-runtime identity is invalid" >&2
  exit 1
fi
if ! spctl --assess --type execute -vvv "$APP_BUNDLE" >/dev/null 2>&1; then
  echo "notarize-app: post-runtime Gatekeeper assessment failed" >&2
  exit 1
fi
if ! xcrun stapler validate "$APP_BUNDLE" >/dev/null 2>&1; then
  echo "notarize-app: post-runtime notarization staple validation failed" >&2
  exit 1
fi
if ! TAXI_REQUIRE_WIDGET=1 \
  TAXI_EXPECTED_SIGNING_MODE=developer-id \
  TAXI_EXPECTED_SIGNING_TEAM_ID="$TAXI_SIGNING_TEAM_ID" \
  bash "$SCRIPT_DIR/verify-bundle-structure.sh" "$APP_BUNDLE" "app.taxi" "Taxi" \
    >/dev/null 2>&1; then
  echo "notarize-app: post-runtime bundle structure verification failed" >&2
  exit 1
fi
if ! verify_embedded_profile "$APP_BUNDLE" "$TAXI_APP_BUNDLE_ID" ||
  ! verify_embedded_profile "$WIDGET_APPEX" "$TAXI_WIDGET_BUNDLE_ID"; then
  echo "notarize-app: post-runtime provisioning contract verification failed" >&2
  exit 1
fi

# This proof is deliberately optional for local notarization. The protected
# release lane supplies an exclusive output path, and receipt creation refuses
# to proceed without the proof. A short smoke run can produce evidence, but it
# is explicitly marked non-release and therefore cannot mint a receipt.
if [ -n "${TAXI_SIGNED_VERIFICATION_OUTPUT:-}" ]; then
  APP_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_BUNDLE/Contents/Info.plist")"
  RELEASE_GRADE_RUNTIME="$(node -e '
    const duration = Number(process.argv[1]);
    process.stdout.write(Number.isFinite(duration) && duration >= 3600 ? "true" : "false");
  ' "${TAXI_SIGNED_SOAK_DURATION_SECONDS:-3600}")"
  TAXI_EVIDENCE_BUNDLE_VERSION="$APP_VERSION" \
    TAXI_EVIDENCE_TEAM="$POST_RUNTIME_TEAM" \
    TAXI_EVIDENCE_CDHASH="$(printf '%s' "$POST_RUNTIME_CDHASH" | tr '[:upper:]' '[:lower:]')" \
    TAXI_EVIDENCE_RELEASE_RUNTIME="$RELEASE_GRADE_RUNTIME" \
    node - "$TAXI_SIGNED_VERIFICATION_OUTPUT" <<'NODE'
const fs = require("node:fs");

const output = process.argv[2];
const evidence = {
  schema: "taxi.signed-app-verification.v1",
  artifact: {
    bundleIdentifier: "app.taxi",
    executable: "Taxi",
    version: process.env.TAXI_EVIDENCE_BUNDLE_VERSION,
    teamIdentifier: process.env.TAXI_EVIDENCE_TEAM,
    codeDirectoryHash: process.env.TAXI_EVIDENCE_CDHASH,
  },
  verification: {
    lifecycleVerifier: "scripts/verify-signed-app.sh",
    result: "passed",
    developerIdSignature: true,
    gatekeeperAssessment: true,
    notarizationStaple: true,
    releaseGradeRuntime: process.env.TAXI_EVIDENCE_RELEASE_RUNTIME === "true",
    normalShutdown: true,
    sigtermRuntimeRestart: true,
    crashCleanup: true,
    postRuntimeStaticVerification: true,
    provisioningProfiles: true,
  },
};
fs.writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`, {
  encoding: "utf8",
  flag: "wx",
  mode: 0o600,
});
NODE
  echo "notarize-app: wrote private post-runtime verification evidence"
fi

echo "notarize-app: ✓ artifact signed, notarized, stapled, runtime-verified, and revalidated"
