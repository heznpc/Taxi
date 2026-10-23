#!/bin/bash
# Build a proper .app bundle from the SwiftPM output, then optionally run,
# verify, stream logs, or attach LLDB to the bundled macOS app.
#
# A real bundle is required because UNUserNotificationCenter, NSServices, URL
# schemes, and other AppKit features need Info.plist metadata + a bundle ID.

set -euo pipefail

usage() {
  cat <<'USAGE_EOF'
Usage: scripts/bundle-app.sh [bundle|run|verify|verify-governed|verify-soak|verify-appintents|logs|telemetry|debug|widget-debug|widget-release]

Modes:
  bundle     Build Taxi.app only (default)
  run        Build Taxi.app and launch it
  verify     Build, launch, and assert the app-owned HTTP runtime contract
  verify-governed
             Prove read, approved/denied writes, emergency stop, and audit integrity
  verify-soak
             Run the app-owned runtime for at least one hour and reject listener,
             generation, liveness, or sustained high-CPU failures
  verify-appintents
             Require a trusted signing identity, then verify AppIntents registration
  logs       Build, launch, and stream logs for the Taxi process
  telemetry  Build, launch, and stream logs for the Taxi subsystem
  debug      Build, launch, and attach LLDB to the running app process
  widget-debug
             Build only the widget target in debug mode
  widget-release
             Build only the widget target in release mode

Runtime modes skip the widget extension by default for fast app iteration.
Set TAXI_SKIP_WIDGET=0 to force a widget build, or =1 to skip explicitly.
Set TAXI_REQUIRE_WIDGET=1 for signed distribution: widget build failure or
absence becomes fatal and TAXI_SKIP_WIDGET=1 is rejected.
Set TAXI_SIGN_IDENTITY to a valid signing identity for Shortcuts/AppIntents
registration; ad-hoc signing is used when it is unset.
USAGE_EOF
}

MODE="${1:-bundle}"
case "$MODE" in
  bundle|--bundle) MODE="bundle" ;;
  run|--run) MODE="run" ;;
  verify|--verify) MODE="verify" ;;
  verify-governed|--verify-governed) MODE="verify-governed" ;;
  verify-soak|--verify-soak) MODE="verify-soak" ;;
  verify-appintents|--verify-appintents) MODE="verify-appintents" ;;
  logs|--logs) MODE="logs" ;;
  telemetry|--telemetry) MODE="telemetry" ;;
  debug|--debug) MODE="debug" ;;
  widget-debug|--widget-debug) MODE="widget-debug" ;;
  widget-release|--widget-release) MODE="widget-release" ;;
  -h|--help|help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

TAXI_REQUIRE_WIDGET="${TAXI_REQUIRE_WIDGET:-0}"
if [ "$TAXI_REQUIRE_WIDGET" != "0" ] && [ "$TAXI_REQUIRE_WIDGET" != "1" ]; then
  echo "✗ TAXI_REQUIRE_WIDGET must be 0 or 1, got: $TAXI_REQUIRE_WIDGET" >&2
  exit 2
fi

if [ -z "${TAXI_SKIP_WIDGET+x}" ]; then
  if [ "$TAXI_REQUIRE_WIDGET" = "1" ]; then
    TAXI_SKIP_WIDGET=0
  else
    case "$MODE" in
      run|verify|verify-governed|verify-soak|verify-appintents|logs|telemetry|debug) TAXI_SKIP_WIDGET=1 ;;
      *) TAXI_SKIP_WIDGET=0 ;;
    esac
  fi
fi
if [ "$TAXI_REQUIRE_WIDGET" = "1" ] && [ "$TAXI_SKIP_WIDGET" = "1" ]; then
  echo "✗ signed distribution requires TaxiWidget; TAXI_SKIP_WIDGET=1 is not allowed" >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
APP_DIR="$PROJECT_DIR/app"
APP_SWIFT_BUILD_ARGS=(-c release)
BUNDLE_DIR="$PROJECT_DIR/Taxi.app"
ACCEPTANCE_HARNESS_BUILD=0
case "$MODE" in
  verify|verify-governed|verify-soak|verify-appintents)
    APP_SWIFT_BUILD_ARGS+=(--scratch-path "$APP_DIR/.build/acceptance-harness")
    APP_SWIFT_BUILD_ARGS+=(-Xswiftc -DTAXI_ACCEPTANCE_HARNESS)
    BUNDLE_DIR="$PROJECT_DIR/.build/Taxi-Acceptance.app"
    ACCEPTANCE_HARNESS_BUILD=1
    ;;
esac
BUNDLE_ID="app.taxi"
APP_EXECUTABLE="Taxi"
APP_BINARY="$BUNDLE_DIR/Contents/MacOS/$APP_EXECUTABLE"
WIDGET_BUNDLE_ID="$BUNDLE_ID.Widget"
WIDGET_APPEX="$BUNDLE_DIR/Contents/PlugIns/TaxiWidget.appex"
WIDGET_ENTITLEMENTS="$SCRIPT_DIR/lib/widget-entitlements.plist"
LSREGISTER="/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"
PLUGINKIT="/usr/bin/pluginkit"
REGISTRATION_ATTEMPTS=20
REGISTRATION_SLEEP_SECONDS=0.1
SIGN_IDENTITY="${TAXI_SIGN_IDENTITY:--}"
TAXI_EMBED_RUNTIME="${TAXI_EMBED_RUNTIME:-1}"
case "$MODE" in
  verify|verify-governed|verify-soak|verify-appintents)
    # These gates claim to exercise the shipping, self-contained app. Never let
    # a developer-shell override silently turn it into an npx/checkout fallback.
    TAXI_EMBED_RUNTIME=1
    ;;
esac
APP_HTTP_PORT=3848
APP_HEALTH_URL="http://127.0.0.1:$APP_HTTP_PORT/health"
APP_MCP_URL="http://127.0.0.1:$APP_HTTP_PORT/mcp"
TOKEN_FILE="${TAXI_APP_RUNTIME_TOKEN_PATH:-$HOME/Library/Application Support/Taxi/http-token}"
OWNER_SECRET_FILE="${TAXI_APP_RUNTIME_OWNER_PATH:-$HOME/Library/Application Support/Taxi/runtime-owner-secret}"
VERIFICATION_STATE_DIR=""
VERIFICATION_STATE_PARENT="${TMPDIR:-/tmp}"
PROCESS_SHUTDOWN_WAIT_STEPS=70 # 7s, above the server's 5s graceful-shutdown budget
VERIFIED_APP_PID=""
VERIFIED_APP_BIRTH=""
VERIFIED_RUNTIME_PID=""
VERIFIED_RUNTIME_BIRTH=""
LAUNCHED_APP_PID=""
VERIFICATION_LAUNCH_ATTEMPTED=0
ATTESTED_PIDS=()
ATTESTED_BIRTHS=()
ATTESTED_MODES=()
ATTESTED_TARGETS=()
LIFECYCLE_SHUTDOWN_VERIFIED=0
SOAK_DURATION_SECONDS="${TAXI_SOAK_DURATION_SECONDS:-3600}"
SOAK_INTERVAL_SECONDS="${TAXI_SOAK_INTERVAL_SECONDS:-5}"
SOAK_MCP_INTERVAL_SECONDS="${TAXI_SOAK_MCP_INTERVAL_SECONDS:-60}"
SOAK_MAX_SUSTAINED_CPU="${TAXI_SOAK_MAX_SUSTAINED_CPU:-80}"
SOAK_MAX_HIGH_CPU_SECONDS="${TAXI_SOAK_MAX_HIGH_CPU_SECONDS:-60}"
SOAK_ALLOW_SHORT="${TAXI_ALLOW_SHORT_SOAK:-0}"
EXPECTED_VERSION="$(
  node -e 'const fs = require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version)' \
    "$PROJECT_DIR/package.json"
)"
BUILD_NUMBER="${TAXI_BUILD_NUMBER:-$(git -C "$PROJECT_DIR" rev-list --count HEAD)}"
if ! [[ "$BUILD_NUMBER" =~ ^[0-9]+$ ]]; then
  echo "✗ TAXI_BUILD_NUMBER must be a positive integer, got: $BUILD_NUMBER" >&2
  exit 2
