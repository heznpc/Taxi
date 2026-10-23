#!/bin/bash
# Verify an already-built, already-notarized Taxi.app artifact without
# rebuilding it. This is the final distribution gate after notarization.

set -euo pipefail

# shellcheck source=scripts/lib/signing-identity.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/signing-identity.sh"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
APP_BUNDLE="${APP_BUNDLE_PATH:-$PROJECT_DIR/Taxi.app}"
APP_EXECUTABLE="Taxi"
APP_BINARY="$APP_BUNDLE/Contents/MacOS/$APP_EXECUTABLE"
APP_PORT=3848
APP_HEALTH_URL="http://127.0.0.1:$APP_PORT/health"
APP_IDENTITY_CHALLENGE_URL="http://127.0.0.1:$APP_PORT/app/identity-challenge"
APP_RUNTIME_STATE_URL="http://127.0.0.1:$APP_PORT/app/runtime-state"
APP_MCP_URL="http://127.0.0.1:$APP_PORT/mcp"
RUNTIME_NODE="$APP_BUNDLE/Contents/Resources/taxi/runtime/bin/node"
RUNTIME_ENTRY="$APP_BUNDLE/Contents/Resources/taxi/server/dist/index.js"
RUNTIME_COMMAND="$RUNTIME_NODE $RUNTIME_ENTRY run --http --port $APP_PORT"
BRIDGE_BINARY="$APP_BUNDLE/Contents/Resources/taxi/bin/TaxiBridge"
EXPECTED_VERSION=""
STATE_PARENT="${TMPDIR:-/tmp}"
STATE_PARENT="${STATE_PARENT%/}"
STATE_DIR=""
CURRENT_HOME=""
CURRENT_CONFIG_FILE=""
CURRENT_TOKEN_FILE=""
CURRENT_OWNER_FILE=""
CURRENT_HEALTH_FILE=""
CURRENT_RUNTIME_STATE_FILE=""
CURRENT_APP_PID=""
CURRENT_APP_BIRTH=""
CURRENT_RUNTIME_PID=""
CURRENT_RUNTIME_BIRTH=""
FIRST_HOME=""
FIRST_CONFIG_FILE=""
FIRST_TOKEN_FILE=""
FIRST_OWNER_FILE=""
FIRST_RUNTIME_STATE_FILE=""
NORMAL_SHUTDOWN_VERIFIED=0
SIGTERM_RESTART_VERIFIED=0
SOAK_VERIFIED=0
CRASH_SHUTDOWN_VERIFIED=0
FINAL_ZERO_VERIFIED=0
ARTIFACT_LAUNCH_ATTEMPTED=0
ATTESTED_PIDS=()
ATTESTED_BIRTHS=()
ATTESTED_MODES=()
ATTESTED_TARGETS=()

# Capture harness controls before stripping TAXI_* from the app's production
# launch environment. A short run is deliberately non-release evidence.
SIGNED_SOAK_DURATION_SECONDS="${TAXI_SIGNED_SOAK_DURATION_SECONDS:-3600}"
SIGNED_SOAK_INTERVAL_SECONDS="${TAXI_SIGNED_SOAK_INTERVAL_SECONDS:-5}"
SIGNED_SOAK_MCP_INTERVAL_SECONDS="${TAXI_SIGNED_SOAK_MCP_INTERVAL_SECONDS:-60}"
SIGNED_SOAK_MAX_SUSTAINED_CPU="${TAXI_SIGNED_SOAK_MAX_SUSTAINED_CPU:-80}"
SIGNED_SOAK_MAX_HIGH_CPU_SECONDS="${TAXI_SIGNED_SOAK_MAX_HIGH_CPU_SECONDS:-60}"
SIGNED_ALLOW_SHORT_SOAK="${TAXI_SIGNED_ALLOW_SHORT_SOAK:-0}"

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
  # Close the ps snapshot race: the command must still belong to the same PID
  # after its kernel birth identity has been read.
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

find_artifact_processes() {
  local pid
  local command

  while read -r pid command; do
    case "$command" in
      "$APP_BINARY"|"$APP_BINARY "*) printf '%s\tapp\t%s\n' "$pid" "$command" ;;
      "$RUNTIME_NODE"|"$RUNTIME_NODE "*) printf '%s\truntime\t%s\n' "$pid" "$command" ;;
      "$BRIDGE_BINARY"|"$BRIDGE_BINARY "*) printf '%s\tbridge\t%s\n' "$pid" "$command" ;;
    esac
  done < <(ps -axo pid=,command=)
}

assert_no_artifact_processes() {
  local remaining
  remaining="$(find_artifact_processes)"
  if [ -n "$remaining" ]; then
    echo "verify-signed-app: exact artifact still has app/runtime/bridge processes:" >&2
    printf '%s\n' "$remaining" >&2
    return 1
  fi
}

