/**
 * HTTP/SSE transport — Express server with StreamableHTTP sessions,
 * bearer token auth, health/discovery endpoints, and session management.
 */

import { installHarnessRoutes } from "../harness/routes.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID, timingSafeEqual, randomBytes, createHash } from "node:crypto";
import type { Server as NodeHttpServer } from "node:http";
import { IDENTITY, LIMITS, TIMEOUT } from "../shared/constants.js";
import { log, errToCtx } from "./../shared/logger.js";
import { printBanner, type BannerInfo } from "../shared/banner.js";
import { auditLog } from "../shared/audit.js";
import { SERVER_ICON, WEBSITE_URL } from "../shared/icons.js";
import {
  APP_IDENTITY_CHALLENGE_PATH,
  APP_RUNTIME_REQUEST_NONCE_HEADER,
  APP_RUNTIME_RESPONSE_PROOF_HEADER,
  APP_RUNTIME_RESPONSE_PROOF_SCHEME,
  runtimeGenerationBearer,
  runtimeIdentityProof,
  runtimeResponseProof,
} from "../shared/app-runtime-identity.js";
import {
  APP_RUNTIME_DIAGNOSTIC_HEADER,
  APP_RUNTIME_DIAGNOSTIC_MCP_METHODS,
  APP_RUNTIME_DIAGNOSTIC_PROTOCOL,
} from "../shared/app-runtime-diagnostic.js";
import type { ToolRegistry } from "../shared/tool-registry.js";
import { indexToolDescriptions, isToolSearchIndexed } from "../shared/tool-search.js";
import { getOAuthClaims, getRequestContext, runWithRequestContext } from "../shared/request-context.js";
import { checkIpRateLimit, pruneStaleIpBuckets } from "../shared/rate-limit.js";
import { createServer, type CreateServerOptions } from "./mcp-setup.js";
import type { RuntimeModuleState } from "./mcp-setup.js";
import { registerShutdownHook, runShutdownHooks, unregisterShutdownHook } from "./shutdown.js";
import {
  buildServerCard,
  buildOAuthProtectedResourceCard,
  buildOAuthAuthorizationServerMetadata,
} from "./well-known-card.js";
import { verifyBearer, type VerifyResult } from "./oauth-verifier.js";
import {
  buildBearerChallenge,
  isSameOAuthSessionPrincipal,
  missingScopesForMcpRequest,
  toOAuthSessionPrincipal,
  wellKnownPath,
  wellKnownUrl,
  type OAuthSessionPrincipal,
} from "./oauth-http.js";

// Importing HTTP policy helpers must be side-effect free: `taxi doctor` uses
// resolveAllowNetwork without starting a server. Acquire the shared pruner only
// after a listener has bound, and release it when the last HTTP lifecycle ends.
let ratePruneTimer: ReturnType<typeof setInterval> | undefined;
let ratePruneOwners = 0;

function acquireRatePruner(): () => void {
  ratePruneOwners += 1;
  if (!ratePruneTimer) {
    ratePruneTimer = setInterval(() => pruneStaleIpBuckets(), 60_000);
    ratePruneTimer.unref?.();
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    ratePruneOwners = Math.max(0, ratePruneOwners - 1);
    if (ratePruneOwners !== 0 || !ratePruneTimer) return;
    clearInterval(ratePruneTimer);
    ratePruneTimer = undefined;
  };
}

/** Initial HTTP warmup plus at most three serialized retries. These are
 * process-lifecycle retries, never request-triggered full-catalog builds. */
const SEMANTIC_INDEX_RETRY_DELAYS_MS = [500, 2_000, 5_000] as const;

/** The native app gives an app-owned child 12 seconds to become ready. Keep
 * the Node-side catalog deadline shorter so a rejected or stuck warmup closes
 * its listener and exits non-zero before the supervisor has to guess whether
 * the generation is merely slow or permanently listener-only. */
export const HTTP_PROCESS_WARMUP_DEADLINE_MS = 10_000;

type HttpWarmupReadiness = "warming" | "ready" | "degraded";
type HttpWarmupFailure = "deadline_exceeded" | "initialization_failed";

/** Optional run identifier supplied by native app surfaces and diagnostic
 *  clients. Only UUIDs are accepted so an untrusted HTTP peer cannot inject
 *  arbitrary text or high-cardinality labels into the audit trail. */
