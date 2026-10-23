/**
 * Wire contract for Taxi.app's read-only operational diagnostic exchange.
 *
 * The marker is not a credential. The HTTP runtime grants the no-rate-
 * mutation path only when it is paired with the exact process-generation
 * bearer and response-proof nonce, then limits MCP methods to this allowlist.
 */
export const APP_RUNTIME_DIAGNOSTIC_HEADER = "x-taxi-doctor-probe";
export const APP_RUNTIME_DIAGNOSTIC_PROTOCOL = "owner-generation-read-only-v1";
export const APP_RUNTIME_DIAGNOSTIC_MCP_METHODS = ["initialize", "notifications/initialized", "tools/list"] as const;
