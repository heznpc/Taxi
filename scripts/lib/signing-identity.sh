#!/bin/bash
# Public signing anchor for Taxi's Apple distribution artifacts.
#
# Apple embeds an individual account holder's legal name in a Developer ID
# certificate. Keep that value out of source control: the installed certificate
# and APPLE_DEVELOPER_ID provide it at signing time. The Apple-assigned team ID
# remains the stable public verifier shared by pre- and post-signing checks.

TAXI_SIGNING_TEAM_ID="XS7HJJN7GC"

is_taxi_developer_id_authority() {
  local authority="${1:-}"
  case "$authority" in
    "Developer ID Application: "*" (${TAXI_SIGNING_TEAM_ID})") return 0 ;;
    *) return 1 ;;
  esac
}