assert_no_artifact_processes_stably() {
  # A single empty process-table snapshot can miss a delayed supervisor
  # restart. Require a continuous two-second zero-process window.
  for _ in $(seq 1 20); do
    if ! assert_no_artifact_processes; then return 1; fi
    sleep 0.1
  done
}

terminate_attested_artifact_processes() {
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
    for _ in $(seq 1 70); do
      if ! pid_matches_generation "$match_mode" "$pid" "$birth" "$target"; then break; fi
      sleep 0.1
    done
    if pid_matches_generation "$match_mode" "$pid" "$birth" "$target"; then
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
}

cleanup() {
  local original_status=$?
  local cleanup_failed=0

  # Success is evaluated before any destructive cleanup. This ensures a
  # delayed restart or orphan makes the gate fail instead of being erased by
  # the EXIT trap and mistaken for lifecycle proof.
  if [ "$original_status" -eq 0 ]; then
    if [ "$NORMAL_SHUTDOWN_VERIFIED" -ne 1 ] ||
      [ "$SIGTERM_RESTART_VERIFIED" -ne 1 ] ||
      [ "$SOAK_VERIFIED" -ne 1 ] ||
      [ "$CRASH_SHUTDOWN_VERIFIED" -ne 1 ]; then
      echo "verify-signed-app: verification ended without both lifecycle proofs and soak evidence" >&2
      cleanup_failed=1
    elif ! assert_no_artifact_processes_stably; then
      echo "verify-signed-app: a delayed exact-artifact process appeared after lifecycle verification" >&2
      cleanup_failed=1
    else
      FINAL_ZERO_VERIFIED=1
    fi
  fi

  # Emergency cleanup is permitted only after the success decision above and
  # only if this invocation crossed its launch boundary. A preflight refusal
  # must never terminate an exact artifact that was already running.
  if [ "$ARTIFACT_LAUNCH_ATTEMPTED" -eq 1 ]; then
    # Only PID + command + birth identities authenticated by this invocation
    # may be signalled. A raced same-path process stays alive and keeps the gate
    # red; cleanup must never turn path equality into process ownership.
    terminate_attested_artifact_processes
    if ! assert_no_artifact_processes; then cleanup_failed=1; fi
  fi

  if [ -n "$STATE_DIR" ]; then
    case "$STATE_DIR" in
      "$STATE_PARENT"/taxi-signed-verify.*)
        if ! rm -rf "$STATE_DIR"; then cleanup_failed=1; fi
        ;;
      *)
        echo "verify-signed-app: refusing to remove unexpected state path" >&2
        cleanup_failed=1
        ;;
    esac
  fi

  trap - EXIT
  if [ "$original_status" -ne 0 ]; then exit "$original_status"; fi
  if [ "$cleanup_failed" -ne 0 ] || [ "$FINAL_ZERO_VERIFIED" -ne 1 ]; then exit 1; fi
  exit 0
}

prepare_generation() {
  local generation="$1"

  CURRENT_HOME="$STATE_DIR/$generation/home"
  CURRENT_CONFIG_FILE="$CURRENT_HOME/.config/taxi/config.json"
  CURRENT_TOKEN_FILE="$CURRENT_HOME/Library/Application Support/Taxi/http-token"
  CURRENT_OWNER_FILE="$CURRENT_HOME/Library/Application Support/Taxi/runtime-owner-secret"
  CURRENT_HEALTH_FILE="$STATE_DIR/$generation-health.json"
  CURRENT_RUNTIME_STATE_FILE="$STATE_DIR/$generation-runtime-state.json"
  CURRENT_APP_PID=""
  CURRENT_APP_BIRTH=""
  CURRENT_RUNTIME_PID=""
  CURRENT_RUNTIME_BIRTH=""

  mkdir -p \
    "$CURRENT_HOME/.config/taxi" \
    "$CURRENT_HOME/Library/Application Support/Taxi" \
    "$CURRENT_HOME/Library/Preferences"
  chmod 700 \
    "$CURRENT_HOME" \
    "$CURRENT_HOME/.config" \
    "$CURRENT_HOME/.config/taxi" \
    "$CURRENT_HOME/Library" \
    "$CURRENT_HOME/Library/Application Support" \
    "$CURRENT_HOME/Library/Application Support/Taxi" \
    "$CURRENT_HOME/Library/Preferences"

  umask 077
  printf '%s\n' \
    '{' \
    '  "profile": "full",' \
    '  "toolExposure": "full",' \
    '  "disabledModules": [],' \
    '  "requireToolSession": false,' \
    '  "hitl": { "level": "off", "whitelist": [], "timeout": 5 },' \
    '  "features": { "auditLog": false, "usageTracking": false }' \
    '}' > "$CURRENT_CONFIG_FILE"
  chmod 600 "$CURRENT_CONFIG_FILE"

  /usr/bin/defaults write "$CURRENT_HOME/Library/Preferences/app.taxi" \
    autoStartServer -bool true
  /usr/bin/defaults write "$CURRENT_HOME/Library/Preferences/app.taxi" \
    onboardingPresented -bool true
}