fi

register_bundle_with_launch_services() {
  local registered_plugins=""
  local selected_plugin=""
  local attempt=0

  if [ ! -x "$LSREGISTER" ]; then
    echo "✗ Launch Services registration tool is unavailable: $LSREGISTER" >&2
    return 1
  fi
  if ! "$LSREGISTER" -lint -f "$BUNDLE_DIR" >/dev/null 2>&1; then
    echo "✗ Launch Services rejected $BUNDLE_DIR" >&2
    return 1
  fi
  if [ ! -d "$WIDGET_APPEX" ]; then
    return 0
  fi
  if [ ! -x "$PLUGINKIT" ]; then
    echo "✗ pluginkit is unavailable; widget registration cannot be verified" >&2
    return 1
  fi
  # Launch Services does not synchronously discover an embedded WidgetKit
  # extension from an arbitrary development build path on every macOS release.
  # Register the exact appex explicitly, then prove PlugInKit can resolve it.
  if ! "$PLUGINKIT" -a "$WIDGET_APPEX" >/dev/null 2>&1; then
    echo "✗ WidgetKit rejected extension registration for $WIDGET_APPEX" >&2
    return 1
  fi
  while [ "$attempt" -lt "$REGISTRATION_ATTEMPTS" ]; do
    # Query every known instance so a newer installed release cannot hide this
    # exact build path. A superseded (=) entry is still registered/discoverable;
    # reject only ignored (-), debugger-only (!), and unknown (?) elections.
    registered_plugins="$("$PLUGINKIT" -m -A -D -v -i "$WIDGET_BUNDLE_ID" 2>/dev/null || true)"
    selected_plugin="$(
      printf '%s\n' "$registered_plugins" |
        /usr/bin/awk -F '\t' -v target="$WIDGET_APPEX" '$NF == target { print; exit }'
    )"
    if [ -n "$selected_plugin" ] && ! [[ "$selected_plugin" =~ ^[[:space:]]*[-?!] ]]; then
      return 0
    fi
    attempt=$((attempt + 1))
    /bin/sleep "$REGISTRATION_SLEEP_SECONDS"
  done
  echo "✗ WidgetKit extension registration failed for $WIDGET_APPEX" >&2
  return 1
}

if [ "$MODE" = "verify-appintents" ]; then
  if [ "$SIGN_IDENTITY" = "-" ]; then
    echo "✗ TAXI_SIGN_IDENTITY is required for AppIntents registration verification." >&2
    if security find-identity -v -p codesigning | grep -E "[0-9]+\\) [A-F0-9]+ " >/dev/null; then
      echo "  Set it to one of the identities from: security find-identity -v -p codesigning" >&2
    else
      echo "  This machine currently has no trusted signing identity configured." >&2
    fi
    exit 1
  fi
  if ! security find-identity -v -p codesigning | grep -F "$SIGN_IDENTITY" >/dev/null; then
    echo "✗ signing identity not found: $SIGN_IDENTITY" >&2
    exit 1
  fi
fi

if [ "$MODE" = "widget-debug" ] || [ "$MODE" = "widget-release" ]; then
  WIDGET_CONFIG="debug"
  if [ "$MODE" = "widget-release" ]; then
    WIDGET_CONFIG="release"
  fi
  echo "Building TaxiWidget ($WIDGET_CONFIG)..."
  exec /usr/bin/time -p sh -c "cd \"$APP_DIR/widget\" && swift build -c \"$WIDGET_CONFIG\""
fi

if [ "$TAXI_EMBED_RUNTIME" = "1" ]; then
  echo "Building universal Taxi JavaScript catalog..."
  (cd "$PROJECT_DIR" && npm run build)
  echo "Building TaxiBridge..."
  (cd "$PROJECT_DIR/swift" && swift build -c release)
  BRIDGE_BUILD_DIR="$(cd "$PROJECT_DIR/swift" && swift build -c release --show-bin-path)"
fi

echo "Building TaxiApp..."
PREVIOUS_APP_BUILD_DIR="$(cd "$APP_DIR" && swift build "${APP_SWIFT_BUILD_ARGS[@]}" --show-bin-path)"
# SwiftPM can leave removed .lproj directories in an incremental resource
# bundle. Recreate that generated bundle so renamed locales cannot leak into
# the packaged app.
rm -rf "$PREVIOUS_APP_BUILD_DIR/TaxiApp_TaxiApp.bundle"
(cd "$APP_DIR" && swift build "${APP_SWIFT_BUILD_ARGS[@]}")
BUILD_DIR="$(cd "$APP_DIR" && swift build "${APP_SWIFT_BUILD_ARGS[@]}" --show-bin-path)"

echo "Creating app bundle..."
rm -rf "$BUNDLE_DIR"
mkdir -p "$BUNDLE_DIR/Contents/MacOS"
mkdir -p "$BUNDLE_DIR/Contents/Resources"

# Copy binary
cp "$BUILD_DIR/TaxiApp" "$APP_BINARY"

# Copy icons
for icon in AppIcon@2x.png AppIcon.png MenuBarIcon.png; do
  if [ -f "$APP_DIR/Sources/TaxiApp/Resources/$icon" ]; then
    cp "$APP_DIR/Sources/TaxiApp/Resources/$icon" "$BUNDLE_DIR/Contents/Resources/"
  fi
done

# Also copy the SwiftPM resource bundle (resolved by Bundle.moduleResources)
RESOURCE_BUNDLE="$BUILD_DIR/TaxiApp_TaxiApp.bundle"
if [ -d "$RESOURCE_BUNDLE" ]; then
  cp -R "$RESOURCE_BUNDLE" "$BUNDLE_DIR/Contents/Resources/"
fi

# Embed a fixed Node runtime, the universal JS server, production dependencies,
# and the Swift bridge. The signed app therefore does not depend on npx, a
# global npm install, or a developer checkout at runtime.
if [ "$TAXI_EMBED_RUNTIME" = "1" ]; then
  RUNTIME_ROOT="$BUNDLE_DIR/Contents/Resources/taxi"
  SERVER_ROOT="$RUNTIME_ROOT/server"
  NODE_ROOT="$RUNTIME_ROOT/runtime/bin"
  BRIDGE_ROOT="$RUNTIME_ROOT/bin"
  LEGAL_ROOT="$RUNTIME_ROOT/legal"
  NODE_SOURCE="${TAXI_BUNDLED_NODE:-$(command -v node || true)}"
  if [ -z "$NODE_SOURCE" ] || [ ! -x "$NODE_SOURCE" ]; then
    echo "✗ a Node executable is required to build the self-contained app" >&2
    exit 1
  fi
  mkdir -p "$SERVER_ROOT" "$NODE_ROOT" "$BRIDGE_ROOT" "$LEGAL_ROOT"
  cp -R "$PROJECT_DIR/dist" "$SERVER_ROOT/dist"
  cp "$PROJECT_DIR/package.json" "$PROJECT_DIR/package-lock.json" "$SERVER_ROOT/"
  cp -R "$PROJECT_DIR/vendor" "$SERVER_ROOT/vendor"
  if [ -f "$PROJECT_DIR/LICENSE" ]; then cp "$PROJECT_DIR/LICENSE" "$SERVER_ROOT/"; fi
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund --prefix "$SERVER_ROOT"
  "$SCRIPT_DIR/lib/embed-node-runtime.sh" "$NODE_SOURCE" "$RUNTIME_ROOT/runtime"
  NODE_REAL="$(realpath "$NODE_SOURCE")"
  NODE_LICENSE="$(dirname "$(dirname "$NODE_REAL")")/LICENSE"
  if [ ! -f "$NODE_LICENSE" ]; then
    echo "✗ embedded Node license not found beside runtime root: $NODE_LICENSE" >&2
    exit 1
  fi
  cp "$NODE_LICENSE" "$RUNTIME_ROOT/runtime/LICENSE"
  for legal_file in LICENSE SOURCE_PROVENANCE.md THIRD_PARTY_NOTICES.md; do
    if [ ! -f "$PROJECT_DIR/$legal_file" ]; then
      echo "✗ required legal file missing: $legal_file" >&2
      exit 1
    fi
    cp "$PROJECT_DIR/$legal_file" "$LEGAL_ROOT/$legal_file"
  done
  cp "$BRIDGE_BUILD_DIR/TaxiBridge" "$BRIDGE_ROOT/TaxiBridge"
  chmod 755 "$BRIDGE_ROOT/TaxiBridge"
  echo "  ✓ Embedded Node runtime, universal server, production dependencies, and Swift bridge"
