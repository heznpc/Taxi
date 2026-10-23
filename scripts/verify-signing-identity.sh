#!/bin/bash

# Fail closed unless the selected certificate is a Developer ID Application
# identity for Taxi's Apple team. Apple embeds the individual account holder's
# legal name in the certificate subject, so the stable product verifier is the
# Apple-assigned team ID. Expected values live in scripts/lib/signing-identity.sh.

set -euo pipefail

# shellcheck source=scripts/lib/signing-identity.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib/signing-identity.sh"

if [ -z "${APPLE_DEVELOPER_ID:-}" ]; then
  echo "signing-identity: APPLE_DEVELOPER_ID is required" >&2
  exit 1
fi

if ! is_taxi_developer_id_authority "$APPLE_DEVELOPER_ID"; then
  echo "signing-identity: certificate common name is not a Developer ID for the Taxi team" >&2
  exit 1
fi
CERT_TEAM_ID="$TAXI_SIGNING_TEAM_ID"

if [ -n "${APPLE_TEAM_ID:-}" ] && [ "$APPLE_TEAM_ID" != "$CERT_TEAM_ID" ]; then
  echo "signing-identity: configured team does not match the certificate identity" >&2
  exit 1
fi

SECURITY_ARGS=(find-certificate -c "$APPLE_DEVELOPER_ID" -p)
if [ -n "${TAXI_SIGNING_KEYCHAIN:-}" ]; then
  SECURITY_ARGS+=("$TAXI_SIGNING_KEYCHAIN")
fi
CERT_PEM="$(security "${SECURITY_ARGS[@]}" 2>/dev/null)" || {
  echo "signing-identity: configured certificate was not found" >&2
  exit 1
}

SUBJECT="$(printf '%s' "$CERT_PEM" | openssl x509 -noout -subject -nameopt multiline 2>/dev/null)" || {
  echo "signing-identity: certificate subject could not be inspected" >&2
  exit 1
}
COMMON_NAME="$(printf '%s\n' "$SUBJECT" | sed -nE 's/^[[:space:]]*commonName[[:space:]]*=[[:space:]]*(.*)$/\1/p' | head -1)"
ORGANIZATION="$(printf '%s\n' "$SUBJECT" | sed -nE 's/^[[:space:]]*organizationName[[:space:]]*=[[:space:]]*(.*)$/\1/p' | head -1)"
ORG_UNIT="$(printf '%s\n' "$SUBJECT" | sed -nE 's/^[[:space:]]*organizationalUnitName[[:space:]]*=[[:space:]]*(.*)$/\1/p' | head -1)"

if [ "$COMMON_NAME" != "$APPLE_DEVELOPER_ID" ] ||
  [ -z "$ORGANIZATION" ] ||
  [ "$ORG_UNIT" != "$TAXI_SIGNING_TEAM_ID" ]; then
  echo "signing-identity: certificate subject is not a Developer ID for the Taxi team" >&2
  exit 1
fi

echo "ok: Developer ID certificate belongs to Taxi team ${TAXI_SIGNING_TEAM_ID}"