launch_current_generation() {
  local candidate_pid
  local candidate_command
  local app_count

  if ! assert_no_artifact_processes_stably; then
    echo "verify-signed-app: refusing launch while this exact artifact is already running" >&2
    return 1
  fi

  ARTIFACT_LAUNCH_ATTEMPTED=1
  if ! /usr/bin/open -n \
    --env "HOME=$CURRENT_HOME" \
    --env "CFFIXED_USER_HOME=$CURRENT_HOME" \
    "$APP_BUNDLE" >/dev/null 2>&1; then
    echo "verify-signed-app: isolated artifact launch request failed" >&2
    return 1
  fi

  for _ in $(seq 1 80); do
    app_count=0
    CURRENT_APP_PID=""
    while read -r candidate_pid candidate_command; do
      case "$candidate_command" in
        "$APP_BINARY"|"$APP_BINARY "*)
          app_count=$((app_count + 1))
          CURRENT_APP_PID="$candidate_pid"
          ;;
      esac
    done < <(ps -axo pid=,command=)
    if [ "$app_count" -gt 1 ]; then
      echo "verify-signed-app: exact artifact launched more than one native app process" >&2
      return 1
    fi
    if [ "$app_count" -eq 1 ] && pid_matches_command prefix "$CURRENT_APP_PID" "$APP_BINARY"; then
      CURRENT_APP_BIRTH="$(capture_process_generation prefix "$CURRENT_APP_PID" "$APP_BINARY")" || {
        echo "verify-signed-app: native app generation birth identity could not be captured" >&2
        return 1
      }
      remember_attested_generation prefix "$CURRENT_APP_PID" "$CURRENT_APP_BIRTH" "$APP_BINARY"
      return 0
    fi
    sleep 0.25
  done

  echo "verify-signed-app: the requested app artifact did not launch" >&2
  return 1
}

verify_private_credential() {
  local path="$1"
  local label="$2"
  local expected_pattern="$3"
  local current_uid
  local actual_uid
  local actual_mode

  current_uid="$(id -u)"
  if [ ! -f "$path" ] || [ -L "$path" ]; then
    echo "verify-signed-app: $label must be a regular non-symlink file" >&2
    return 1
  fi
  actual_uid="$(stat -f '%u' "$path")"
  actual_mode="$(stat -f '%Lp' "$path")"
  if [ "$actual_uid" != "$current_uid" ] || [ "$actual_mode" != "600" ]; then
    echo "verify-signed-app: $label must be current-user-owned with mode 0600" >&2
    return 1
  fi
  if ! node -e '
    const fs = require("fs");
    const value = fs.readFileSync(process.argv[1], "utf8").trim();
    if (!(new RegExp(process.argv[2])).test(value)) process.exit(1);
  ' "$path" "$expected_pattern"; then
    echo "verify-signed-app: $label is empty or malformed" >&2
    return 1
  fi
}

wait_for_current_runtime_receipt() {
  for _ in $(seq 1 120); do
    if [ -s "$CURRENT_TOKEN_FILE" ] && [ -s "$CURRENT_OWNER_FILE" ]; then
      curl -fsS --max-time 1 "$APP_HEALTH_URL" -o "$CURRENT_HEALTH_FILE" 2>/dev/null || true
      node --input-type=module - \
        "$CURRENT_OWNER_FILE" "$CURRENT_TOKEN_FILE" "$APP_IDENTITY_CHALLENGE_URL" \
        "$APP_RUNTIME_STATE_URL" "$CURRENT_RUNTIME_STATE_FILE" "$EXPECTED_VERSION" <<'NODE' \
        >/dev/null 2>&1 || true
        import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
        import { readFileSync, writeFileSync } from "node:fs";
        const [ownerPath, tokenPath, challengeBase, stateUrl, outputPath, expectedVersion] = process.argv.slice(2);
        const owner = readFileSync(ownerPath, "utf8").trim();
        const nonce = randomBytes(32).toString("base64url");
        const challengeUrl = new URL(challengeBase);
        challengeUrl.searchParams.set("nonce", nonce);
        const challengeResponse = await fetch(challengeUrl, { signal: AbortSignal.timeout(1_000) });
        if (!challengeResponse.ok) process.exit(2);
        const challenge = await challengeResponse.json();
        if (challenge.status !== "ok" || challenge.appOwned !== true || challenge.version !== expectedVersion ||
            !Number.isSafeInteger(challenge.pid) || challenge.pid < 2 || !/^[0-9a-f]{64}$/.test(challenge.proof) ||
            challenge.responseProof !== "hmac-sha256-v1") process.exit(3);
        const expectedProof = Buffer.from(createHmac("sha256", owner)
          .update(`taxi-app-listener-v1\n${nonce}\n${challenge.pid}\n${challenge.version}`)
          .digest("hex"), "hex");
        const actualProof = Buffer.from(challenge.proof, "hex");
        if (actualProof.length !== expectedProof.length || !timingSafeEqual(actualProof, expectedProof)) process.exit(4);
        const generationToken = `taxi_app_${createHmac("sha256", owner)
          .update(`taxi-app-generation-bearer-v1\n${challenge.pid}\n${challenge.version}`)
          .digest("hex")}`;
        const response = await fetch(stateUrl, {
          headers: { Authorization: `Bearer ${generationToken}` },
          signal: AbortSignal.timeout(1_000),
        });
        if (!response.ok) process.exit(5);
        const state = await response.json();
        const token = readFileSync(tokenPath, "utf8").trim();
        const tokenFingerprint = createHash("sha256").update(`taxi-runtime-token-v1\n${token}`).digest("hex");
        if (state.pid !== challenge.pid || state.tokenFingerprint !== tokenFingerprint) process.exit(6);
        writeFileSync(outputPath, JSON.stringify(state), { mode: 0o600 });
NODE
      if [ -s "$CURRENT_HEALTH_FILE" ] && [ -s "$CURRENT_RUNTIME_STATE_FILE" ]; then return 0; fi
    fi
    sleep 0.25
  done
  return 1
}