fi

# Copy Info.plist with services declarations
if [ -f "$APP_DIR/Sources/TaxiApp/Resources/Info.plist" ]; then
  cp "$APP_DIR/Sources/TaxiApp/Resources/Info.plist" "$BUNDLE_DIR/Contents/Info.plist"
fi

# ── Build and embed WidgetKit extension ──
WIDGET_DIR="$APP_DIR/widget"
if [ "$TAXI_SKIP_WIDGET" = "1" ]; then
  echo "Skipping TaxiWidget extension (TAXI_SKIP_WIDGET=1)."
elif [ -f "$WIDGET_DIR/Package.swift" ]; then
  echo "Building TaxiWidget extension..."
  widget_built=0
  (cd "$WIDGET_DIR" && swift build -c release) 2>&1 && widget_built=1 || {
    if [ "$TAXI_REQUIRE_WIDGET" = "1" ]; then
      echo "✗ Widget build failed and TAXI_REQUIRE_WIDGET=1" >&2
      exit 1
    fi
    echo "⚠ Widget build failed — skipping widget extension"
  }

  if [ "$widget_built" -eq 1 ]; then
    WIDGET_BUILD_DIR="$(cd "$WIDGET_DIR" && swift build -c release --show-bin-path)"
    WIDGET_BIN="$WIDGET_BUILD_DIR/TaxiWidget"
  else
    WIDGET_BIN=""
  fi

  if [ -n "$WIDGET_BIN" ] && [ -f "$WIDGET_BIN" ]; then
    APPEX_DIR="$BUNDLE_DIR/Contents/PlugIns/TaxiWidget.appex/Contents"
    mkdir -p "$APPEX_DIR/MacOS"

    cp "$WIDGET_BIN" "$APPEX_DIR/MacOS/TaxiWidget"
    cp "$WIDGET_DIR/Info.plist" "$APPEX_DIR/Info.plist"
    /usr/libexec/PlistBuddy -c "Set :CFBundleShortVersionString $EXPECTED_VERSION" "$APPEX_DIR/Info.plist"
    /usr/libexec/PlistBuddy -c "Set :CFBundleVersion $BUILD_NUMBER" "$APPEX_DIR/Info.plist"

    # Copy resource bundle (localization strings)
    WIDGET_RESOURCE="$WIDGET_BUILD_DIR/TaxiWidget_TaxiWidget.bundle"
    if [ -d "$WIDGET_RESOURCE" ]; then
      mkdir -p "$APPEX_DIR/Resources"
      cp -R "$WIDGET_RESOURCE" "$APPEX_DIR/Resources/"
    fi

    # Sign the widget extension (required for WidgetKit).
    # app-group lets the widget READ the host app's shared WidgetSnapshot
    # container. Must match the main app's app-group below and
    # WidgetSnapshotConfig.appGroupID in Swift. calendars/reminders stay for the
    # OS-native EventKit fallback path when no fresh snapshot is present.
    /usr/bin/plutil -lint "$WIDGET_ENTITLEMENTS" >/dev/null
    codesign --force --sign "$SIGN_IDENTITY" \
      --entitlements "$WIDGET_ENTITLEMENTS" \
      "$WIDGET_APPEX"
    echo "  ✓ Widget extension embedded"
  fi
fi

if [ "$TAXI_REQUIRE_WIDGET" = "1" ]; then
  if [ ! -x "$WIDGET_APPEX/Contents/MacOS/TaxiWidget" ] || [ ! -f "$WIDGET_APPEX/Contents/Info.plist" ]; then
    echo "✗ signed distribution requires a complete TaxiWidget.appex" >&2
    exit 1
  fi
fi

# Add minimal required keys to Info.plist if it exists, or create one
PLIST="$BUNDLE_DIR/Contents/Info.plist"
if [ ! -f "$PLIST" ]; then
  cat > "$PLIST" << 'PLIST_EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
</dict>
</plist>
PLIST_EOF
fi

# Ensure required keys exist
/usr/libexec/PlistBuddy -c "Delete :CFBundleIdentifier" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundleIdentifier string $BUNDLE_ID" "$PLIST"
/usr/libexec/PlistBuddy -c "Delete :CFBundleExecutable" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundleExecutable string $APP_EXECUTABLE" "$PLIST"
/usr/libexec/PlistBuddy -c "Delete :CFBundleName" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundleName string $APP_EXECUTABLE" "$PLIST"
/usr/libexec/PlistBuddy -c "Delete :CFBundlePackageType" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundlePackageType string APPL" "$PLIST"
/usr/libexec/PlistBuddy -c "Delete :CFBundleShortVersionString" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundleShortVersionString string 1.0.0" "$PLIST"
/usr/libexec/PlistBuddy -c "Delete :CFBundleVersion" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :CFBundleVersion string $BUILD_NUMBER" "$PLIST"
/usr/libexec/PlistBuddy -c "Delete :LSUIElement" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :LSUIElement bool true" "$PLIST"
/usr/libexec/PlistBuddy -c "Delete :TaxiAcceptanceHarnessBuild" "$PLIST" 2>/dev/null || true
if [ "$ACCEPTANCE_HARNESS_BUILD" = "1" ]; then
  # Defense in depth for local release workflows: verification binaries have
  # test-only launch wiring and must never be signed or notarized as products.
  /usr/libexec/PlistBuddy -c "Add :TaxiAcceptanceHarnessBuild bool true" "$PLIST"
fi
/usr/libexec/PlistBuddy -c "Delete :NSMicrophoneUsageDescription" "$PLIST" 2>/dev/null || true
/usr/libexec/PlistBuddy -c "Add :NSMicrophoneUsageDescription string Taxi uses the microphone for speech recognition." "$PLIST"

# Sign embedded executable code before signing the main app.
if [ "$TAXI_EMBED_RUNTIME" = "1" ]; then
  while IFS= read -r -d '' dylib; do
    codesign --force --sign "$SIGN_IDENTITY" "$dylib"
  done < <(find "$BUNDLE_DIR/Contents/Resources/taxi/runtime/lib" -type f -name '*.dylib' -print0)
  codesign --force --sign "$SIGN_IDENTITY" "$BUNDLE_DIR/Contents/Resources/taxi/runtime/bin/node"
  codesign --force --sign "$SIGN_IDENTITY" "$BUNDLE_DIR/Contents/Resources/taxi/bin/TaxiBridge"