export const RUN_ID_HEADER = "x-taxi-run-id";
export {
  APP_IDENTITY_CHALLENGE_PATH,
  APP_RUNTIME_REQUEST_NONCE_HEADER,
  APP_RUNTIME_RESPONSE_PROOF_HEADER,
  APP_RUNTIME_RESPONSE_PROOF_SCHEME,
  runtimeGenerationBearer,
  runtimeIdentityProof,
  runtimeResponseProof,
};
const RUN_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseRunCorrelationId(value: string | string[] | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return RUN_ID_RE.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

/** Stable, non-secret comparison token for the effective module scope loaded
 * by this process. It is served only from the authenticated app runtime-state
 * endpoint; public /health intentionally omits effective runtime evidence. */
export function runtimeScopeFingerprint(disabledModules: Iterable<string>): string {
  const canonical = [...new Set(disabledModules)].sort().join("\n");
  return createHash("sha256").update(`taxi-runtime-scope-v1\n${canonical}`, "utf8").digest("hex");
}

/** Fingerprint the native app's private process-owner credential without ever
 * returning the credential itself. Invalid or missing credentials cannot make
 * a process eligible for app lifecycle adoption. */
export function runtimeOwnerFingerprint(ownerSecret: string | undefined): string | undefined {
  const normalized = ownerSecret?.trim();
  if (!normalized || !/^[A-Za-z0-9_-]{43}$/.test(normalized)) return undefined;
  return createHash("sha256").update(`taxi-app-owner-v1\n${normalized}`, "utf8").digest("hex");
}

export function runtimeTokenFingerprint(token: string): string {
  return createHash("sha256").update(`taxi-runtime-token-v1\n${token}`).digest("hex");
}

/** Pure parent-watchdog decision. An app-owned runtime belongs to the exact
 * native process that launched it: parent death or reparenting must begin
 * shutdown, while repeated timer delivery after that decision is a no-op. */
export function shouldTerminateOrphanedAppRuntime(
  originalParentPid: number,
  currentParentPid: number,
  parentIsAlive: boolean,
  terminationStarted: boolean,
): boolean {
  if (terminationStarted) return false;
  if (!Number.isSafeInteger(originalParentPid) || originalParentPid <= 1) return true;
  return currentParentPid !== originalParentPid || !parentIsAlive;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM still proves the PID exists. Every other failure is treated as
    // parent loss for this same-user native app/runtime relationship.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Declarative network-exposure policy (see docs/rfc/0002-http-allow-network.md).
 *
 *   loopback-only       — default; only 127.0.0.1 bindings accepted. Rejects
 *                         `--bind-all` at startup so a proxy sitting in front
 *                         of Taxi cannot silently turn a loopback server
 *                         into a public one.
 *   with-token          — external binding allowed; TAXI_HTTP_TOKEN required.
 *   with-token+origin   — external binding + token + explicit Origin allow-list
 *                         (TAXI_ALLOWED_ORIGINS) required.
 *   unauthenticated     — explicit opt-in danger mode for CI/debug. Emits a
 *                         loud warning and flags `.well-known/mcp.json` as
 *                         `security: insecure`. Not a default anyone stumbles
 *                         into.
 */
export type AllowNetwork =
  "loopback-only" | "with-token" | "with-token+origin" | "with-oauth" | "with-oauth+origin" | "unauthenticated";

const ALLOW_NETWORK_VALUES: readonly AllowNetwork[] = [
  "loopback-only",
  "with-token",
  "with-token+origin",
  "with-oauth",
  "with-oauth+origin",
  "unauthenticated",
];

export interface HttpServerOptions extends CreateServerOptions {
  port: number;
  bindAll: boolean;
  httpToken: string;
  appRuntimeOwnerSecret?: string;
  /** Overrides the policy inferred from CLI flags / env. When omitted the
   *  policy is derived: loopback-only unless `--bind-all` or
   *  `--unsafe-no-auth` is set. */
  allowNetwork?: AllowNetwork;
  /** Opt-in to the `unauthenticated` policy via CLI flag. Ignored when
   *  `allowNetwork` is set explicitly. */
  unsafeNoAuth?: boolean;
}

/** RFC 0005 — OAuth issuer + audience. Read once at startup so
 *  subsequent handlers can reference them without re-probing env. Both
 *  are required when `allowNetwork` lands on `with-oauth*` (enforced by
 *  `validateNetworkPolicy`). The HTTP middleware verifies JWTs with this
 *  same resource indicator before any protected MCP route runs. */
export interface OAuthContext {
  issuer: string;
  /** Resource Indicators target per RFC 8707 — the `aud` claim a valid
   *  token must carry. Typically the server's public MCP endpoint URL. */
  audience: string;
  /** Optional RFC 8414 publication contract for deployments that co-host or
   *  reverse-proxy their authorization server through this HTTP process. */
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  /** Optional operator override for the verifier key set. When absent, the
   *  verifier discovers `jwks_uri` from issuer metadata (RFC 8414 / OIDC). */
  jwksUri?: string;
  /** Methods this co-hosted RFC 8414 document truthfully advertises. Required
   *  when metadata publication is enabled; public PKCE deployments explicitly
   *  configure `none` rather than having Taxi infer AS capability. */
  tokenEndpointAuthMethods?: string[];
}

export const OAUTH_TOKEN_ENDPOINT_AUTH_METHODS = [
  "none",
  "client_secret_basic",
  "client_secret_post",
  "client_secret_jwt",
  "private_key_jwt",
  "tls_client_auth",
  "self_signed_tls_client_auth",
] as const;

export function readOAuthContext(): OAuthContext | null {
  const issuer = (process.env.TAXI_OAUTH_ISSUER ?? "").trim();
  const audience = (process.env.TAXI_OAUTH_AUDIENCE ?? "").trim();
  const authorizationEndpoint = (process.env.TAXI_OAUTH_AUTHORIZATION_ENDPOINT ?? "").trim();
  const tokenEndpoint = (process.env.TAXI_OAUTH_TOKEN_ENDPOINT ?? "").trim();
  const jwksUri = (process.env.TAXI_OAUTH_JWKS_URI ?? "").trim();
  const rawTokenEndpointAuthMethods = (process.env.TAXI_OAUTH_TOKEN_ENDPOINT_AUTH_METHODS ?? "").trim();
  if (!issuer && !audience && !authorizationEndpoint && !tokenEndpoint && !jwksUri && !rawTokenEndpointAuthMethods) {
    return null;
  }
  const tokenEndpointAuthMethods = rawTokenEndpointAuthMethods
    ? rawTokenEndpointAuthMethods
        .split(",")
        .map((method) => method.trim())
        .filter(Boolean)
    : undefined;
  return {
    issuer,
    audience,
    ...(authorizationEndpoint ? { authorizationEndpoint } : {}),
    ...(tokenEndpoint ? { tokenEndpoint } : {}),
    ...(jwksUri ? { jwksUri } : {}),
    ...(tokenEndpointAuthMethods ? { tokenEndpointAuthMethods } : {}),
  };
}

/** Derive the effective policy from explicit overrides + CLI/env signals.
 *  Exported so `init.ts` / tests can reuse the same resolution logic. */
export function resolveAllowNetwork(opts: {
  explicit?: AllowNetwork;
  bindAll: boolean;
  httpToken: string;
  allowedOriginsCount: number;
  unsafeNoAuth?: boolean;
}): AllowNetwork {
  if (opts.explicit) {
    if (!ALLOW_NETWORK_VALUES.includes(opts.explicit)) {
      throw new Error(
        `Invalid allowNetwork value "${opts.explicit}". Expected one of: ${ALLOW_NETWORK_VALUES.join(", ")}`,
      );
    }
    return opts.explicit;
  }
  if (opts.unsafeNoAuth) return "unauthenticated";
  if (opts.bindAll) {
    return opts.allowedOriginsCount > 0 ? "with-token+origin" : "with-token";
  }
  return "loopback-only";
}

const CHROME_EXTENSION_ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/;

function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null") return null;
  // URL.origin is `null` for custom schemes, so validate Chrome extension
  // origins explicitly. Chrome IDs are exactly 32 lowercase characters from
  // a-p. Requiring the canonical string also rejects ports, paths, query,
  // fragments, userinfo, and lookalike schemes.
  if (CHROME_EXTENSION_ORIGIN_RE.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function parseAllowedOrigins(raw: string): Set<string> {
  const origins = new Set<string>();
  for (const part of raw.split(",")) {
    const origin = normalizeOrigin(part);
    if (origin) origins.add(origin);
  }
  return origins;
}

export function isOriginAllowed(
  origin: string | undefined,
  ctx: { policy: AllowNetwork; bindAll: boolean; allowedOrigins: Set<string>; denyNoOrigin?: boolean },
): boolean {
  // A browser always attaches Origin to a cross-origin request, so a MISSING
  // Origin is a non-browser client (curl, a native MCP client), never a browser
  // CSRF / DNS-rebinding vector. Whatever else gates that client depends on the
  // active policy — loopback-only relies on the 127.0.0.1 socket binding,
  // with-token* / with-oauth* on the Bearer / JWT auth middleware — so allowing
  // no-Origin here adds no browser-attack surface under any of them. Allowed by
  // default; `denyNoOrigin` (TAXI_DENY_NO_ORIGIN) opts into a strict deny for
  // deployments that only ever serve browser clients.
  if (!origin) return !ctx.denyNoOrigin;
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;

  if (ctx.policy === "with-token+origin" || ctx.policy === "with-oauth+origin") {
    return ctx.allowedOrigins.has(normalized);
  }
  // Loopback binding protects the socket from remote hosts, but it does not
  // make every local web page trustworthy. A hostile page at an arbitrary
  // localhost port can still drive a browser request to 127.0.0.1. Browser
  // origins therefore require an explicit allow-list even in the default
  // loopback-only mode. Native MCP clients omit Origin and pass above.
  if (ctx.policy === "loopback-only") return ctx.allowedOrigins.has(normalized);
  if (ctx.allowedOrigins.has(normalized)) return true;
  return ctx.bindAll && ctx.allowedOrigins.size === 0;
}

/** Startup invariant check. Throws on misconfiguration so the process
 *  refuses to start rather than silently exposing the tool surface. */
export function validateNetworkPolicy(ctx: {
  policy: AllowNetwork;
  bindAll: boolean;
  httpToken: string;
  allowedOriginsCount: number;
  oauthIssuer?: string;
  oauthAudience?: string;
  oauthAuthorizationEndpoint?: string;
  oauthTokenEndpoint?: string;
  oauthJwksUri?: string;
  oauthTokenEndpointAuthMethods?: string[];
}): void {
  switch (ctx.policy) {
    case "loopback-only":
      if (ctx.bindAll) {
        throw new Error(
          "allowNetwork=loopback-only conflicts with --bind-all. " +
            'Either drop --bind-all, or set TAXI_ALLOW_NETWORK="with-token" ' +
            "(and provide TAXI_HTTP_TOKEN).",
        );
      }
      return;
    case "with-token":
      if (!ctx.httpToken) {
        throw new Error(
          "allowNetwork=with-token requires TAXI_HTTP_TOKEN. " +
            'Set the token or switch to TAXI_ALLOW_NETWORK="loopback-only".',
        );
      }
      return;
    case "with-token+origin":
      if (!ctx.httpToken) {
        throw new Error("allowNetwork=with-token+origin requires TAXI_HTTP_TOKEN.");
      }
      if (ctx.allowedOriginsCount === 0) {
        throw new Error(
          "allowNetwork=with-token+origin requires TAXI_ALLOWED_ORIGINS. " +
            'Example: TAXI_ALLOWED_ORIGINS="https://claude.ai,https://cursor.sh"',
        );
      }
      return;
    case "with-oauth":
    case "with-oauth+origin": {
      // OAuth policy validation. Startup refuses when
      // TAXI_OAUTH_ISSUER or TAXI_OAUTH_AUDIENCE is missing so the
      // .well-known/oauth-protected-resource card never goes live with
      // empty fields (clients that fetch it must see a pointer to a real
      // authorization server).
      if (!ctx.oauthIssuer) {
        throw new Error(
          `allowNetwork=${ctx.policy} requires TAXI_OAUTH_ISSUER ` +
            '(the authorization server base URL, e.g. "https://auth.example.com/realms/taxi").',
        );
      }
      let issuerUrl: URL;
      try {
        issuerUrl = new URL(ctx.oauthIssuer);
      } catch {
        throw new Error("TAXI_OAUTH_ISSUER must be a valid https:// URL.");
      }
      if (
        issuerUrl.protocol !== "https:" ||
        issuerUrl.search ||
        issuerUrl.hash ||
        issuerUrl.username ||
        issuerUrl.password
      ) {
        // No part of the issuer value flows into the error message — not
        // even the scheme. The URL can carry an internal hostname an
        // operator treats as sensitive, and this error reaches stderr via
        // the FATAL log path. The operator can read their own env var to
        // debug; the message just names the contract that was violated.
        // (Avoids CodeQL js/clear-text-logging on the taint flow into the
        // logger sink.)
        throw new Error(
          "TAXI_OAUTH_ISSUER must be an https:// URL. " + "Plain http issuers are a security hole — reject at startup.",
        );
      }
      if (!ctx.oauthAudience) {
        throw new Error(
          `allowNetwork=${ctx.policy} requires TAXI_OAUTH_AUDIENCE ` +
            "(RFC 8707 Resource Indicator — the URL your MCP endpoint is reachable at).",
        );
      }
      let audienceUrl: URL;
      try {
        audienceUrl = new URL(ctx.oauthAudience);
      } catch {
        throw new Error("TAXI_OAUTH_AUDIENCE must be a valid https:// resource URL.");
      }
      if (audienceUrl.protocol !== "https:" || audienceUrl.hash || audienceUrl.username || audienceUrl.password) {
        throw new Error("TAXI_OAUTH_AUDIENCE must be a valid https:// resource URL without a fragment or userinfo.");
      }
      const hasAuthorizationEndpoint = !!ctx.oauthAuthorizationEndpoint;
      const hasTokenEndpoint = !!ctx.oauthTokenEndpoint;
      if (hasAuthorizationEndpoint !== hasTokenEndpoint) {
        throw new Error(
          "RFC 8414 publication requires both TAXI_OAUTH_AUTHORIZATION_ENDPOINT and TAXI_OAUTH_TOKEN_ENDPOINT.",
        );
      }
      for (const [name, value] of [
        ["TAXI_OAUTH_AUTHORIZATION_ENDPOINT", ctx.oauthAuthorizationEndpoint],
        ["TAXI_OAUTH_TOKEN_ENDPOINT", ctx.oauthTokenEndpoint],
      ] as const) {
        if (!value) continue;
        let endpoint: URL;
        try {
          endpoint = new URL(value);
        } catch {
          throw new Error(`${name} must be a valid https:// URL.`);
        }
        if (endpoint.protocol !== "https:" || endpoint.hash || endpoint.username || endpoint.password) {
          throw new Error(`${name} must be a valid https:// URL without a fragment or userinfo.`);
        }
      }
      if (ctx.oauthJwksUri) {
        let jwksUri: URL;
        try {
          jwksUri = new URL(ctx.oauthJwksUri);
        } catch {
          throw new Error("TAXI_OAUTH_JWKS_URI must be a valid https:// URL.");
        }
        if (jwksUri.protocol !== "https:" || jwksUri.hash || jwksUri.username || jwksUri.password) {
          throw new Error("TAXI_OAUTH_JWKS_URI must be a valid https:// URL without a fragment or userinfo.");
        }
      }
      const tokenEndpointAuthMethods = ctx.oauthTokenEndpointAuthMethods;
      if (tokenEndpointAuthMethods && !hasAuthorizationEndpoint && !hasTokenEndpoint) {
        throw new Error(
          "TAXI_OAUTH_TOKEN_ENDPOINT_AUTH_METHODS requires RFC 8414 endpoint publication to be configured.",
        );
      }
      if (
        hasAuthorizationEndpoint &&
        hasTokenEndpoint &&
        (!tokenEndpointAuthMethods || tokenEndpointAuthMethods.length === 0)
      ) {
        throw new Error("RFC 8414 publication requires at least one token endpoint authentication method.");
      }
      for (const method of tokenEndpointAuthMethods ?? []) {
        if (!(OAUTH_TOKEN_ENDPOINT_AUTH_METHODS as readonly string[]).includes(method)) {
          throw new Error(
            "TAXI_OAUTH_TOKEN_ENDPOINT_AUTH_METHODS contains an unsupported method. " +
              `Expected a comma-separated subset of: ${OAUTH_TOKEN_ENDPOINT_AUTH_METHODS.join(", ")}.`,
          );
        }
      }
      if (ctx.policy === "with-oauth+origin" && ctx.allowedOriginsCount === 0) {
        throw new Error("allowNetwork=with-oauth+origin requires TAXI_ALLOWED_ORIGINS.");
      }
      return;
    }
    case "unauthenticated":
      // No invariant — but loudly warn so the choice is visible.
      log.warn("allowNetwork=unauthenticated — tool surface exposed without auth", {
        note: "This mode is intended for CI/debug only. Public deployments in this mode are a security incident.",
      });
      return;
  }
}

export async function startHttpServer(options: HttpServerOptions): Promise<NodeHttpServer> {
  const {
    port,
    bindAll,
    httpToken,
    appRuntimeOwnerSecret,
    allowNetwork: explicitPolicy,
    unsafeNoAuth,
    ...serverOptions
  } = options;
  const { pkg } = serverOptions;
  const appRuntimeOwnerFingerprint = runtimeOwnerFingerprint(appRuntimeOwnerSecret);
  const appOwnedRuntime =
    process.env.TAXI_APP_OWNED_RUNTIME === "1" && Boolean(httpToken) && Boolean(appRuntimeOwnerFingerprint);
  // Capture once, before any startup await. A later process.ppid is only a
  // comparison value, so reparenting can never silently redefine ownership.
  const originalAppRuntimeParentPid = appOwnedRuntime ? process.ppid : undefined;
  const appRuntimeAuthorizationToken = appOwnedRuntime
    ? runtimeGenerationBearer(appRuntimeOwnerSecret, process.pid, pkg.version)
    : undefined;
  const expectedStaticBearerHashes = [httpToken, appRuntimeAuthorizationToken]
    .filter((token): token is string => Boolean(token))
    .map((token) => createHash("sha256").update(`Bearer ${token}`).digest());
  const acceptsStaticBearer = (authorization: string | undefined): boolean => {
    const actual = createHash("sha256")
      .update(authorization ?? "")
      .digest();
    return expectedStaticBearerHashes.some((expected) => timingSafeEqual(actual, expected));
  };
  const generationBearerHash = appRuntimeAuthorizationToken
    ? createHash("sha256").update(`Bearer ${appRuntimeAuthorizationToken}`).digest()
    : undefined;
  const isGenerationBearer = (authorization: string | undefined): boolean => {
    if (!generationBearerHash) return false;
    const actual = createHash("sha256")
      .update(authorization ?? "")
      .digest();
    return timingSafeEqual(actual, generationBearerHash);
  };

  const express = (await import("express")).default;
  const app = express();

  // Origin validation — MCP spec 2025-11-25 requires 403 for invalid Origin
  const allowedOrigins = parseAllowedOrigins(process.env.TAXI_ALLOWED_ORIGINS ?? "");

  // Resolve and validate the declarative network policy before touching the
  // socket. Misconfiguration exits before any routes are mounted, so an
  // operator's footgun (e.g. `--bind-all` without a token) cannot end up as
  // a running-but-insecure server.
  const envPolicy = (process.env.TAXI_ALLOW_NETWORK ?? "").trim() as AllowNetwork | "";
  const allowNetwork = resolveAllowNetwork({
    explicit: envPolicy || explicitPolicy || undefined,
    bindAll,
    httpToken,
    allowedOriginsCount: allowedOrigins.size,
    unsafeNoAuth,
  });
  const oauth = readOAuthContext();
  try {
    validateNetworkPolicy({
      policy: allowNetwork,
      bindAll,
      httpToken,
      allowedOriginsCount: allowedOrigins.size,
      oauthIssuer: oauth?.issuer,
      oauthAudience: oauth?.audience,
      oauthAuthorizationEndpoint: oauth?.authorizationEndpoint,
      oauthTokenEndpoint: oauth?.tokenEndpoint,
      oauthJwksUri: oauth?.jwksUri,
      oauthTokenEndpointAuthMethods: oauth?.tokenEndpointAuthMethods,
    });
  } catch (e) {
    // Only the error MESSAGE is logged, never the stack. Stacks can capture
    // interpolated env-derived strings (OAuth issuer URL, audience) which
    // CodeQL's `js/clear-text-logging` treats as sensitive. The message
    // alone tells the operator what invariant failed without re-emitting
    // the config that derived from secret env vars.
    const msg = e instanceof Error ? e.message : String(e);
    log.error("FATAL — startup invariant failed", { reason: msg });
    process.exit(1);
  }
  // Opt-in strict mode (default off): reject requests with no Origin header.
  // Off by default because a missing Origin means a non-browser client gated by
  // the active policy (127.0.0.1 binding for loopback-only, Bearer/JWT auth for
  // token/OAuth) — denying it would break curl / native MCP clients for no
  // security gain, since browsers always send Origin.
  const denyNoOrigin = /^(1|true)$/i.test((process.env.TAXI_DENY_NO_ORIGIN ?? "").trim());
  // Install request IDs before CORS / auth so browser clients can correlate
  // preflight, rejected-origin, rate-limit, and bearer-challenge responses.
  app.use((req, res, next) => {
    const requestId = (req.headers["x-request-id"] as string) || randomBytes(8).toString("hex");
    res.set("X-Request-ID", requestId);
    (req as unknown as Record<string, string>).__requestId = requestId;
    next();
  });

  const CORS_METHODS = ["GET", "POST", "DELETE", "OPTIONS"] as const;
  // Match the headers emitted by the real StreamableHTTPClientTransport.
  // After initialize it sends MCP-Protocol-Version on every request, and a
  // resumed SSE GET carries Last-Event-ID. Omitting either makes a browser
  // fail at preflight before the MCP client can reach this server.
  const CORS_ALLOWED_HEADERS = [
    "Authorization",
    "Content-Type",
    "Mcp-Session-Id",
    "MCP-Protocol-Version",
    "Last-Event-ID",
    "X-Taxi-Run-Id",
    "X-Taxi-Runtime-Nonce",
  ] as const;
  const CORS_EXPOSED_HEADERS = [
    "Mcp-Session-Id",
    "MCP-Protocol-Version",
    "X-Request-ID",
    "WWW-Authenticate",
    "Retry-After",
    "X-Taxi-Runtime-Proof",
    "RateLimit",
    "RateLimit-Limit",
    "RateLimit-Remaining",
    "RateLimit-Reset",
    "RateLimit-Policy",
  ] as const;
  const corsAllowedHeaderNames = new Set(CORS_ALLOWED_HEADERS.map((header) => header.toLowerCase()));
  const isCorsRoute = (path: string): boolean => path === "/mcp" || path.startsWith("/.well-known/");
  const corsOriginAllowed = new WeakMap<object, boolean>();

  // Canonicalize the browser origin and prepare response headers before the IP
  // bucket runs, but defer rejection until afterwards. This keeps CORS headers
  // on an allowed-origin 429 while ensuring a forged/denied Origin cannot use
  // the cheap 403 path to bypass HTTP abuse accounting.
  app.use((req, res, next) => {
    if (!isCorsRoute(req.path)) return next();
    res.vary("Origin");
    const origin = req.headers.origin;
    const allowed = isOriginAllowed(origin, { policy: allowNetwork, bindAll, allowedOrigins, denyNoOrigin });
    corsOriginAllowed.set(req, allowed);
    const canonicalOrigin = origin ? normalizeOrigin(origin) : null;
    if (allowed && canonicalOrigin) {
      // Echo the validated canonical origin (instead of `*`) so configuration,
      // discovery, and the response never disagree about default ports or a
      // syntactically tolerated HTTP(S) trailing slash.
      res.set("Access-Control-Allow-Origin", canonicalOrigin);
      res.set("Access-Control-Expose-Headers", CORS_EXPOSED_HEADERS.join(", "));
    }
    next();
  });

  // Per-IP rate limiting (default 120 req/min) with standard RateLimit headers.
  // Both the bucket math and the IP eviction policy live in the shared
  // rate-limit module — this middleware only owns the response shape.
  const isOwnerDiagnosticRequest = (req: import("express").Request): boolean => {
    // The challenge is deliberately public/read-only and performs only a
    // bounded HMAC over a canonical nonce. Exempting that exact GET cannot
    // bypass MCP auth because the exemption does not apply to any MCP route.
    if (req.method === "GET" && req.path === APP_IDENTITY_CHALLENGE_PATH) {
      const nonce = typeof req.query.nonce === "string" ? req.query.nonce : undefined;
      return (
        appOwnedRuntime && runtimeIdentityProof(appRuntimeOwnerSecret, nonce, process.pid, pkg.version) !== undefined
      );
    }
    if (req.headers[APP_RUNTIME_DIAGNOSTIC_HEADER] !== APP_RUNTIME_DIAGNOSTIC_PROTOCOL) return false;
    if (!appOwnedRuntime || !isGenerationBearer(req.headers.authorization)) return false;
    if (req.method === "GET" && req.path === "/app/runtime-state") return true;
    if (req.path !== "/mcp") return false;
    const nonce = req.headers[APP_RUNTIME_REQUEST_NONCE_HEADER];
    return (
      typeof nonce === "string" &&
      runtimeResponseProof(appRuntimeOwnerSecret, nonce, process.pid, pkg.version, req.method, req.path) !== undefined
    );
  };

  app.use((req, res, next) => {
    if (req.path === "/health" || isOwnerDiagnosticRequest(req)) return next();
    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const verdict = checkIpRateLimit(ip);
    res.set("RateLimit-Limit", String(verdict.limit));
    res.set("RateLimit-Remaining", String(verdict.remaining));
    if (!verdict.allowed) {
      res.set("Retry-After", String(verdict.retryAfterSeconds ?? 60));
      res.status(429).json({ error: "Too many requests. Try again later." });
      return;
    }
    next();
  });

  // Origin validation is deliberately enforced after rate accounting. A
  // denied browser still receives no Access-Control-Allow-Origin header, but
  // it consumes the same per-IP budget as every other HTTP peer.
  app.use((req, res, next) => {
    if (!isCorsRoute(req.path) || corsOriginAllowed.get(req) !== false) return next();
    res.status(403).json({ error: "Forbidden: Origin not allowed" });
  });

  // Answer a valid preflight after the IP bucket has accounted for it but
  // before bearer authentication. This avoids both auth deadlock and an
  // unmetered browser-request path.
  app.use((req, res, next) => {
    if (!isCorsRoute(req.path) || req.method !== "OPTIONS") return next();
    const origin = req.headers.origin;
    const requestedMethod = req.headers["access-control-request-method"]?.toUpperCase();
    if (!origin || !requestedMethod || !(CORS_METHODS as readonly string[]).includes(requestedMethod)) {
      res.status(403).json({ error: "Forbidden: invalid CORS preflight" });
      return;
    }
    const requestedHeaders = (req.headers["access-control-request-headers"] ?? "")
      .split(",")
      .map((header) => header.trim().toLowerCase())
      .filter(Boolean);
    if (requestedHeaders.some((header) => !corsAllowedHeaderNames.has(header))) {
      res.status(403).json({ error: "Forbidden: invalid CORS preflight headers" });
      return;
    }
    res.set("Access-Control-Allow-Methods", CORS_METHODS.join(", "));
    res.set("Access-Control-Allow-Headers", CORS_ALLOWED_HEADERS.join(", "));
    res.status(204).end();
  });

  // Auth middleware — the branch depends on the active network policy.
  // with-oauth* → JWT verify + AsyncLocalStorage scope context.
  // with-token* (legacy) → static Bearer token + constant-time compare.
  // Everything else (loopback-only, unauthenticated) skips both paths.
  const isOAuthPolicy = allowNetwork === "with-oauth" || allowNetwork === "with-oauth+origin";
  const resourceMetadataPath =
    isOAuthPolicy && oauth?.audience
      ? wellKnownPath(oauth.audience, "oauth-protected-resource")
      : "/.well-known/oauth-protected-resource";
  const resourceMetadataUrl =
    isOAuthPolicy && oauth?.audience ? wellKnownUrl(oauth.audience, "oauth-protected-resource") : "";
  const authorizationServerMetadataPath =
    isOAuthPolicy && oauth?.issuer
      ? wellKnownPath(oauth.issuer, "oauth-authorization-server")
      : "/.well-known/oauth-authorization-server";
  const AUTH_SKIP_PATHS = new Set([
    "/health",
    APP_IDENTITY_CHALLENGE_PATH,
    "/.well-known/mcp.json",
    "/.well-known/oauth-protected-resource",
    resourceMetadataPath,
    authorizationServerMetadataPath,
  ]);

  if (isOAuthPolicy && oauth) {
    // RFC 0005 Step 2 — real JWT verification. issuer + audience are
    // guaranteed present at this point by `validateNetworkPolicy`.
    const oauthCfg = {
      issuer: oauth.issuer,
      audience: oauth.audience,
      ...(oauth.jwksUri ? { jwksUri: oauth.jwksUri } : {}),
    };
    app.use((req, res, next) => {
      if (AUTH_SKIP_PATHS.has(req.path)) return next();
      verifyBearer(req.headers.authorization, oauthCfg)
        .then((result: VerifyResult) => {
          if (!result.ok) {
            auditLog({
              timestamp: new Date().toISOString(),
              tool: "__auth_failure",
              args: {
                ip: req.ip ?? req.socket.remoteAddress ?? "unknown",
                path: req.path,
                reason: result.reason,
                userAgent: req.headers["user-agent"] ?? "none",
              },
              status: "error",
            });
            if (result.reason === "jwks_unreachable") {
              // AS-side problem — retry-safe, not a bad-token signal.
              res.set("Retry-After", "10");
              res.status(503).json({ error: "authorization server unavailable" });
              return;
            }
            const errCode =
              result.reason === "expired" || result.reason === "not_yet_valid" || result.reason === "invalid_signature"
                ? "invalid_token"
                : result.reason === "wrong_audience" || result.reason === "wrong_issuer"
                  ? "invalid_token"
                  : "invalid_request";
            res.set(
              "WWW-Authenticate",
              buildBearerChallenge({
                resourceMetadata: resourceMetadataUrl,
                ...(result.reason === "missing_header" ? {} : { error: errCode }),
                scopes: ["mcp:read"],
                ...(result.reason === "missing_header" ? {} : { errorDescription: result.reason }),
              }),
            );
            res.status(401).json({
              error: "Unauthorized",
              code: result.reason === "missing_header" ? "authorization_required" : errCode,
            });
            return;
          }
          // Happy path — claims available to the tool handler via
          // AsyncLocalStorage. The MCP SDK's dispatcher awaits inside
          // the request chain, so async context propagates end-to-end.
          runWithRequestContext({ oauth: result.claims }, () => next());
        })
        .catch((e: unknown) => {
          // Defensive — verifyBearer's contract says it doesn't throw,
          // but a malformed jose dependency update shouldn't take down
          // the server silently.
          log.error("oauth verify internal error", { err: errToCtx(e) });
          res.status(500).json({ error: "Authorization internal error" });
        });
    });
  } else if (httpToken) {
    // Legacy Bearer token. Hash both inputs to a fixed length before
    // timingSafeEqual so the length comparison itself does not become a
    // timing oracle for the token length.
    app.use((req, res, next) => {
      if (AUTH_SKIP_PATHS.has(req.path)) return next();
      const auth = req.headers.authorization;
      if (!acceptsStaticBearer(auth)) {
        // userAgent + reason identify the knocking client class without
        // logging any token material — a bare {ip, path} row proved
        // un-attributable in practice (2026-08: 10 loopback 401s with no
        // way to tell a stale-token client from a token-less prober).
        auditLog({
          timestamp: new Date().toISOString(),
          tool: "__auth_failure",
          args: {
            ip: req.ip ?? req.socket.remoteAddress ?? "unknown",
            path: req.path,
            reason: !auth ? "missing_token" : "wrong_token",
            userAgent: req.headers["user-agent"] ?? "none",
          },
          status: "error",
        });
        res.status(401).json({ error: "Unauthorized: invalid or missing Bearer token" });
        return;
      }
      next();
    });
  }

  // The generation bearer prevents reuse against a later app child, while
  // this per-request response proof demonstrates possession of the current
  // process-generation secret for the separate Streamable HTTP fetch. It does
  // not hash the streamed response body. A listener that
  // replaces the verified child after the challenge can observe only a stale
  // generation bearer; it cannot authenticate an MCP response without the
  // current-user owner secret. Persistent-token clients retain their existing
  // wire contract and do not need this connector-only nonce header.
  app.use((req, res, next) => {
    if (
      (req.path !== "/mcp" && !req.path.startsWith("/app/harness")) ||
      !appOwnedRuntime ||
      !appRuntimeAuthorizationToken ||
      !isGenerationBearer(req.headers.authorization)
    ) {
      return next();
    }
    const nonceHeader = req.headers[APP_RUNTIME_REQUEST_NONCE_HEADER];
    const nonce = typeof nonceHeader === "string" ? nonceHeader : undefined;
    const proof = runtimeResponseProof(appRuntimeOwnerSecret, nonce, process.pid, pkg.version, req.method, req.path);
    if (!proof) {
      res.status(400).json({ error: "Invalid app runtime request nonce" });
      return;
    }
    res.set(APP_RUNTIME_RESPONSE_PROOF_HEADER, proof);
    res.set("Cache-Control", "no-store");
    next();
  });

  // Session controls are native-app actions, not bearer-token MCP capabilities.
  // Require the per-process credential and nonce even on loopback; never let a
  // provider inherit access to these controls through a parent MCP session.
  app.use("/app/harness", (req, res, next) => {
    if (!appOwnedRuntime || !isGenerationBearer(req.headers.authorization) || req.headers.origin) {
      res.status(403).json({ error: "native_app_authorization_required" });
      return;
    }
    next();
  });
  const closeHarness = installHarnessRoutes(app);

  // Parse MCP JSON only after origin, rate-limit, preflight, and authentication
  // gates. The parser's errors are normalized here instead of falling through
  // to Express's development handler, which otherwise returns a stack trace
  // containing local absolute paths to an unauthenticated HTTP peer.
  app.use("/mcp", express.json({ limit: "1mb" }));
  app.use(
    "/mcp",
    (
      error: unknown,
      _req: import("express").Request,
      res: import("express").Response,
      next: import("express").NextFunction,
    ) => {
      const bodyError = error as { status?: unknown; type?: unknown } | null;
      if (!bodyError || typeof bodyError.type !== "string") return next(error);
      const tooLarge = bodyError.status === 413 || bodyError.type === "entity.too.large";
      res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? "JSON body too large" : "Invalid JSON body" });
    },
  );

  // A doctor-marked MCP exchange is intentionally limited to the protocol
  // handshake and tools/list. The rate exemption above additionally requires
  // the current process-generation bearer and response-proof nonce, so merely
  // spoofing this public header never bypasses auth, audit, or rate accounting.
  app.use((req, res, next) => {
    if (req.path !== "/mcp") return next();
    if (req.headers[APP_RUNTIME_DIAGNOSTIC_HEADER] !== APP_RUNTIME_DIAGNOSTIC_PROTOCOL) return next();
    if (!isOwnerDiagnosticRequest(req)) return next();
    if (req.method === "GET" || req.method === "DELETE") return next();
    const method = (req.body as { method?: unknown } | undefined)?.method;
    if (typeof method === "string" && (APP_RUNTIME_DIAGNOSTIC_MCP_METHODS as readonly string[]).includes(method)) {
      return next();
    }
    auditLog({
      timestamp: new Date().toISOString(),
      tool: "__authorization_failure",
      args: { path: req.path, reason: "doctor_probe_method_forbidden" },
      status: "error",
    });
    res.status(403).json({ error: "Forbidden", code: "doctor_probe_method_forbidden" });
  });

  // Native app workflows may span more than one MCP request. Carry their
  // explicit UUID through AsyncLocalStorage so approval events, tool results,
  // telemetry, and typed errors can be rendered as one governed run. Invalid
  // or absent headers are ignored; the tool-registry still generates its
  // normal per-call correlation ID. Preserve any OAuth claims installed by
  // the preceding authentication middleware.
  app.use((req, _res, next) => {
    if (req.path !== "/mcp") return next();
    const correlationId = parseRunCorrelationId(req.headers[RUN_ID_HEADER]);
    if (!correlationId) return next();
    return runWithRequestContext({ ...(getRequestContext() ?? {}), correlationId }, () => next());
  });

  // The legacy `--bind-all without token` fatal path is now subsumed by
  // `validateNetworkPolicy` above — we arrive here only after the policy
  // resolver has confirmed the configuration is internally consistent.

  interface Session {
    transport: StreamableHTTPServerTransport;
    server: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer;
    toolRegistry: ToolRegistry;
    lastActive: number;
    oauthPrincipal?: OAuthSessionPrincipal;
    cleanupEventListeners?: () => void;
  }
  const sessions = new Map<string, Session>();
  // Reserve capacity before the first await in initialize handling. Node runs
  // the check/increment atomically within one event-loop turn; without this
  // counter a burst can have every request observe sessions.size === 0 while
  // warmup/server construction is pending and exceed the configured cap.
  let pendingSessionInitializations = 0;
  let cleanupInterval: ReturnType<typeof setInterval> | undefined;
  let lifecycleClosing = false;
  let resolveLifecycleClosing!: () => void;
  const lifecycleClosingSignal = new Promise<void>((resolve) => {
    resolveLifecycleClosing = resolve;
  });

  const markLifecycleClosing = (): void => {
    if (lifecycleClosing) return;
    lifecycleClosing = true;
    resolveLifecycleClosing();
  };

  function rejectSessionPrincipalMismatch(req: import("express").Request, res: import("express").Response): void {
    auditLog({
      timestamp: new Date().toISOString(),
      tool: "__authorization_failure",
      args: { path: req.path, reason: "session_principal_mismatch" },
      status: "error",
    });
    res.status(403).json({ error: "Forbidden", code: "session_principal_mismatch" });
  }

  function rejectInsufficientScopes(
    req: import("express").Request,
    res: import("express").Response,
    session: Session,
  ): boolean {
    if (!isOAuthPolicy) return false;
    const claims = getOAuthClaims();
    if (!claims) return false;
    const missingScopes = missingScopesForMcpRequest(req.body, session.toolRegistry, claims);
    if (missingScopes.length === 0) return false;
    auditLog({
      timestamp: new Date().toISOString(),
      tool: "__authorization_failure",
      args: { path: req.path, reason: "insufficient_scope", requiredScopes: missingScopes },
      status: "error",
    });
    res.set(
      "WWW-Authenticate",
      buildBearerChallenge({
        resourceMetadata: resourceMetadataUrl,
        error: "insufficient_scope",
        scopes: missingScopes,
        errorDescription: "Additional permission required for this operation",
      }),
    );
    res.status(403).json({
      error: "Forbidden",
      code: "insufficient_scope",
      required_scope: missingScopes.join(" "),
      resource_metadata: resourceMetadataUrl,
    });
    return true;
  }

  /** Clean up all resources for a session (transport, server, event listeners). Idempotent.
   *  Each cleanup step is wrapped individually so a failure in one step does not
   *  prevent the remaining steps from running. */
  function destroySession(id: string, s: Session): void {
    if (!sessions.has(id)) return; // Already destroyed by another async path
    sessions.delete(id);
    try {
      s.cleanupEventListeners?.();
    } catch (e) {
      log.error("session listener cleanup failed", { session: id, err: errToCtx(e) });
    }
    try {
      s.transport.close?.();
    } catch (e) {
      log.error("session transport close failed", { session: id, err: errToCtx(e) });
    }
    try {
      s.server.close?.();
    } catch (e) {
      log.error("session server close failed", { session: id, err: errToCtx(e) });
    }
  }

  // Health check — for load balancers, monitoring, and readiness probes.
  // `appOwned` is deliberately non-sensitive: the macOS app still requires
  // the private bearer token and an MCP round trip before it trusts a listener.
  // The bit only prevents it from adopting/killing a same-token runtime the
  // user launched manually on the reserved port.
  // Warmup owns the authoritative effective module surface. Keep it nullable
  // until createServer has applied module packs and host/OS
  // compatibility; an empty array before then would be false readiness.
  let runtimeModuleState: RuntimeModuleState | null = null;
  let enabledModuleNames: string[] = [];
  let discoveryRegistry: ToolRegistry | null = null;
  let modulesWarming = true;
  let warmupReadiness: HttpWarmupReadiness = "warming";
  let warmupFailure: HttpWarmupFailure | undefined;
  let warmupPromise: Promise<BannerInfo> | null = null;
  let warmupDeadlineTimer: ReturnType<typeof setTimeout> | undefined;
  let warmupDeadlineExpired = false;
  let warmupCancelled = false;
  let semanticIndexRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let semanticIndexRetriesStopped = false;

  const monitorSemanticIndexBuild = (registry: ToolRegistry, build: Promise<number>, nextRetryIndex = 0): void => {
    const scheduleIfNeeded = () => {
      if (semanticIndexRetriesStopped || isToolSearchIndexed(registry)) return;
      const delayMs = SEMANTIC_INDEX_RETRY_DELAYS_MS[nextRetryIndex];
      if (delayMs === undefined) {
        log.warn("semantic tool index warmup retries exhausted", {
          attempts: SEMANTIC_INDEX_RETRY_DELAYS_MS.length + 1,
        });
        return;
      }
      semanticIndexRetryTimer = setTimeout(() => {
        semanticIndexRetryTimer = undefined;
        if (semanticIndexRetriesStopped) return;
        monitorSemanticIndexBuild(registry, indexToolDescriptions(registry), nextRetryIndex + 1);
      }, delayMs);
      semanticIndexRetryTimer.unref?.();
    };
    void build.then(scheduleIfNeeded, (error) => {
      log.error("semantic tool index warmup attempt failed", { err: errToCtx(error) });
      scheduleIfNeeded();
    });
  };
  // Note: session counts and uptime omitted to prevent information leakage.
  app.get("/health", (_req, res) => {
    const ready = warmupReadiness === "ready";
    res.status(ready ? 200 : 503).json({
      status: ready ? "ok" : warmupReadiness,
      readiness: warmupReadiness,
      listener: lifecycleClosing ? "closing" : "listening",
      version: pkg.version,
      appOwned: appOwnedRuntime,
      ...(warmupFailure ? { failure: warmupFailure } : {}),
    });
  });

  // Tokenless server-authentication challenge for the native app. The caller
  // contributes a fresh nonce and verifies the HMAC with the current-user
  // generation secret before deriving authorization scoped to this process.
  app.get(APP_IDENTITY_CHALLENGE_PATH, (req, res) => {
    if (!appOwnedRuntime) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const nonce = typeof req.query.nonce === "string" ? req.query.nonce : undefined;
    const proof = runtimeIdentityProof(appRuntimeOwnerSecret, nonce, process.pid, pkg.version);
    if (!proof) {
      res.status(400).json({ error: "Invalid identity challenge nonce" });
      return;
    }
    res.set("Cache-Control", "no-store");
    res.json({
      status: "ok",
      version: pkg.version,
      appOwned: true,
      pid: process.pid,
      proof,
      responseProof: APP_RUNTIME_RESPONSE_PROOF_SCHEME,
    });
  });

  // Authenticated native-app state: unlike public /health, this may reveal the
  // effective module and HITL policies. Setup uses it to prove the running
  // generation actually parsed the exact scope and per-call approval policy.
  // PID plus the current-user owner fingerprint binds lifecycle control to this
  // exact process instead of every process with a matching command line.
  app.get("/app/runtime-state", (_req, res) => {
    if (!appOwnedRuntime || !httpToken || !appRuntimeOwnerFingerprint) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    if (!runtimeModuleState) {
      res.set("Retry-After", "1");
      res.status(503).json({
        status: warmupReadiness,
        readiness: warmupReadiness,
        listener: lifecycleClosing ? "closing" : "listening",
        error:
          warmupReadiness === "degraded"
            ? "Runtime module surface failed to initialize"
            : "Runtime module surface is still warming",
        ...(warmupFailure ? { failure: warmupFailure } : {}),
      });
      return;
    }
    const disabledModules = [...(serverOptions.config?.disabledModules ?? [])].sort();
    const effectiveHitlWhitelist = [...serverOptions.config.hitl.whitelist].sort();
    res.json({
      status: "ok",
      readiness: "ready",
      listener: lifecycleClosing ? "closing" : "listening",
      version: pkg.version,
      appOwned: appOwnedRuntime,
      pid: process.pid,
      ownerFingerprint: appRuntimeOwnerFingerprint,
      tokenFingerprint: runtimeTokenFingerprint(httpToken),
      bearerEnforcement: {
        scheme: "bearer",
        // These booleans exercise the exact constant-time predicate used by
        // middleware. Doctor can verify rejection semantics without generating
        // live failed-auth audit rows or consuming the shared IP bucket.
        missingRejected: !acceptsStaticBearer(undefined),
        invalidRejected: !acceptsStaticBearer("Bearer taxi-doctor-invalid-v1"),
        persistentAccepted: acceptsStaticBearer(`Bearer ${httpToken}`),
        diagnosticProtocol: APP_RUNTIME_DIAGNOSTIC_PROTOCOL,
      },
      disabledModules,
      scopeFingerprint: runtimeScopeFingerprint(disabledModules),
      enabledModules: runtimeModuleState.enabledModules,
      unavailableModules: runtimeModuleState.unavailableModules,
      effectiveHitlLevel: serverOptions.config.hitl.level,
      effectiveHitlWhitelist,
    });
  });

  // MCP Server Card — .well-known discovery for registry crawlers.
  // Shape + rationale lives in well-known-card.ts; we capture the
  // enabled-module list via closure so it reflects the live module
  // selection once `createServer` runs (depends on config + OS gates).
  // True until the background warmup resolves the live module list. While
  // false the module list is not yet known, so the discovery card must NOT
  // claim `modules: []` — it advertises a `warming` status instead so a
  // crawler hitting the warmup window can distinguish "no modules" from
  // "not resolved yet". Tools are read live from toolRegistry and stay valid.
  app.get("/.well-known/mcp.json", (_req, res) => {
    const card = buildServerCard({
      name: IDENTITY.MCP_SERVER_NAME,
      version: pkg.version,
      description: pkg.description,
      license: pkg.license,
      homepage: pkg.homepage,
      websiteUrl: WEBSITE_URL,
      icon: SERVER_ICON,
      httpToken,
      allowNetwork,
      allowedOrigins: [...allowedOrigins],
      // Read the advertised tools/list inventory at request time so a
      // hot-reload, profile change, or later `listChanged` notification
      // doesn't leave the discovery card stale or wider than active exposure.
      tools: {
        count: discoveryRegistry?.getExposedToolCount() ?? 0,
        names: discoveryRegistry?.getExposedToolNames() ?? [],
      },
      modules: enabledModuleNames,
      oauth: oauth ?? undefined,
    });
    if (modulesWarming) card.warming = true;
    res.json(card);
  });

  // RFC 9728 — OAuth protected resource metadata. Emitted only when
  // the active policy is an OAuth policy AND issuer + audience are
  // both configured (otherwise returning the card with empty fields
  // would mislead Managed Agents into bootstrapping against nothing).
  const serveProtectedResourceMetadata = (_req: import("express").Request, res: import("express").Response) => {
    const isOAuth = allowNetwork === "with-oauth" || allowNetwork === "with-oauth+origin";
    if (!isOAuth || !oauth?.issuer || !oauth.audience) {
      res.status(404).json({ error: "Not Found — server is not in an OAuth policy" });
      return;
    }
    res.json(buildOAuthProtectedResourceCard(oauth.audience, oauth.issuer));
  };
  // The path derived from a path-bearing resource identifier is normative
  // (RFC 9728 §3.1). Keep the legacy root location as an explicit compatibility
  // alias; WWW-Authenticate always points clients at the derived path.
  for (const path of new Set(["/.well-known/oauth-protected-resource", resourceMetadataPath])) {
    app.get(path, serveProtectedResourceMetadata);
  }

  // RFC 8414 metadata publication is opt-in because Taxi remains a resource
  // server by default. It becomes authoritative only when the operator routes
  // the configured issuer origin to this process and provides both endpoints.
  app.get(authorizationServerMetadataPath, (_req, res) => {
    if (
      !isOAuthPolicy ||
      !oauth?.authorizationEndpoint ||
      !oauth.tokenEndpoint ||
      !oauth.tokenEndpointAuthMethods?.length
    ) {
      res.status(404).json({ error: "Not Found — authorization-server metadata is not configured" });
      return;
    }
    res.json(
      buildOAuthAuthorizationServerMetadata({
        issuer: oauth.issuer,
        authorizationEndpoint: oauth.authorizationEndpoint,
        tokenEndpoint: oauth.tokenEndpoint,
        tokenEndpointAuthMethodsSupported: oauth.tokenEndpointAuthMethods,
      }),
    );
  });

  // Reverse-proxy header soft-detection (RFC 0002 Phase 2).
  //
  // Loopback-only servers behind a misconfigured reverse proxy are the
  // motivating threat: Taxi sees 127.0.0.1 and skips auth while the
  // proxy has actually exposed the server on a public interface. If we
  // see `X-Forwarded-*` or a non-loopback Host header, surface it once
  // per process to stderr + audit so operators get a clear nudge to
  // move to `with-token` (or explicitly acknowledge the proxy with an
  // origin allow-list).
  let proxyWarned = false;
  app.use((req, _res, next) => {
    if (proxyWarned || allowNetwork !== "loopback-only") return next();
    const forwardedFor = req.headers["x-forwarded-for"];
    const forwardedHost = req.headers["x-forwarded-host"];
    const realIp = req.headers["x-real-ip"];
    const host = (req.headers.host as string | undefined) ?? "";
    const hostIsRemote =
      host !== "" &&
      !/^localhost(:\d+)?$/.test(host) &&
      !/^127\.0\.0\.1(:\d+)?$/.test(host) &&
      !/^\[::1\](:\d+)?$/.test(host);
    if (forwardedFor || forwardedHost || realIp || hostIsRemote) {
      proxyWarned = true;
      const signals = [
        forwardedFor && `X-Forwarded-For=${String(forwardedFor).slice(0, 64)}`,
        forwardedHost && `X-Forwarded-Host=${String(forwardedHost).slice(0, 64)}`,
        realIp && `X-Real-IP=${String(realIp).slice(0, 64)}`,
        hostIsRemote && `Host=${host}`,
      ]
        .filter(Boolean)
        .join(", ");
      log.warn("proxy signal detected on a loopback-only server", {
        signals,
        remediation:
          'If Taxi is reachable from outside this machine, set TAXI_ALLOW_NETWORK="with-token" (or "with-token+origin") + TAXI_HTTP_TOKEN. This warning fires once per process.',
      });
      auditLog({
        timestamp: new Date().toISOString(),
        tool: "__proxy_signal_detected",
        args: { signals, policy: allowNetwork },
        status: "ok",
      });
    }
    next();
  });

  const rejectClosingInitialize = (res: import("express").Response): void => {
    if (res.headersSent || res.writableEnded) return;
    res.set("Retry-After", "1");
    res.status(503).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Runtime lifecycle is closing" },
      id: null,
    });
  };

  const disposeUnadoptedServer = (
    created: Awaited<ReturnType<typeof createServer>>,
    context: "warmup" | "session",
  ): void => {
    try {
      created.cleanupEventListeners();
    } catch (error) {
      log.error(`HTTP ${context} listener cleanup failed`, { err: errToCtx(error) });
    }
    void Promise.resolve(created.server.close?.()).catch((error) => {
      log.error(`HTTP ${context} server close failed`, { err: errToCtx(error) });
    });
  };

  app.post("/mcp", async (req, res) => {
    let initializationReserved = false;
    try {
      if (lifecycleClosing) {
        rejectClosingInitialize(res);
        return;
      }
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      const requestPrincipal = toOAuthSessionPrincipal(getOAuthClaims());

      const existing = sessionId ? sessions.get(sessionId) : undefined;
      if (existing) {
        if (!isSameOAuthSessionPrincipal(existing.oauthPrincipal, requestPrincipal)) {
          rejectSessionPrincipalMismatch(req, res);
          return;
        }
        if (rejectInsufficientScopes(req, res, existing)) return;
        existing.lastActive = Date.now();
        await existing.transport.handleRequest(req, res, req.body);
        return;
      }

      if (sessionId || !isInitializeRequest(req.body)) {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Bad Request: No valid session ID provided" },
          id: null,
        });
        return;
      }

      if (sessions.size + pendingSessionInitializations >= LIMITS.HTTP_SESSIONS) {
        res.status(503).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Too many concurrent sessions. Try again later." },
          id: null,
        });
        return;
      }
      pendingSessionInitializations += 1;
      initializationReserved = true;

      // The listening socket intentionally comes up before module warmup, but
      // an MCP initialize must use the exact catalog warmup resolved. Await the
      // single process warmup instead of constructing and embedding another
      // catalog in parallel. Health and runtime-state remain independently
      // available while this wait is in progress.
      if (!warmupPromise) {
        res.set("Retry-After", "1");
        res.status(503).json({ error: "Runtime module surface is still warming" });
        return;
      }
      const warmupOutcome = await Promise.race([
        warmupPromise.then(
          () => "ready" as const,
          () => "failed" as const,
        ),
        lifecycleClosingSignal.then(() => "closing" as const),
      ]);
      if (warmupOutcome !== "ready" || lifecycleClosing) {
        rejectClosingInitialize(res);
        return;
      }
      if (req.aborted || res.writableEnded) return;

      const semanticIndex = discoveryRegistry
        ? ({ mode: "reuse", source: discoveryRegistry } as const)
        : ({ mode: "disabled" } as const);
      const sessionCreation = createServer({
        ...serverOptions,
        semanticIndex,
        skillLifecycle: "session",
      });
      const creationOutcome = await Promise.race([
        sessionCreation.then((created) => ({ kind: "created" as const, created })),
        lifecycleClosingSignal.then(() => ({ kind: "closing" as const })),
      ]);
      if (creationOutcome.kind === "closing") {
        // The constructor may not be cancellable. If it eventually completes,
        // dispose its listeners/server without ever exposing a session.
        void sessionCreation.then(
          (created) => disposeUnadoptedServer(created, "session"),
          (error) => log.error("HTTP session initialization failed after shutdown", { err: errToCtx(error) }),
        );
        rejectClosingInitialize(res);
        return;
      }
      const { server, toolRegistry, cleanupEventListeners } = creationOutcome.created;
      let assignedSessionId: string | undefined;
      let transport: StreamableHTTPServerTransport | undefined;

      try {
        if (lifecycleClosing) {
          rejectClosingInitialize(res);
          return;
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            if (lifecycleClosing) return;
            assignedSessionId = id;
            sessions.set(id, {
              transport: transport!,
              server,
              toolRegistry,
              lastActive: Date.now(),
              oauthPrincipal: requestPrincipal,
              cleanupEventListeners,
            });
          },
          onsessionclosed: (id) => {
            const s = sessions.get(id);
            if (s) destroySession(id, s);
          },
        });

        // Immediate cleanup when transport closes (don't wait for 60s cleanup interval)
        transport.onclose = () => {
          if (assignedSessionId) {
            const s = sessions.get(assignedSessionId);
            if (s) destroySession(assignedSessionId, s);
          }
        };

        await server.connect(transport);
        if (lifecycleClosing) {
          rejectClosingInitialize(res);
          return;
        }
        await transport.handleRequest(req, res, req.body);
      } finally {
        // A rejected/cancelled initialize never enters `sessions`, so it has no
        // destroySession path. Release its event listeners and server here.
        if (!assignedSessionId) {
          if (transport) transport.onclose = undefined;
          try {
            cleanupEventListeners();
          } catch (error) {
            log.error("provisional session listener cleanup failed", { err: errToCtx(error) });
          }
          await Promise.resolve(server.close?.()).catch((error) => {
            log.error("provisional session server close failed", { err: errToCtx(error) });
          });
        }
      }
    } catch (err) {
      log.error("POST /mcp request failed", { err: errToCtx(err) });
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal error" },
          id: null,
        });
      }
    } finally {
      if (initializationReserved) pendingSessionInitializations -= 1;
    }
  });

  // Shared handler for GET/DELETE (SSE streaming + session close)
  const handleSessionRequest = async (
    req: import("express").Request,
    res: import("express").Response,
    method: string,
  ) => {
    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      const s = sessionId ? sessions.get(sessionId) : undefined;
      if (!s) {
        res.status(400).json({ error: "Invalid or missing session ID" });
        return;
      }
      const requestPrincipal = toOAuthSessionPrincipal(getOAuthClaims());
      if (!isSameOAuthSessionPrincipal(s.oauthPrincipal, requestPrincipal)) {
        rejectSessionPrincipalMismatch(req, res);
        return;
      }
      s.lastActive = Date.now();

      // For SSE GET streams: clean up immediately when the client disconnects
      // (don't wait for the 60s cleanup interval). Without this, abrupt disconnects
      // leave transport buffers + ReadableStream controllers in memory until idle timeout.
      if (method === "GET" && sessionId) {
        const sid = sessionId;
        res.on("close", () => {
          const entry = sessions.get(sid);
          if (entry) destroySession(sid, entry);
        });
      }

      await s.transport.handleRequest(req, res);
    } catch (err) {
      log.error("session request failed", { method, err: errToCtx(err) });
    }
  };

  app.get("/mcp", (req, res) => handleSessionRequest(req, res, "GET"));
  app.delete("/mcp", (req, res) => handleSessionRequest(req, res, "DELETE"));

  const host = bindAll ? "0.0.0.0" : "127.0.0.1";
  let expectedListenerClose = false;
  let lifecycleDisposed = false;
  let processOwnerServer: import("@modelcontextprotocol/sdk/server/mcp.js").McpServer | undefined;
  let processOwnerCleanup: (() => void) | undefined;

  const disposeProcessOwner = (): void => {
    const cleanup = processOwnerCleanup;
    const server = processOwnerServer;
    processOwnerCleanup = undefined;
    processOwnerServer = undefined;
    try {
      cleanup?.();
    } catch (error) {
      log.error("HTTP process-owner listener cleanup failed", { err: errToCtx(error) });
    }
    void Promise.resolve(server?.close?.()).catch((error) => {
      log.error("HTTP process-owner server close failed", { err: errToCtx(error) });
    });
  };
  const httpServer = app.listen(port, host);
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.once("listening", async () => {
      httpServer.off("error", reject);
      // Keep a permanent error handler after the socket is bound. Without it a
      // post-listen server "error" (accept failure under fd exhaustion, late
      // EADDR change, etc.) has no listener, so Node throws it as an uncaught
      // exception and the whole MCP server crashes. Log and keep serving.
      httpServer.on("error", (err) => log.error("http server error (post-listen)", { err: errToCtx(err) }));
      try {
        if (bindAll)
          log.warn("bound to all interfaces", {
            host: "0.0.0.0",
            port,
            auth: httpToken ? "token" : "NONE",
          });
        resolve();
      } catch (e) {
        reject(e);
      }
    });
  });
  const releaseRatePruner = acquireRatePruner();
  // Session cleanup is listener-owned. Creating it before listen succeeds
  // leaks a live interval when bind rejects (for example EADDRINUSE).
  cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const id of [...sessions.keys()]) {
      const s = sessions.get(id);
      if (s && now - s.lastActive > TIMEOUT.SESSION_IDLE) {
        destroySession(id, s);
      }
    }
  }, TIMEOUT.SESSION_CLEANUP);
  cleanupInterval.unref?.();
  // `close` can otherwise only tell us that the listener disappeared, not
  // whether an owner deliberately closed it. Mark every public/internal
  // server.close() call before delegating so an uninitiated close event can be
  // treated as an app-runtime crash without penalizing direct runtimes.
  const closeHttpServer = httpServer.close.bind(httpServer);
  httpServer.close = ((callback?: (error?: Error) => void) => {
    expectedListenerClose = true;
    markLifecycleClosing();
    return closeHttpServer(callback);
  }) as typeof httpServer.close;
  // Start the one process-wide catalog warmup only after the socket has
  // definitely bound. /health can therefore distinguish listener readiness
  // from module/semantic readiness, and no expensive work runs for a launch
  // that loses an EADDRINUSE race.
  const processWarmup = Promise.resolve().then(() =>
    createServer({
      ...serverOptions,
      semanticIndex: { mode: "build" },
      skillLifecycle: "process-owner",
    }),
  );
  const boundedWarmup = processWarmup.then((created) => {
    if (warmupDeadlineExpired || warmupCancelled || lifecycleClosing) {
      disposeUnadoptedServer(created, "warmup");
      throw new Error("HTTP process warmup completed after lifecycle close");
    }
    const {
      bannerInfo: bi,
      server: warmupServer,
      toolRegistry: warmupRegistry,
      runtimeModuleState: warmedRuntimeModuleState,
      cleanupEventListeners: warmupCleanup,
      semanticIndexBuild,
    } = created;
    // Unlike an ordinary cache warmup, this server/registry pair owns daemon
    // skill triggers for the whole HTTP listener lifetime. Per-session servers
    // are disposable and never replace it. If close raced warmup, dispose now.
    processOwnerServer = warmupServer;
    processOwnerCleanup = warmupCleanup;
    if (lifecycleDisposed) disposeProcessOwner();
    // Publish the resolved enabled-module list into the .well-known
    // card's closure so registry crawlers see what's actually loaded
    // on this host (module enablement depends on config + OS gates).
    runtimeModuleState = warmedRuntimeModuleState;
    enabledModuleNames = warmedRuntimeModuleState.enabledModules;
    discoveryRegistry = warmupRegistry;
    modulesWarming = false;
    warmupReadiness = "ready";
    if (serverOptions.config?.features?.semanticToolSearch === true) {
      monitorSemanticIndexBuild(warmupRegistry, semanticIndexBuild ?? indexToolDescriptions(warmupRegistry));
    }
    return bi;
  });
  const warmupDeadline = new Promise<never>((_resolve, reject) => {
    warmupDeadlineTimer = setTimeout(() => {
      warmupDeadlineTimer = undefined;
      warmupDeadlineExpired = true;
      reject(new Error(`HTTP process warmup exceeded ${HTTP_PROCESS_WARMUP_DEADLINE_MS}ms`));
    }, HTTP_PROCESS_WARMUP_DEADLINE_MS);
    warmupDeadlineTimer.unref?.();
  });
  warmupPromise = Promise.race([boundedWarmup, warmupDeadline]);
  void warmupPromise.then(
    (bi) => {
      if (warmupDeadlineTimer) {
        clearTimeout(warmupDeadlineTimer);
        warmupDeadlineTimer = undefined;
      }
      const address = httpServer.address();
      bi.transport = "http";
      bi.port = address && typeof address !== "string" ? address.port : port;
      void Promise.resolve(printBanner(bi)).catch((error) => {
        log.error("HTTP banner failed", { err: errToCtx(error) });
      });
    },
    (err) => {
      if (warmupDeadlineTimer) {
        clearTimeout(warmupDeadlineTimer);
        warmupDeadlineTimer = undefined;
      }
      // Explicit close can race an uncancellable constructor. Its eventual
      // completion is disposed above and is not a startup failure.
      if ((warmupCancelled || lifecycleClosing) && !warmupDeadlineExpired) return;
      warmupReadiness = "degraded";
      warmupFailure = warmupDeadlineExpired ? "deadline_exceeded" : "initialization_failed";
      log.error("HTTP prewarm failed", { err: errToCtx(err) });
      auditLog({
        timestamp: new Date().toISOString(),
        tool: "__http_prewarm_failed",
        args: { transport: "http", error: err instanceof Error ? err.message : String(err) },
        status: "error",
      });
      beginFatalWarmupShutdown();
    },
  );

  // One server lifecycle owns one idle-session timer, one process exit
  // listener, and one async shutdown hook. Explicit `server.close()` must
  // release all three; otherwise an embedded/repeated start-close cycle keeps
  // the whole server closure alive until process exit. The process-wide IP
  // prune timer is shared by active listeners and released when this listener
  // closes; the last listener tears the timer down.
  let parentWatchdog: ReturnType<typeof setInterval> | undefined;
  let appOwnedTerminationStarted = false;
  let fatalWarmupShutdownStarted = false;

  const stopWarmupDeadline = (): void => {
    warmupCancelled = true;
    if (!warmupDeadlineTimer) return;
    clearTimeout(warmupDeadlineTimer);
    warmupDeadlineTimer = undefined;
  };

  const stopSemanticIndexRetries = (): void => {
    semanticIndexRetriesStopped = true;
    if (semanticIndexRetryTimer) {
      clearTimeout(semanticIndexRetryTimer);
      semanticIndexRetryTimer = undefined;
    }
  };

  const stopParentWatchdog = (): void => {
    if (!parentWatchdog) return;
    clearInterval(parentWatchdog);
    parentWatchdog = undefined;
  };

  const disposeLifecycle = (): void => {
    if (lifecycleDisposed) return;
    lifecycleDisposed = true;
    void closeHarness();
    markLifecycleClosing();
    if (cleanupInterval) {
      clearInterval(cleanupInterval);
      cleanupInterval = undefined;
    }
    releaseRatePruner();
    disposeProcessOwner();
    stopWarmupDeadline();
    stopSemanticIndexRetries();
    stopParentWatchdog();
    process.off("exit", onProcessExit);
    unregisterShutdownHook(shutdownHook);
  };

  function beginFatalWarmupShutdown(): void {
    if (fatalWarmupShutdownStarted) return;
    fatalWarmupShutdownStarted = true;
    // `startHttpServer()` has already returned once the listener binds, so a
    // later warmup failure cannot propagate through main(). Closing every
    // listener-owned resource lets the CLI terminate naturally; exitCode keeps
    // that termination fatal while embedded callers still receive close events.
    process.exitCode = 1;
    markLifecycleClosing();
    void runShutdownHooks().catch((error) => {
      log.error("HTTP fatal warmup shutdown failed", { err: errToCtx(error) });
    });
  }

  const beginAppOwnedGracefulShutdown = (reason: "parent_lost" | "listener_closed"): void => {
    if (!appOwnedRuntime || appOwnedTerminationStarted) return;
    appOwnedTerminationStarted = true;
    markLifecycleClosing();
    stopSemanticIndexRetries();
    stopParentWatchdog();
    log.warn("app-owned runtime lost its owning lifecycle; starting graceful shutdown", {
      reason,
      originalParentPid: originalAppRuntimeParentPid,
      currentParentPid: process.ppid,
    });
    try {
      // initializeServer owns SIGTERM and routes it through the existing
      // async shutdown hooks, audit finalizer, Swift cleanup, and exit path.
      process.kill(process.pid, "SIGTERM");
    } catch (error) {
      log.error("failed to signal orphaned app-owned runtime", { err: errToCtx(error) });
    }
  };

  function onProcessExit(): void {
    void closeHarness();
    markLifecycleClosing();
    disposeLifecycle();
    httpServer.close();
  }

  async function shutdownHook(): Promise<void> {
    await closeHarness();
    // Unregister first so an already-completed shutdown cannot be retained or
    // executed again. runShutdownHooks() iterates a snapshot, so removing this
    // callback while it is running does not disturb the audit finalizer stage.
    markLifecycleClosing();
    disposeLifecycle();
    // Tear down active sessions so SSE streams close cleanly and HITL
    // timers stop. `destroySession` is idempotent — duplicate calls from
    // transport.onclose / onsessionclosed racing with this path are safe.
    for (const [id, s] of [...sessions.entries()]) destroySession(id, s);
    await new Promise<void>((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve();
      };
      const timeout = setTimeout(done, 3000);
      httpServer.close(() => done());
    });
  }

  registerShutdownHook(shutdownHook);
  process.on("exit", onProcessExit);
  httpServer.once("close", () => {
    markLifecycleClosing();
    if (appOwnedRuntime && !expectedListenerClose && !appOwnedTerminationStarted) {
      // Keep the shutdown hook registered until self-SIGTERM runs it. The
      // listener is already gone, but active MCP sessions and global runtime
      // resources still need the normal graceful teardown path.
      beginAppOwnedGracefulShutdown("listener_closed");
      return;
    }
    disposeLifecycle();
  });

  if (originalAppRuntimeParentPid !== undefined) {
    parentWatchdog = setInterval(() => {
      if (appOwnedTerminationStarted) return;
      const currentParentPid = process.ppid;
      // Do not probe a PID that is no longer our parent: it may already have
      // been recycled for an unrelated process. Reparenting alone is decisive.
      const parentIsAlive =
        currentParentPid === originalAppRuntimeParentPid && isProcessAlive(originalAppRuntimeParentPid);
      if (
        !shouldTerminateOrphanedAppRuntime(
          originalAppRuntimeParentPid,
          currentParentPid,
          parentIsAlive,
          appOwnedTerminationStarted,
        )
      ) {
        return;
      }
      beginAppOwnedGracefulShutdown("parent_lost");
    }, 1000);
    parentWatchdog.unref?.();
  }
  return httpServer;
}