verify_current_generation() {
  local unauth_status
  local app_count
  local runtime_count
  local probe_output

  if ! wait_for_current_runtime_receipt; then
    echo "verify-signed-app: app-owned runtime did not produce an authenticated generation receipt" >&2
    return 1
  fi
  verify_private_credential "$CURRENT_CONFIG_FILE" "isolated config" '^\{' || return 1
  verify_private_credential "$CURRENT_TOKEN_FILE" "isolated runtime token" '^[A-Za-z0-9_-]{32,}$' || return 1
  verify_private_credential "$CURRENT_OWNER_FILE" "isolated runtime owner secret" '^[A-Za-z0-9_-]{43}$' || return 1

  CURRENT_RUNTIME_PID="$(node - \
    "$CURRENT_HEALTH_FILE" "$CURRENT_RUNTIME_STATE_FILE" "$CURRENT_OWNER_FILE" \
    "$CURRENT_TOKEN_FILE" "$EXPECTED_VERSION" <<'NODE'
    const { createHash } = require("crypto");
    const { readFileSync } = require("fs");
    const [healthPath, statePath, ownerPath, tokenPath, expectedVersion] = process.argv.slice(2);
    const health = JSON.parse(readFileSync(healthPath, "utf8"));
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    const owner = readFileSync(ownerPath, "utf8").trim();
    const token = readFileSync(tokenPath, "utf8").trim();
    const ownerFingerprint = createHash("sha256").update(`taxi-app-owner-v1\n${owner}`).digest("hex");
    const tokenFingerprint = createHash("sha256").update(`taxi-runtime-token-v1\n${token}`).digest("hex");
    if (health.status !== "ok" || health.version !== expectedVersion || health.appOwned !== true) process.exit(2);
    if (state.status !== "ok" || state.version !== expectedVersion || state.appOwned !== true) process.exit(3);
    if (!Number.isSafeInteger(state.pid) || state.pid < 2 || state.ownerFingerprint !== ownerFingerprint ||
        state.tokenFingerprint !== tokenFingerprint) process.exit(4);
    process.stdout.write(String(state.pid));
NODE
  )" || {
    echo "verify-signed-app: runtime state does not belong to this isolated artifact generation" >&2
    return 1
  }

  if ! pid_matches_command exact "$CURRENT_RUNTIME_PID" "$RUNTIME_COMMAND"; then
    echo "verify-signed-app: authenticated runtime PID does not match the embedded artifact's exact argv" >&2
    return 1
  fi
  CURRENT_RUNTIME_BIRTH="$(capture_process_generation exact "$CURRENT_RUNTIME_PID" "$RUNTIME_COMMAND")" || {
    echo "verify-signed-app: authenticated runtime generation birth identity could not be captured" >&2
    return 1
  }
  remember_attested_generation exact "$CURRENT_RUNTIME_PID" "$CURRENT_RUNTIME_BIRTH" "$RUNTIME_COMMAND"
  if ! pid_matches_generation prefix "$CURRENT_APP_PID" "$CURRENT_APP_BIRTH" "$APP_BINARY"; then
    echo "verify-signed-app: app exited before runtime verification completed" >&2
    return 1
  fi

  app_count="$(find_artifact_processes | awk -F '\t' '$2 == "app" { count += 1 } END { print count + 0 }')"
  runtime_count="$(find_artifact_processes | awk -F '\t' '$2 == "runtime" { count += 1 } END { print count + 0 }')"
  if [ "$app_count" -ne 1 ] || [ "$runtime_count" -ne 1 ]; then
    echo "verify-signed-app: artifact generation must own exactly one native app and one embedded runtime" >&2
    return 1
  fi

  unauth_status="$(
    curl -sS --max-time 2 -o /dev/null -w "%{http_code}" \
      -X POST "$APP_MCP_URL" \
      -H "Content-Type: application/json" \
      --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"signed-artifact-verify","version":"0"}}}' \
      2>/dev/null || true
  )"
  if [ "$unauth_status" != "401" ]; then
    echo "verify-signed-app: unauthenticated MCP request was not rejected" >&2
    return 1
  fi

  if ! probe_output="$(
    node "$SCRIPT_DIR/probe-app-runtime.mjs" \
      --url "$APP_MCP_URL" \
      --owner-secret-file "$CURRENT_OWNER_FILE" \
      --expected-version "$EXPECTED_VERSION" \
      --min-tools 290 \
      --require-tool list_notes \
      --require-tool list_contacts \
      --require-tool send_mail \
      --require-tool list_tabs \
      --require-tool list_photos \
      --require-tool numbers_set_cell \
      --require-tool gws_sheets_read \
      --require-tool get_bluetooth_state \
      --require-tool memory_query \
      --timeout-ms 10000 \
      --client-name "taxi-signed-artifact-verify" 2>&1
  )"; then
    echo "verify-signed-app: generation-authenticated MCP initialize/tools-list failed" >&2
    printf '%s\n' "$probe_output" >&2
    return 1
  fi
  if ! printf '%s\n' "$probe_output" | grep -F "listener pid $CURRENT_RUNTIME_PID" >/dev/null; then
    echo "verify-signed-app: MCP probe did not attest the exact runtime PID" >&2
    return 1
  fi
}