fi

# Sign the main app after embedding extensions and runtime executables. The
# canonical allowlist is also used for the Developer ID re-sign, so the ad-hoc
# and distribution identities cannot drift or promote development entitlements.
MAIN_APP_ENTITLEMENTS="$SCRIPT_DIR/lib/main-app-entitlements.plist"
codesign --force --sign "$SIGN_IDENTITY" \
  --entitlements "$MAIN_APP_ENTITLEMENTS" \
  "$BUNDLE_DIR"
if [ "$SIGN_IDENTITY" = "-" ]; then
  TAXI_EXPECTED_SIGNING_MODE=adhoc \
    "$SCRIPT_DIR/verify-bundle-structure.sh" "$BUNDLE_DIR" "$BUNDLE_ID" "$APP_EXECUTABLE"
else
  SIGNED_BUNDLE_INFO="$(codesign -dv --verbose=4 "$BUNDLE_DIR" 2>&1)"
  SIGNED_AUTHORITY="$(
    printf '%s\n' "$SIGNED_BUNDLE_INFO" | /usr/bin/sed -nE 's/^Authority=(.*)$/\1/p' | /usr/bin/head -1
  )"
  SIGNED_TEAM_ID="$(
    printf '%s\n' "$SIGNED_BUNDLE_INFO" |
      /usr/bin/sed -nE 's/^TeamIdentifier=([A-Z0-9]+)$/\1/p' |
      /usr/bin/head -1
  )"
  if [ -z "$SIGNED_AUTHORITY" ] || [ -z "$SIGNED_TEAM_ID" ]; then
    echo "✗ signed bundle identity could not be resolved after codesign" >&2
    exit 1
  fi
  TAXI_EXPECTED_SIGNING_MODE=identity \
    TAXI_EXPECTED_SIGNING_AUTHORITY="$SIGNED_AUTHORITY" \
    TAXI_EXPECTED_SIGNING_TEAM_ID="$SIGNED_TEAM_ID" \
    "$SCRIPT_DIR/verify-bundle-structure.sh" "$BUNDLE_DIR" "$BUNDLE_ID" "$APP_EXECUTABLE"
fi
if [ "$ACCEPTANCE_HARNESS_BUILD" = "0" ]; then
  register_bundle_with_launch_services
fi

find_matching_commands() {
  local match_mode="$1"
  local target="$2"
  local pid
  local command

  while read -r pid command; do
    case "$match_mode" in
      exact)
        if [ "$command" = "$target" ]; then echo "$pid $command"; fi
        ;;
      prefix)
        case "$command" in
          "$target"|"$target "*) echo "$pid $command" ;;
        esac
        ;;
      contains)
        case "$command" in
          *"$target"*) echo "$pid $command" ;;
        esac
        ;;
    esac
  done < <(ps -axo pid=,command=)
}

pid_matches_command() {
  local match_mode="$1"
  local pid="$2"
  local target="$3"
  local command

  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  command="$(ps -p "$pid" -o command= 2>/dev/null || true)"
  case "$match_mode" in
    exact) [ "$command" = "$target" ] ;;
    prefix)
      case "$command" in
        "$target"|"$target "*) return 0 ;;
        *) return 1 ;;
      esac
      ;;
    contains)
      case "$command" in
        *"$target"*) return 0 ;;
        *) return 1 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

process_birth_identity() {
  local pid="$1"
  local birth

  [[ "$pid" =~ ^[1-9][0-9]*$ ]] || return 1
  birth="$(LC_ALL=C ps -p "$pid" -o lstart= 2>/dev/null || true)"
  [ -n "$birth" ] || return 1
  printf '%s' "$birth"
}

capture_process_generation() {
  local match_mode="$1"
  local pid="$2"
  local target="$3"
  local birth

  pid_matches_command "$match_mode" "$pid" "$target" || return 1
  birth="$(process_birth_identity "$pid")" || return 1
  pid_matches_command "$match_mode" "$pid" "$target" || return 1
  printf '%s' "$birth"
}

pid_matches_generation() {
  local match_mode="$1"
  local pid="$2"
  local expected_birth="$3"
  local target="$4"
  local actual_birth

  pid_matches_command "$match_mode" "$pid" "$target" || return 1
  actual_birth="$(process_birth_identity "$pid")" || return 1
  [ "$actual_birth" = "$expected_birth" ] || return 1
  pid_matches_command "$match_mode" "$pid" "$target"
}

remember_attested_generation() {
  local match_mode="$1"
  local pid="$2"
  local birth="$3"
  local target="$4"
  local index

  for index in "${!ATTESTED_PIDS[@]}"; do
    if [ "${ATTESTED_PIDS[$index]}" = "$pid" ] && [ "${ATTESTED_BIRTHS[$index]}" = "$birth" ]; then
      return 0
    fi
  done
  ATTESTED_PIDS+=("$pid")
  ATTESTED_BIRTHS+=("$birth")
  ATTESTED_MODES+=("$match_mode")
  ATTESTED_TARGETS+=("$target")
}

terminate_attested_bundle_processes() {
  local index
  local pid
  local birth
  local match_mode
  local target

  for index in "${!ATTESTED_PIDS[@]}"; do
    pid="${ATTESTED_PIDS[$index]}"
    birth="${ATTESTED_BIRTHS[$index]}"
    match_mode="${ATTESTED_MODES[$index]}"
    target="${ATTESTED_TARGETS[$index]}"
    if pid_matches_generation "$match_mode" "$pid" "$birth" "$target"; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
    for _ in $(seq 1 "$PROCESS_SHUTDOWN_WAIT_STEPS"); do
      if ! pid_matches_generation "$match_mode" "$pid" "$birth" "$target"; then break; fi
      sleep 0.1
    done
    if pid_matches_generation "$match_mode" "$pid" "$birth" "$target"; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
}

assert_no_bundle_processes() {
  local bundled_runtime="$BUNDLE_DIR/Contents/Resources/taxi/runtime/bin/node $BUNDLE_DIR/Contents/Resources/taxi/server/dist/index.js run --http --port $APP_HTTP_PORT"
  local bundled_bridge="$BUNDLE_DIR/Contents/Resources/taxi/bin/TaxiBridge"
  local remaining=""
  remaining="$({
    find_matching_commands prefix "$APP_BINARY"
    find_matching_commands exact "$bundled_runtime"
    find_matching_commands prefix "$bundled_bridge"
    find_matching_commands contains "$PROJECT_DIR modules list --json"
  } | sed '/^[[:space:]]*$/d')"
  if [ -n "$remaining" ]; then
    echo "✗ governed verification left current-checkout processes running:" >&2
    echo "$remaining" >&2
    return 1
  fi
}

assert_no_bundle_processes_stably() {
  # A single empty process-table snapshot can miss a delayed supervisor restart.
  # Require a continuous two-second zero-process window before lifecycle proof
  # is accepted or the EXIT trap is allowed to clean anything up.
  for _ in $(seq 1 20); do
    if ! assert_no_bundle_processes; then return 1; fi
    sleep 0.1
  done
}

launch_app() {
  export TAXI_NPM_PACKAGE_SPECIFIER="${TAXI_NPM_PACKAGE_SPECIFIER:-$PROJECT_DIR}"
  case "$MODE" in
    verify|verify-governed|verify-soak|verify-appintents) export TAXI_FORCE_APP_RUNTIME=1 ;;
  esac
  if [ "$MODE" = "verify" ] || [ "$MODE" = "verify-governed" ] || [ "$MODE" = "verify-soak" ]; then
    if ! assert_no_bundle_processes_stably; then
      echo "✗ refusing verification while this exact bundle already has a process" >&2
      return 1
    fi
    # LaunchServices intentionally enforces the shipping bundle's single-
    # instance policy. Run the compile-time-gated acceptance binary directly
    # so an installed Taxi can remain untouched during local verification.
    VERIFICATION_LAUNCH_ATTEMPTED=1
    "$APP_BINARY" >/dev/null 2>&1 &
    LAUNCHED_APP_PID="$!"
  else
    # AppIntents verification must exercise LaunchServices registration.
    case "$MODE" in
      verify-appintents)
        if ! assert_no_bundle_processes_stably; then
          echo "✗ refusing verification while this exact bundle already has a process" >&2
          return 1
        fi
        VERIFICATION_LAUNCH_ATTEMPTED=1
        ;;
    esac
    /usr/bin/open -n "$BUNDLE_DIR"
  fi
}

allocate_acceptance_port() {
  node -e '
    const net = require("node:net");
    const server = net.createServer();
    server.once("error", (error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
    server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        console.error("failed to allocate a loopback port");
        process.exitCode = 1;
      } else {
        process.stdout.write(String(address.port));
      }
      server.close();
    });
  '
}

setup_acceptance_environment() {
  local state_prefix="${1:-taxi-signed-verify}"
  local env_name

  # A host override would make the acceptance surface depend on the developer's
  # shell. Clear inherited Taxi settings after the bundle is built, then
  # install only the isolated contract below.
  for env_name in $(env | awk -F= '/^TAXI_/ { print $1 }'); do
    unset "$env_name"
  done

  VERIFICATION_STATE_PARENT="${VERIFICATION_STATE_PARENT%/}"
  VERIFICATION_STATE_DIR="$(mktemp -d "$VERIFICATION_STATE_PARENT/$state_prefix.XXXXXX")"
  mkdir -p \
    "$VERIFICATION_STATE_DIR/home" \
    "$VERIFICATION_STATE_DIR/audit" \
    "$VERIFICATION_STATE_DIR/tmp"

  APP_HTTP_PORT="$(allocate_acceptance_port)"
  if ! [[ "$APP_HTTP_PORT" =~ ^[0-9]+$ ]] ||
    [ "$APP_HTTP_PORT" -lt 1024 ] || [ "$APP_HTTP_PORT" -gt 65535 ]; then
    echo "✗ failed to allocate an isolated acceptance port" >&2
    exit 1
  fi
  APP_HEALTH_URL="http://127.0.0.1:$APP_HTTP_PORT/health"
  APP_MCP_URL="http://127.0.0.1:$APP_HTTP_PORT/mcp"

  export HOME="$VERIFICATION_STATE_DIR/home"
  export CFFIXED_USER_HOME="$VERIFICATION_STATE_DIR/home"
  export TAXI_APP_RUNTIME_TOKEN_PATH="$VERIFICATION_STATE_DIR/http-token"
  export TAXI_APP_RUNTIME_OWNER_PATH="$VERIFICATION_STATE_DIR/runtime-owner-secret"
  export TAXI_FORCE_APP_RUNTIME="1"
  export TAXI_APP_RUNTIME_PORT="$APP_HTTP_PORT"
  export TAXI_NPM_PACKAGE_SPECIFIER="$PROJECT_DIR"
  # Release acceptance proves the complete bundled product surface rather than
  # the starter/progressive default shown to a fresh interactive user. These
  # compile-time-gated harness overrides are passed to the exact bundled child
  # and disappear with the isolated verification state.
  export TAXI_PROFILE="full"
  export TAXI_TOOL_EXPOSURE="full"
  export TAXI_MODULE_PACKS="all"
  TOKEN_FILE="$TAXI_APP_RUNTIME_TOKEN_PATH"
  OWNER_SECRET_FILE="$TAXI_APP_RUNTIME_OWNER_PATH"
}

setup_governed_environment() {
  local config_path

  setup_acceptance_environment "taxi-governed"
  config_path="$VERIFICATION_STATE_DIR/config.json"
  node -e '
    const fs = require("fs");
    const path = process.argv[1];
    const config = {
      profile: "full",
      toolExposure: "full",
      requireToolSession: false,
      hitl: { level: "off", whitelist: [], timeout: 5 }
    };
    fs.writeFileSync(path, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  ' "$config_path"

  # Swift reads the temp config and keeps its notification/socket UI off. The
  # Node child deliberately overrides HITL back to sensitive-only so the MCP
  # elicitation client exercises the production approval gate.
  export TAXI_CONFIG_PATH="$config_path"
  export TAXI_PROFILE="full"
  export TAXI_TOOL_EXPOSURE="full"
  export TAXI_MODULE_PACKS="all"
  export TAXI_REQUIRE_TOOL_SESSION="false"
  export TAXI_HITL_LEVEL="sensitive-only"
  export TAXI_HITL_SOCKET_PATH="$VERIFICATION_STATE_DIR/hitl.sock"
  export TAXI_MEMORY_STORE_PATH="$VERIFICATION_STATE_DIR/memory.json"
  export TAXI_VECTOR_STORE_DIR="$VERIFICATION_STATE_DIR/audit"
  export TAXI_USAGE_PROFILE_PATH="$VERIFICATION_STATE_DIR/usage.json"
  export TAXI_EMERGENCY_STOP_PATH="$VERIFICATION_STATE_DIR/emergency-stop"
  export TAXI_TEMP_DIR="$VERIFICATION_STATE_DIR/tmp"
  export TAXI_AUDIT_LOG="true"
  export TAXI_AUDIT_FLUSH_INTERVAL="25"
  export TAXI_AUDIT_HMAC_KEY
  TAXI_AUDIT_HMAC_KEY="$(node -e 'process.stdout.write(require("crypto").randomBytes(32).toString("hex"))')"
  export TAXI_RATE_LIMIT="true"
  export TAXI_ELICITATION_DISABLE="false"
}

verify_governed_workflow() {
  local output
  if ! output="$(
    node "$SCRIPT_DIR/verify-governed-workflow.mjs" \
      --url "$APP_MCP_URL" \
      --token-file "$TOKEN_FILE" \
      --memory-store "$TAXI_MEMORY_STORE_PATH" \
      --audit-dir "$TAXI_VECTOR_STORE_DIR" \
      --emergency-stop "$TAXI_EMERGENCY_STOP_PATH" \
      --timeout-ms 10000 2>&1
  )"; then
    echo "✗ governed workflow acceptance failed" >&2
    echo "$output" >&2
    exit 1
  fi
  echo "✓ $output"
}

wait_for_pid() {
  local pid=""
  local candidate
  local command
  for _ in $(seq 1 40); do
    if [ -n "$LAUNCHED_APP_PID" ]; then
      if pid_matches_command prefix "$LAUNCHED_APP_PID" "$APP_BINARY"; then
        echo "$LAUNCHED_APP_PID"
        return 0
      fi
      sleep 0.25
      continue
    fi
    pid=""
    while read -r candidate command; do
      case "$command" in
        "$APP_BINARY"|"$APP_BINARY "*)
          pid="$candidate"
          break
          ;;
      esac
    done < <(ps -axo pid=,command=)
    if [ -n "$pid" ]; then
      echo "$pid"
      return 0
    fi
    sleep 0.25
  done
  return 1
}

check_gatekeeper() {
  /usr/sbin/spctl --assess --type execute -vv "$BUNDLE_DIR" >/dev/null 2>&1
}