verify_appintents() {
  local predicate
  local logs

  # Registration is asynchronous relative to app/runtime readiness. Give the
  # shipping process a bounded window to emit a registration error before
  # querying logs for this exact PID.
  sleep 2
  predicate="processIdentifier == $CURRENT_APP_PID AND (eventMessage CONTAINS[c] \"Error registering app with intents\" OR eventMessage CONTAINS[c] \"linkd.autoShortcut\")"
  logs="$(/usr/bin/log show --style compact --last 60s --predicate "$predicate" 2>/dev/null || true)"
  if printf '%s\n' "$logs" | grep -q "Error registering app with intents"; then
    echo "verify-signed-app: AppIntents registration failed" >&2
    return 1
  fi
}

verify_normal_shutdown() {
  local app_running=1
  local runtime_running=1

  if ! pid_matches_generation prefix "$CURRENT_APP_PID" "$CURRENT_APP_BIRTH" "$APP_BINARY" ||
    ! pid_matches_generation exact "$CURRENT_RUNTIME_PID" "$CURRENT_RUNTIME_BIRTH" "$RUNTIME_COMMAND"; then
    echo "verify-signed-app: normal shutdown proof lost its exact process identities" >&2
    return 1
  fi
  if ! /usr/bin/osascript -l JavaScript "$SCRIPT_DIR/request-app-termination.js" \
    "$CURRENT_APP_PID" "$APP_BINARY" >/dev/null; then
    echo "verify-signed-app: Taxi rejected normal AppKit termination" >&2
    return 1
  fi

  for _ in $(seq 1 100); do
    if ! pid_matches_generation prefix "$CURRENT_APP_PID" "$CURRENT_APP_BIRTH" "$APP_BINARY"; then app_running=0; fi
    if ! pid_matches_generation exact "$CURRENT_RUNTIME_PID" "$CURRENT_RUNTIME_BIRTH" "$RUNTIME_COMMAND"; then
      runtime_running=0
    fi
    if [ "$app_running" -eq 0 ] && [ "$runtime_running" -eq 0 ]; then break; fi
    sleep 0.1
  done
  if [ "$app_running" -ne 0 ]; then
    echo "verify-signed-app: Taxi did not exit through normal AppKit termination" >&2
    return 1
  fi
  if [ "$runtime_running" -ne 0 ]; then
    echo "verify-signed-app: Taxi exited but left its authenticated runtime running" >&2
    return 1
  fi
  if ! assert_no_artifact_processes_stably; then
    echo "verify-signed-app: normal shutdown left or restarted an exact-artifact process" >&2
    return 1
  fi
  # The first launch now owns no live process. Reset the cleanup boundary so a
  # second-generation preflight refusal cannot terminate an externally raced
  # launch of the same artifact.
  ARTIFACT_LAUNCH_ATTEMPTED=0
  NORMAL_SHUTDOWN_VERIFIED=1
}

verify_generation_isolation() {
  if [ "$CURRENT_HOME" = "$FIRST_HOME" ] ||
    [ "$CURRENT_CONFIG_FILE" = "$FIRST_CONFIG_FILE" ] ||
    [ "$CURRENT_RUNTIME_STATE_FILE" = "$FIRST_RUNTIME_STATE_FILE" ]; then
    echo "verify-signed-app: lifecycle generations reused config/state paths" >&2
    return 1
  fi
  if cmp -s "$CURRENT_TOKEN_FILE" "$FIRST_TOKEN_FILE"; then
    echo "verify-signed-app: lifecycle generations reused a runtime token" >&2
    return 1
  fi
  if cmp -s "$CURRENT_OWNER_FILE" "$FIRST_OWNER_FILE"; then
    echo "verify-signed-app: lifecycle generations reused an owner secret" >&2
    return 1
  fi
}