wait_for_http_runtime() {
  local health=""
  # A supervised replacement waits through Swift's 3s restart backoff and the
  # Node process's bounded 10s catalog warmup. Keep a 25s outer window so
  # scheduler delay cannot make an otherwise contract-compliant generation
  # look dead, while every returned listener still has to pass the authenticated
  # runtime and MCP checks below.
  for _ in $(seq 1 100); do
    health="$(curl -fsS --max-time 1 "$APP_HEALTH_URL" 2>/dev/null || true)"
    if [ -n "$health" ]; then
      echo "$health"
      return 0
    fi
    sleep 0.25
  done
  return 1
}

verify_app_owned_runtime() {
  local health
  local actual_version
  local credential_label
  local credential_path
  local credential_mode
  local credential_uid
  local current_uid
  local unauth_status
  local bundled_runtime
  local runtime_command
  local app_count
  local runtime_count

  health="$(wait_for_http_runtime)" || {
    echo "✗ app-owned HTTP runtime did not become healthy at $APP_HEALTH_URL" >&2
    exit 1
  }

  actual_version="$(
    node -e 'const health = JSON.parse(process.argv[1]); process.stdout.write(String(health.version ?? ""));' "$health"
  )"
  if [ "$actual_version" != "$EXPECTED_VERSION" ]; then
    echo "✗ app-owned runtime version mismatch: expected $EXPECTED_VERSION, got $actual_version" >&2
    exit 1
  fi
  echo "✓ App-owned runtime is healthy (v$actual_version)"

  current_uid="$(id -u)"
  for credential_label in "token" "owner secret"; do
    case "$credential_label" in
      token) credential_path="$TOKEN_FILE" ;;
      "owner secret") credential_path="$OWNER_SECRET_FILE" ;;
    esac
    if [ ! -f "$credential_path" ] || [ -L "$credential_path" ]; then
      echo "✗ app-owned runtime $credential_label must be a regular non-symlink file: $credential_path" >&2
      exit 1
    fi
    credential_mode="$(stat -f "%Lp" "$credential_path")"
    credential_uid="$(stat -f "%u" "$credential_path")"
    if [ "$credential_mode" != "600" ]; then
      echo "✗ app-owned runtime $credential_label permissions must be 600, got $credential_mode" >&2
      exit 1
    fi
    if [ "$credential_uid" != "$current_uid" ]; then
      echo "✗ app-owned runtime $credential_label must be owned by uid $current_uid, got $credential_uid" >&2
      exit 1
    fi
  done
  echo "✓ App-owned runtime token and owner secret are private current-user files (0600)"

  unauth_status="$(
    curl -sS --max-time 2 -o /dev/null -w "%{http_code}" \
      -X POST "$APP_MCP_URL" \
      -H "Content-Type: application/json" \
      --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"bundle-verify","version":"0"}}}' \
      2>/dev/null || true
  )"
  if [ "$unauth_status" != "401" ]; then
    echo "✗ unauthenticated /mcp request should return 401, got ${unauth_status:-no response}" >&2
    exit 1
  fi
  echo "✓ Unauthenticated /mcp request is rejected (401)"

  local probe_output
  if ! probe_output="$(
    node "$SCRIPT_DIR/probe-app-runtime.mjs" \
      --url "$APP_MCP_URL" \
      --owner-secret-file "$OWNER_SECRET_FILE" \
      --expected-version "$EXPECTED_VERSION" \
      --min-tools 1 \
      --timeout-ms 5000 2>&1
  )"; then
    echo "✗ app identity challenge or generation-authenticated MCP initialize/tools-list failed" >&2
    echo "$probe_output" >&2
    exit 1
  fi
  echo "✓ App identity challenge yields generation-authenticated MCP initialize + tools/list ($probe_output)"

  VERIFIED_RUNTIME_PID="$(
    printf '%s\n' "$probe_output" |
      /usr/bin/sed -nE 's/.*\(listener pid ([1-9][0-9]*)\).*/\1/p' |
      /usr/bin/tail -1
  )"
  bundled_runtime="$BUNDLE_DIR/Contents/Resources/taxi/runtime/bin/node $BUNDLE_DIR/Contents/Resources/taxi/server/dist/index.js run --http --port $APP_HTTP_PORT"
  runtime_command="$(ps -p "$VERIFIED_RUNTIME_PID" -o command= 2>/dev/null || true)"
  if [ -z "$VERIFIED_RUNTIME_PID" ] || [ "$runtime_command" != "$bundled_runtime" ]; then
    echo "✗ authenticated listener PID does not match this bundle's exact runtime command" >&2
    exit 1
  fi
  VERIFIED_RUNTIME_BIRTH="$(
    capture_process_generation exact "$VERIFIED_RUNTIME_PID" "$bundled_runtime"
  )" || {
    echo "✗ authenticated listener birth identity could not be captured" >&2
    exit 1
  }
  remember_attested_generation exact \
    "$VERIFIED_RUNTIME_PID" "$VERIFIED_RUNTIME_BIRTH" "$bundled_runtime"
  app_count="$(find_matching_commands prefix "$APP_BINARY" | awk 'END { print NR + 0 }')"
  runtime_count="$(find_matching_commands exact "$bundled_runtime" | awk 'END { print NR + 0 }')"
  if [ "$app_count" -ne 1 ] || [ "$runtime_count" -ne 1 ]; then
    echo "✗ verification requires exactly one native app and one authenticated runtime generation" >&2
    exit 1
  fi
}

verify_running() {
  local pid
  if ! check_gatekeeper; then
    echo "⚠ Gatekeeper rejected this local build." >&2
    echo "  AppIntents/Shortcuts registration may fail with ad-hoc signing." >&2
    echo "  Set TAXI_SIGN_IDENTITY to a valid signing identity for full verification." >&2
  fi

  launch_app
  pid="$(wait_for_pid)" || {
    echo "✗ $APP_EXECUTABLE did not start from $BUNDLE_DIR" >&2
    exit 1
  }
  VERIFIED_APP_PID="$pid"
  VERIFIED_APP_BIRTH="$(capture_process_generation prefix "$pid" "$APP_BINARY")" || {
    echo "✗ $APP_EXECUTABLE process birth identity could not be captured" >&2
    exit 1
  }
  remember_attested_generation prefix "$pid" "$VERIFIED_APP_BIRTH" "$APP_BINARY"

  echo "✓ $APP_EXECUTABLE is running (pid $pid)"
  ps -p "$pid" -o pid=,comm=,etime=

  local intent_predicate
  local intent_logs
  intent_predicate="process == \"$APP_EXECUTABLE\" AND "
  intent_predicate="$intent_predicate(eventMessage CONTAINS[c] \"Error registering app with intents\""
  intent_predicate="$intent_predicate OR eventMessage CONTAINS[c] \"linkd.autoShortcut\")"
  intent_logs="$(/usr/bin/log show --style compact --last 30s --predicate "$intent_predicate" 2>/dev/null || true)"
  if echo "$intent_logs" | grep -q "Error registering app with intents"; then
    echo "⚠ AppIntents registration failed in runtime logs." >&2
    echo "  This commonly happens for unsigned/ad-hoc local bundles." >&2
  fi

  verify_app_owned_runtime
}

run_app_runtime_soak() {
  local allow_short=()
  local output

  if [ "$SOAK_ALLOW_SHORT" = "1" ]; then
    allow_short+=(--allow-short-soak)
  fi
  if ! output="$(
    node "$SCRIPT_DIR/soak-app-runtime.mjs" \
      --url "$APP_MCP_URL" \
      --owner-secret-file "$OWNER_SECRET_FILE" \
      --expected-version "$EXPECTED_VERSION" \
      --app-pid "$VERIFIED_APP_PID" \
      --app-command "$APP_BINARY" \
      --app-birth "$VERIFIED_APP_BIRTH" \
      --runtime-pid "$VERIFIED_RUNTIME_PID" \
      --duration-seconds "$SOAK_DURATION_SECONDS" \
      --interval-seconds "$SOAK_INTERVAL_SECONDS" \
      --mcp-interval-seconds "$SOAK_MCP_INTERVAL_SECONDS" \
      --max-sustained-cpu "$SOAK_MAX_SUSTAINED_CPU" \
      --max-high-cpu-seconds "$SOAK_MAX_HIGH_CPU_SECONDS" \
      "${allow_short[@]}" 2>&1
  )"; then
    echo "✗ app-owned runtime soak failed" >&2
    echo "$output" >&2
    exit 1
  fi
  echo "✓ App-owned runtime soak passed ($output)"
}

verify_graceful_app_shutdown() {
  local app_running=1
  local runtime_running=1
  local bundled_runtime="$BUNDLE_DIR/Contents/Resources/taxi/runtime/bin/node $BUNDLE_DIR/Contents/Resources/taxi/server/dist/index.js run --http --port $APP_HTTP_PORT"

  if ! [[ "$VERIFIED_APP_PID" =~ ^[1-9][0-9]*$ ]] ||
    ! [[ "$VERIFIED_RUNTIME_PID" =~ ^[1-9][0-9]*$ ]]; then
    echo "✗ app shutdown proof is missing authenticated process identities" >&2
    exit 1
  fi
  if ! pid_matches_generation prefix \
    "$VERIFIED_APP_PID" "$VERIFIED_APP_BIRTH" "$APP_BINARY" ||
    ! pid_matches_generation exact \
      "$VERIFIED_RUNTIME_PID" "$VERIFIED_RUNTIME_BIRTH" "$bundled_runtime"; then
    echo "✗ app shutdown proof lost its attested process generations" >&2
    exit 1
  fi
  if ! /usr/bin/osascript -l JavaScript "$SCRIPT_DIR/request-app-termination.js" \
    "$VERIFIED_APP_PID" "$APP_BINARY" >/dev/null; then
    echo "✗ Taxi rejected normal AppKit termination" >&2
    exit 1
  fi

  for _ in $(seq 1 80); do
    if ! pid_matches_generation prefix \
      "$VERIFIED_APP_PID" "$VERIFIED_APP_BIRTH" "$APP_BINARY"; then app_running=0; fi
    if ! pid_matches_generation exact \
      "$VERIFIED_RUNTIME_PID" "$VERIFIED_RUNTIME_BIRTH" "$bundled_runtime"; then runtime_running=0; fi
    if [ "$app_running" -eq 0 ] && [ "$runtime_running" -eq 0 ]; then break; fi
    sleep 0.1
  done

  if [ "$app_running" -ne 0 ]; then
    echo "✗ Taxi did not exit after its normal AppKit termination request" >&2
    exit 1
  fi
  if [ "$runtime_running" -ne 0 ]; then
    echo "✗ Taxi exited but left its authenticated app-owned runtime running" >&2
    exit 1
  fi
  if ! assert_no_bundle_processes_stably; then
    echo "✗ Taxi normal shutdown left a current-checkout child process behind" >&2
    exit 1
  fi
  LIFECYCLE_SHUTDOWN_VERIFIED=1
  echo "✓ Normal AppKit termination stopped Taxi and its authenticated runtime"
}

verify_runtime_sigterm_restart() {
  local old_runtime_pid="$VERIFIED_RUNTIME_PID"
  local old_runtime_birth="$VERIFIED_RUNTIME_BIRTH"
  local new_runtime_pid=""
  local old_runtime_running=1
  local bundled_runtime="$BUNDLE_DIR/Contents/Resources/taxi/runtime/bin/node $BUNDLE_DIR/Contents/Resources/taxi/server/dist/index.js run --http --port $APP_HTTP_PORT"

  if ! [[ "$VERIFIED_APP_PID" =~ ^[1-9][0-9]*$ ]] ||
    ! [[ "$old_runtime_pid" =~ ^[1-9][0-9]*$ ]]; then
    echo "✗ runtime restart proof is missing authenticated process identities" >&2
    exit 1
  fi
  if ! pid_matches_generation prefix \
    "$VERIFIED_APP_PID" "$VERIFIED_APP_BIRTH" "$APP_BINARY"; then
    echo "✗ runtime restart proof lost the verified Taxi app process" >&2
    exit 1
  fi
  if ! pid_matches_generation exact \
    "$old_runtime_pid" "$old_runtime_birth" "$bundled_runtime"; then
    echo "✗ runtime restart proof lost the authenticated Node generation" >&2
    exit 1
  fi

  # This harness observes the old generation disappear and a new authenticated
  # generation replace it; the Swift supervisor unit tests separately own exit
  # status semantics. Revalidate command + birth immediately before signalling
  # so this never targets a recycled or unrelated PID.
  if pid_matches_generation exact "$old_runtime_pid" "$old_runtime_birth" "$bundled_runtime"; then
    kill -TERM "$old_runtime_pid"
  else
    echo "✗ runtime generation changed before the restart signal" >&2
    exit 1
  fi

  for _ in $(seq 1 80); do
    if ! pid_matches_generation exact \
      "$old_runtime_pid" "$old_runtime_birth" "$bundled_runtime"; then
      old_runtime_running=0
      break
    fi
    sleep 0.1
  done
  if [ "$old_runtime_running" -ne 0 ]; then
    echo "✗ graceful SIGTERM did not stop the authenticated Node generation" >&2
    exit 1
  fi
  if ! pid_matches_generation prefix \
    "$VERIFIED_APP_PID" "$VERIFIED_APP_BIRTH" "$APP_BINARY"; then
    echo "✗ Taxi app exited while its runtime was restarting" >&2
    exit 1
  fi

  VERIFIED_RUNTIME_PID=""
  verify_app_owned_runtime
  new_runtime_pid="$VERIFIED_RUNTIME_PID"
  if [ "$new_runtime_pid" = "$old_runtime_pid" ]; then
    echo "✗ runtime restart did not produce a distinct authenticated PID generation" >&2
    exit 1
  fi
  if ! pid_matches_generation exact \
    "$new_runtime_pid" "$VERIFIED_RUNTIME_BIRTH" "$bundled_runtime"; then
    echo "✗ restarted runtime does not match this bundle's exact command" >&2
    exit 1
  fi
  echo "✓ SIGTERM runtime generation restart recovered as authenticated generation $new_runtime_pid"
}