verify_sigterm_runtime_restart() {
  local old_runtime_pid="$CURRENT_RUNTIME_PID"
  local old_runtime_birth="$CURRENT_RUNTIME_BIRTH"
  local new_runtime_pid=""
  local old_runtime_running=1

  if ! [[ "$CURRENT_APP_PID" =~ ^[1-9][0-9]*$ ]] ||
    ! [[ "$old_runtime_pid" =~ ^[1-9][0-9]*$ ]]; then
    echo "verify-signed-app: runtime restart proof is missing authenticated process identities" >&2
    return 1
  fi
  if ! pid_matches_generation prefix "$CURRENT_APP_PID" "$CURRENT_APP_BIRTH" "$APP_BINARY"; then
    echo "verify-signed-app: runtime restart proof lost the exact Taxi app process" >&2
    return 1
  fi
  if ! pid_matches_generation exact "$old_runtime_pid" "$old_runtime_birth" "$RUNTIME_COMMAND"; then
    echo "verify-signed-app: runtime restart proof lost the authenticated Node generation" >&2
    return 1
  fi

  # Re-read the exact command immediately before signalling so PID reuse can
  # never turn this acceptance check into a signal against an unrelated
  # process. This harness observes generation replacement, not the old child's
  # wait status; exit-code semantics remain covered by the Swift supervisor
  # unit tests that own the Process termination callback.
  if pid_matches_generation exact "$old_runtime_pid" "$old_runtime_birth" "$RUNTIME_COMMAND"; then
    if ! kill -TERM "$old_runtime_pid"; then
      echo "verify-signed-app: runtime SIGTERM could not be delivered" >&2
      return 1
    fi
  else
    echo "verify-signed-app: runtime generation changed before the restart signal" >&2
    return 1
  fi

  for _ in $(seq 1 100); do
    if ! pid_matches_generation exact "$old_runtime_pid" "$old_runtime_birth" "$RUNTIME_COMMAND"; then
      old_runtime_running=0
      break
    fi
    sleep 0.1
  done
  if [ "$old_runtime_running" -ne 0 ]; then
    echo "verify-signed-app: SIGTERM did not stop the authenticated Node generation" >&2
    return 1
  fi
  if ! pid_matches_generation prefix "$CURRENT_APP_PID" "$CURRENT_APP_BIRTH" "$APP_BINARY"; then
    echo "verify-signed-app: Taxi app exited while its runtime was restarting" >&2
    return 1
  fi

  # Remove the old generation receipts. wait_for_current_runtime_receipt writes
  # these paths only after a fresh owner-secret challenge and runtime-state
  # response agree; retaining the old files could otherwise create a false
  # readiness observation while the replacement listener is still starting.
  rm -f "$CURRENT_HEALTH_FILE" "$CURRENT_RUNTIME_STATE_FILE"
  CURRENT_RUNTIME_PID=""
  verify_current_generation
  new_runtime_pid="$CURRENT_RUNTIME_PID"

  if [ "$new_runtime_pid" = "$old_runtime_pid" ]; then
    echo "verify-signed-app: runtime restart did not produce a distinct authenticated PID generation" >&2
    return 1
  fi
  if ! pid_matches_generation prefix "$CURRENT_APP_PID" "$CURRENT_APP_BIRTH" "$APP_BINARY"; then
    echo "verify-signed-app: Taxi app did not survive runtime replacement" >&2
    return 1
  fi
  if ! pid_matches_generation exact "$new_runtime_pid" "$CURRENT_RUNTIME_BIRTH" "$RUNTIME_COMMAND"; then
    echo "verify-signed-app: restarted runtime does not match the exact signed artifact command" >&2
    return 1
  fi

  SIGTERM_RESTART_VERIFIED=1
  echo "verify-signed-app: authenticated SIGTERM recovery produced runtime generation $new_runtime_pid"
}

run_signed_runtime_soak() {
  local allow_short=()
  local output
  local release_qualified

  case "$SIGNED_ALLOW_SHORT_SOAK" in
    0) ;;
    1) allow_short+=(--allow-short-soak) ;;
    *)
      echo "verify-signed-app: TAXI_SIGNED_ALLOW_SHORT_SOAK must be 0 or 1" >&2
      return 1
      ;;
  esac

  echo "verify-signed-app: observing the second signed-artifact generation for ${SIGNED_SOAK_DURATION_SECONDS}s..."
  if ! output="$(
    node "$SCRIPT_DIR/soak-app-runtime.mjs" \
      --url "$APP_MCP_URL" \
      --owner-secret-file "$CURRENT_OWNER_FILE" \
      --expected-version "$EXPECTED_VERSION" \
      --app-pid "$CURRENT_APP_PID" \
      --app-command "$APP_BINARY" \
      --app-birth "$CURRENT_APP_BIRTH" \
      --runtime-pid "$CURRENT_RUNTIME_PID" \
      --duration-seconds "$SIGNED_SOAK_DURATION_SECONDS" \
      --interval-seconds "$SIGNED_SOAK_INTERVAL_SECONDS" \
      --mcp-interval-seconds "$SIGNED_SOAK_MCP_INTERVAL_SECONDS" \
      --max-sustained-cpu "$SIGNED_SOAK_MAX_SUSTAINED_CPU" \
      --max-high-cpu-seconds "$SIGNED_SOAK_MAX_HIGH_CPU_SECONDS" \
      "${allow_short[@]}" 2>&1
  )"; then
    echo "verify-signed-app: signed-artifact runtime soak failed" >&2
    printf '%s\n' "$output" >&2
    return 1
  fi

  release_qualified="$(node -e '
    const result = JSON.parse(process.argv[1]);
    process.stdout.write(result.releaseQualified === true ? "true" : "false");
  ' "$output")" || {
    echo "verify-signed-app: soak result was not valid machine-readable evidence" >&2
    return 1
  }
  if [ "$SIGNED_ALLOW_SHORT_SOAK" -eq 0 ] && [ "$release_qualified" != "true" ]; then
    echo "verify-signed-app: the mandatory signed-artifact soak was not release-qualified" >&2
    return 1
  fi

  SOAK_VERIFIED=1
  if [ "$release_qualified" = "true" ]; then
    echo "verify-signed-app: release-qualified >=3600s soak passed ($output)"
  else
    echo "verify-signed-app: NON-RELEASE short soak smoke passed ($output)"
  fi
}

verify_crash_watchdog_shutdown() {
  local app_running=1
  local runtime_running=1

  if ! pid_matches_generation prefix "$CURRENT_APP_PID" "$CURRENT_APP_BIRTH" "$APP_BINARY" ||
    ! pid_matches_generation exact "$CURRENT_RUNTIME_PID" "$CURRENT_RUNTIME_BIRTH" "$RUNTIME_COMMAND"; then
    echo "verify-signed-app: crash proof lost its exact app/runtime identities" >&2
    return 1
  fi

  # Model a native app crash. The embedded Node process receives no cooperative
  # shutdown request; its parent watchdog must detect death/reparenting.
  if pid_matches_generation prefix "$CURRENT_APP_PID" "$CURRENT_APP_BIRTH" "$APP_BINARY"; then
    kill -KILL "$CURRENT_APP_PID" 2>/dev/null || true
  else
    echo "verify-signed-app: crash proof lost the exact app generation before signal" >&2
    return 1
  fi
  for _ in $(seq 1 100); do
    if ! pid_matches_generation prefix "$CURRENT_APP_PID" "$CURRENT_APP_BIRTH" "$APP_BINARY"; then app_running=0; fi
    if ! pid_matches_generation exact "$CURRENT_RUNTIME_PID" "$CURRENT_RUNTIME_BIRTH" "$RUNTIME_COMMAND"; then
      runtime_running=0
    fi
    if [ "$app_running" -eq 0 ] && [ "$runtime_running" -eq 0 ]; then break; fi
    sleep 0.1
  done

  if [ "$app_running" -ne 0 ]; then
    echo "verify-signed-app: exact native app survived SIGKILL" >&2
    return 1
  fi
  if [ "$runtime_running" -ne 0 ]; then
    echo "verify-signed-app: native app crash left its app-owned Node runtime orphaned" >&2
    return 1
  fi
  if ! assert_no_artifact_processes_stably; then
    echo "verify-signed-app: crash shutdown left or restarted an exact-artifact process" >&2
    return 1
  fi
  CRASH_SHUTDOWN_VERIFIED=1
}

trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

if [ ! -d "$APP_BUNDLE" ]; then
  echo "verify-signed-app: app bundle not found" >&2
  exit 1
fi
if /usr/libexec/PlistBuddy -c "Print :TaxiAcceptanceHarnessBuild" \
  "$APP_BUNDLE/Contents/Info.plist" >/dev/null 2>&1; then
  echo "verify-signed-app: refusing an acceptance-harness build" >&2
  exit 1
fi
EXPECTED_VERSION="$(
  node -e 'const fs = require("fs"); console.log(JSON.parse(fs.readFileSync(process.argv[1], "utf8")).version)' \
    "$PROJECT_DIR/package.json"
)"

STATE_DIR="$(mktemp -d "$STATE_PARENT/taxi-signed-verify.XXXXXX")"
chmod 700 "$STATE_DIR"