verify_app_crash_cleanup() {
  local app_running=1
  local runtime_running=1
  local bundled_runtime="$BUNDLE_DIR/Contents/Resources/taxi/runtime/bin/node $BUNDLE_DIR/Contents/Resources/taxi/server/dist/index.js run --http --port $APP_HTTP_PORT"

  # Kill only the exact acceptance app generation proven above. This models a
  # native crash where applicationWillTerminate cannot notify the child; the
  # app-owned Node watchdog must notice reparenting and shut itself down.
  if ! pid_matches_generation prefix \
    "$VERIFIED_APP_PID" "$VERIFIED_APP_BIRTH" "$APP_BINARY"; then
    echo "✗ crash cleanup proof lost the verified Taxi app process" >&2
    exit 1
  fi
  if ! pid_matches_generation exact \
    "$VERIFIED_RUNTIME_PID" "$VERIFIED_RUNTIME_BIRTH" "$bundled_runtime"; then
    echo "✗ crash cleanup proof lost the authenticated runtime generation" >&2
    exit 1
  fi
  # Re-read the exact command immediately before the destructive signal. The
  # earlier two-process preflight is an invariant check, not a durable PID
  # generation receipt; PID reuse between it and this line must fail closed.
  if pid_matches_generation prefix \
    "$VERIFIED_APP_PID" "$VERIFIED_APP_BIRTH" "$APP_BINARY"; then
    kill -KILL "$VERIFIED_APP_PID"
  else
    echo "✗ crash cleanup proof lost the verified Taxi app before signal" >&2
    exit 1
  fi

  # Parent watchdog interval (1s) + process-wide graceful shutdown budget
  # (5s), with margin for scheduler delay.
  for _ in $(seq 1 80); do
    if ! pid_matches_generation prefix \
      "$VERIFIED_APP_PID" "$VERIFIED_APP_BIRTH" "$APP_BINARY"; then app_running=0; fi
    if ! pid_matches_generation exact \
      "$VERIFIED_RUNTIME_PID" "$VERIFIED_RUNTIME_BIRTH" "$bundled_runtime"; then runtime_running=0; fi
    if [ "$app_running" -eq 0 ] && [ "$runtime_running" -eq 0 ]; then break; fi
    sleep 0.1
  done

  if [ "$app_running" -ne 0 ]; then
    echo "✗ verified Taxi app survived the crash injection" >&2
    exit 1
  fi
  if [ "$runtime_running" -ne 0 ]; then
    echo "✗ app crash left its authenticated app-owned runtime orphaned" >&2
    exit 1
  fi
  if ! assert_no_bundle_processes_stably; then
    echo "✗ app crash cleanup left a current-checkout child process behind" >&2
    exit 1
  fi
  LIFECYCLE_SHUTDOWN_VERIFIED=1
  echo "✓ App crash caused the authenticated app-owned runtime to self-terminate"
}

verify_appintents() {
  if ! check_gatekeeper; then
    echo "✗ Gatekeeper rejected $BUNDLE_DIR; AppIntents registration is not trustworthy." >&2
    exit 1
  fi

  launch_app
  VERIFIED_APP_PID="$(wait_for_pid)" || {
    echo "✗ $APP_EXECUTABLE did not start from $BUNDLE_DIR" >&2
    exit 1
  }
  VERIFIED_APP_BIRTH="$(
    capture_process_generation prefix "$VERIFIED_APP_PID" "$APP_BINARY"
  )" || {
    echo "✗ $APP_EXECUTABLE process birth identity could not be captured" >&2
    exit 1
  }
  remember_attested_generation prefix \
    "$VERIFIED_APP_PID" "$VERIFIED_APP_BIRTH" "$APP_BINARY"
  verify_app_owned_runtime
  sleep 2

  local intent_predicate
  local intent_logs
  intent_predicate="process == \"$APP_EXECUTABLE\" AND "
  intent_predicate="$intent_predicate(eventMessage CONTAINS[c] \"Error registering app with intents\""
  intent_predicate="$intent_predicate OR eventMessage CONTAINS[c] \"linkd.autoShortcut\")"
  intent_logs="$(/usr/bin/log show --style compact --last 30s --predicate "$intent_predicate" 2>/dev/null || true)"
  if echo "$intent_logs" | grep -q "Error registering app with intents"; then
    echo "✗ AppIntents registration failed in runtime logs." >&2
    echo "$intent_logs" >&2
    exit 1
  fi

  echo "✓ AppIntents registration did not emit runtime errors."
}

cleanup_verification() {
  local original_status=$?
  local cleanup_failed=0
  local state_dir="$VERIFICATION_STATE_DIR"

  if [ "$original_status" -eq 0 ] && [ "$LIFECYCLE_SHUTDOWN_VERIFIED" -ne 1 ]; then
    echo "✗ verification ended without proving app/runtime lifecycle cleanup" >&2
    cleanup_failed=1
  fi

  if [ "$original_status" -eq 0 ] &&
    [ "$LIFECYCLE_SHUTDOWN_VERIFIED" -eq 1 ] &&
    ! assert_no_bundle_processes_stably; then
    echo "✗ a delayed current-checkout process appeared after lifecycle verification" >&2
    cleanup_failed=1
  fi

  if [ "$VERIFICATION_LAUNCH_ATTEMPTED" -eq 1 ]; then
    # Signal only PID + command + birth generations authenticated by this
    # invocation. A foreign/raced same-path process remains a gate failure and
    # is never reclassified as owned merely because its argv matches.
    terminate_attested_bundle_processes
    if ! assert_no_bundle_processes; then cleanup_failed=1; fi
  fi
  # `open` registers launched bundles even when this script skips its explicit
  # registration step. Remove the hidden acceptance path so a later
  # `open -b app.taxi` cannot select test-only launch wiring over the
  # installed production app.
  if [ "$ACCEPTANCE_HARNESS_BUILD" = "1" ] && [ -x "$LSREGISTER" ]; then
    if ! "$LSREGISTER" -u "$BUNDLE_DIR" >/dev/null 2>&1; then
      echo "✗ Failed to unregister acceptance-harness bundle: $BUNDLE_DIR" >&2
      cleanup_failed=1
    fi
  fi

  if [ -n "$state_dir" ]; then
    case "$state_dir" in
      "$VERIFICATION_STATE_PARENT"/taxi-governed.*|\
      "$VERIFICATION_STATE_PARENT"/taxi-signed-verify.*|\
      "$VERIFICATION_STATE_PARENT"/taxi-soak.*)
        if ! rm -rf "$state_dir"; then cleanup_failed=1; fi
        if [ -e "$state_dir" ]; then
          echo "✗ governed verification left temporary state behind: $state_dir" >&2
          cleanup_failed=1
        fi
        ;;
      *)
        echo "✗ Refusing to remove unexpected governed state path: $state_dir" >&2
        cleanup_failed=1
        ;;
    esac
  fi

  trap - EXIT
  if [ "$original_status" -ne 0 ]; then exit "$original_status"; fi
  if [ "$cleanup_failed" -ne 0 ]; then exit 1; fi
  exit 0
}

case "$MODE" in
  verify|verify-governed|verify-soak|verify-appintents)
    # Verification is non-interactive: never leave an app-owned Node process
    # listening after success or an early failure.
    trap cleanup_verification EXIT
    ;;
esac

echo ""
echo "✓ Taxi.app created at: $BUNDLE_DIR"
echo "  Run with: open $BUNDLE_DIR"
echo "  Or:       $APP_BINARY"

case "$MODE" in
  bundle)
    ;;
  run)
    launch_app
    echo "✓ Launched $APP_EXECUTABLE"
    ;;
  verify)
    setup_acceptance_environment
    verify_running
    verify_runtime_sigterm_restart
    verify_graceful_app_shutdown
    ;;
  verify-governed)
    setup_governed_environment
    verify_running
    verify_runtime_sigterm_restart
    verify_governed_workflow
    verify_graceful_app_shutdown
    ;;
  verify-soak)
    setup_acceptance_environment "taxi-soak"
    verify_running
    verify_runtime_sigterm_restart
    run_app_runtime_soak
    verify_app_crash_cleanup
    ;;
  verify-appintents)
    verify_appintents
    verify_graceful_app_shutdown
    ;;
  logs)
    launch_app
    wait_for_pid >/dev/null || {
      echo "✗ $APP_EXECUTABLE did not start from $BUNDLE_DIR" >&2
      exit 1
    }
    /usr/bin/log stream --info --style compact --predicate "process == \"$APP_EXECUTABLE\""
    ;;
  telemetry)
    launch_app
    wait_for_pid >/dev/null || {
      echo "✗ $APP_EXECUTABLE did not start from $BUNDLE_DIR" >&2
      exit 1
    }
    /usr/bin/log stream --info --style compact --predicate "subsystem == \"$BUNDLE_ID\""
    ;;
  debug)
    pid="$(verify_running | awk '/is running/ {print $6}' | tr -d ')')" || exit 1
    exec lldb -p "$pid"
    ;;
esac