# A final signed distribution must include the widget even when this command is
# run locally rather than under release-app.yml.
if ! TAXI_REQUIRE_WIDGET=1 \
  TAXI_EXPECTED_SIGNING_MODE=developer-id \
  TAXI_EXPECTED_SIGNING_TEAM_ID="$TAXI_SIGNING_TEAM_ID" \
  bash "$SCRIPT_DIR/verify-bundle-structure.sh" "$APP_BUNDLE" "app.taxi" "$APP_EXECUTABLE" \
    >/dev/null 2>&1; then
  echo "verify-signed-app: bundle structure verification failed" >&2
  exit 1
fi

APP_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$APP_BUNDLE/Contents/Info.plist" 2>/dev/null)" || {
  echo "verify-signed-app: bundle version could not be inspected" >&2
  exit 1
}
if [ "$APP_VERSION" != "$EXPECTED_VERSION" ]; then
  echo "verify-signed-app: bundle version does not match the checked-out release source" >&2
  exit 1
fi

echo "verify-signed-app: checking signature tree..."
if ! codesign --verify --deep --strict --verbose=2 "$APP_BUNDLE" >/dev/null 2>&1; then
  echo "verify-signed-app: signature verification failed" >&2
  exit 1
fi

SIGN_INFO="$(codesign -dv --verbose=4 "$APP_BUNDLE" 2>&1)"
SIGN_AUTHORITY="$(printf '%s\n' "$SIGN_INFO" | sed -nE 's/^Authority=(Developer ID Application:.*)$/\1/p' | head -1)"
SIGN_TEAM="$(printf '%s\n' "$SIGN_INFO" | sed -nE 's/^TeamIdentifier=([A-Z0-9]+)$/\1/p' | head -1)"
if ! is_taxi_developer_id_authority "$SIGN_AUTHORITY"; then
  echo "verify-signed-app: signing authority is not the project's published Developer ID" >&2
  exit 1
fi
if [ "$SIGN_TEAM" != "$TAXI_SIGNING_TEAM_ID" ]; then
  echo "verify-signed-app: signing team does not match the published Developer ID" >&2
  exit 1
fi
if printf '%s\n' "$SIGN_INFO" | grep -q "Signature=adhoc"; then
  echo "verify-signed-app: ad-hoc signature is not a release artifact" >&2
  exit 1
fi
if ! printf '%s\n' "$SIGN_INFO" | grep -q "Runtime Version="; then
  echo "verify-signed-app: hardened runtime is missing" >&2
  exit 1
fi

echo "verify-signed-app: checking Gatekeeper..."
if ! spctl --assess --type execute -vvv "$APP_BUNDLE" >/dev/null 2>&1; then
  echo "verify-signed-app: Gatekeeper rejected the artifact" >&2
  exit 1
fi

echo "verify-signed-app: checking notarization staple..."
if ! xcrun stapler validate "$APP_BUNDLE" >/dev/null 2>&1; then
  echo "verify-signed-app: notarization staple validation failed" >&2
  exit 1
fi

if ! assert_no_artifact_processes_stably; then
  echo "verify-signed-app: launch precondition failed for the exact signed artifact" >&2
  exit 1
fi

# Production launches must not inherit test-only Taxi environment overrides.
while IFS='=' read -r environment_name _; do
  unset "$environment_name"
done < <(env | awk -F= '/^TAXI_/ { print }')

echo "verify-signed-app: launching first isolated artifact generation..."
prepare_generation "normal"
launch_current_generation
verify_current_generation
verify_appintents

FIRST_HOME="$CURRENT_HOME"
FIRST_CONFIG_FILE="$CURRENT_CONFIG_FILE"
FIRST_TOKEN_FILE="$CURRENT_TOKEN_FILE"
FIRST_OWNER_FILE="$CURRENT_OWNER_FILE"
FIRST_RUNTIME_STATE_FILE="$CURRENT_RUNTIME_STATE_FILE"

verify_normal_shutdown
echo "verify-signed-app: first generation passed normal AppKit shutdown proof"

echo "verify-signed-app: launching second isolated artifact generation..."
prepare_generation "soak-crash"
launch_current_generation
verify_current_generation
verify_generation_isolation
verify_sigterm_runtime_restart
run_signed_runtime_soak
verify_crash_watchdog_shutdown
echo "verify-signed-app: second generation passed native SIGKILL -> app-owned Node watchdog shutdown proof"

if [ "$SIGNED_ALLOW_SHORT_SOAK" -eq 1 ] &&
  node -e 'process.exit(Number(process.argv[1]) < 3600 ? 0 : 1)' "$SIGNED_SOAK_DURATION_SECONDS"; then
  echo "verify-signed-app: ✓ NON-RELEASE smoke only; exact signed artifact lifecycle passed with a short soak"
else
  echo "verify-signed-app: ✓ RELEASE-QUALIFIED exact signed artifact passed normal shutdown, SIGTERM generation restart, >=3600s soak, and crash watchdog cleanup"
fi
