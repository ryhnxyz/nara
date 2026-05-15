/**
 * Mystr Portal v2 server-side helpers.
 *
 * All calls happen server-side only. API key + signing secret NEVER reach the
 * browser. Env vars required:
 *   PORTAL_API_KEY
 *   PORTAL_SIGNING_SECRET
 *   PORTAL_APP_NAME   (optional, defaults to "nara-dashboard")
 *   PORTAL_BASE_URL   (optional, defaults to https://portal.mystr.xyz)
 */
import crypto from "node:crypto";

export const PORTAL_BASE_URL = (process.env.PORTAL_BASE_URL ?? "https://portal.mystr.xyz").replace(/\/$/, "");
export const PORTAL_APP_NAME = process.env.PORTAL_APP_NAME ?? "nara-dashboard";

export function portalApiKey(): string {
  const k = process.env.PORTAL_API_KEY;
  if (!k) throw new Error("PORTAL_API_KEY not configured");
  return k;
}

export function portalSigningSecret(): string {
  const s = process.env.PORTAL_SIGNING_SECRET;
  if (!s) throw new Error("PORTAL_SIGNING_SECRET not configured");
  return s;
}

/**
 * Deterministic JSON serialization matching portal `sortedJSON`.
 * Keys are sorted alphabetically at every nesting level.
 */
function sortedStringify(obj: unknown): string {
  if (obj === null || obj === undefined) return "";
  if (typeof obj !== "object") return String(obj);
  if (Array.isArray(obj)) return "[" + obj.map(sortedStringify).join(",") + "]";
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + sortedStringify((obj as Record<string, unknown>)[k])).join(",") +
    "}"
  );
}


/**
 * Unified signature for ALL portal endpoints.
 * Canonical payload (per portal server/security.ts validator):
 *   payload = `${timestamp}.${apiKey}.${sha256(sortedStringify(body))}`
 *   sign    = HMAC-SHA256(signing_secret, payload).hex
 * Timestamp is in SECONDS.
 */
export function signGatewayInit(
  apiKey: string,
  signingSecret: string,
  body: Record<string, unknown>,
  timestamp: number,
): string {
  const bodyHash = crypto.createHash("sha256").update(sortedStringify(body)).digest("hex");
  const payload = `${timestamp}.${apiKey}.${bodyHash}`;
  return crypto.createHmac("sha256", signingSecret).update(payload).digest("hex");
}

/**
 * Signature for server-to-server signed endpoints (check-whitelist, verify-token, etc.).
 * Different format: `${timestamp}.${api_key}.${sha256(sortedBody)}` with seconds timestamp.
 * Sent via X-Timestamp + X-Sign headers.
 */
export function signServerRequest(
  apiKey: string,
  signingSecret: string,
  body: unknown,
): { timestamp: number; sign: string } {
  const timestamp = Math.floor(Date.now() / 1000);
  const bodyHash = crypto.createHash("sha256").update(sortedStringify(body)).digest("hex");
  const payload = `${timestamp}.${apiKey}.${bodyHash}`;
  const sign = crypto.createHmac("sha256", signingSecret).update(payload).digest("hex");
  return { timestamp, sign };
}

/**
 * Pull the real end-user IP from incoming request headers.
 * We use this to forward X-Forwarded-For to the portal so its IP-based rate limiter
 * charges the actual user, not our VPS.
 */
export function clientIpFromHeaders(headers: Headers): string | null {
  const xff = headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  const real = headers.get("x-real-ip");
  if (real) return real.trim();
  const cf = headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  return null;
}

function buildForwardHeaders(clientIp?: string | null, clientUa?: string | null): HeadersInit {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (clientIp) {
    h["X-Forwarded-For"] = clientIp;
    h["X-Real-IP"] = clientIp;
    h["CF-Connecting-IP"] = clientIp;
  }
  if (clientUa) h["User-Agent"] = clientUa;
  return h;
}

/** Initialize a gateway session handle and return the URL user should be redirected to. */
export async function initGatewaySession(
  redirectUri: string,
  state: string,
  clientIp?: string | null,
  clientUa?: string | null,
): Promise<string> {
  const apiKey = portalApiKey();
  const signingSecret = portalSigningSecret();
  const body = { app_name: PORTAL_APP_NAME, redirect_uri: redirectUri, state };
  const timestamp = Math.floor(Date.now() / 1000);
  const sign = signGatewayInit(apiKey, signingSecret, body, timestamp);

  const r = await fetch(`${PORTAL_BASE_URL}/api/gateway/init`, {
    method: "POST",
    headers: buildForwardHeaders(clientIp, clientUa),
    body: JSON.stringify({ api_key: apiKey, ...body, timestamp, sign }),
    cache: "no-store",
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => r.statusText);
    throw new Error(`gateway init failed: ${r.status} ${txt.slice(0, 300)}`);
  }

  const data = (await r.json()) as { gateway_url?: string; error?: string };
  if (!data.gateway_url) throw new Error(`gateway init no url: ${data.error ?? "unknown"}`);
  return data.gateway_url;
}

export type VerifyTokenResult =
  | {
      valid: true;
      claims: {
        sub?: string;
        email: string;
        app_name: string;
        whitelisted: boolean;
        membership: { plan: string; expires_at: string; scope: string } | null;
        auth_method: "password" | "passkey";
        sid?: string;
        fp?: string;
        session_id?: string;
        iat: number;
        exp: number;
      };
    }
  | { valid: false; reason: string };

/**
 * Verify a JWT issued by the portal (recommended path — no local JWT parsing).
 * Also validates against server-side revocation + session state.
 */
export async function verifyPortalToken(token: string, sessionId?: string): Promise<VerifyTokenResult> {
  const apiKey = portalApiKey();
  const signingSecret = portalSigningSecret();
  const body: Record<string, unknown> = { api_key: apiKey, token };
  if (sessionId) body.session_id = sessionId;
  const { timestamp, sign } = signServerRequest(apiKey, signingSecret, body);

  const r = await fetch(`${PORTAL_BASE_URL}/api/functions/v1/verify-token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Timestamp": String(timestamp),
      "X-Sign": sign,
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });

  if (!r.ok) {
    const txt = await r.text().catch(() => r.statusText);
    return { valid: false, reason: `upstream_${r.status}: ${txt.slice(0, 120)}` };
  }
  return (await r.json()) as VerifyTokenResult;
}

/**
 * Re-validate whitelist (defence against revocation).
 * Returns true if user still allowed, false otherwise.
 */
export async function checkWhitelist(email: string): Promise<boolean> {
  const apiKey = portalApiKey();
  const signingSecret = portalSigningSecret();
  const body = { api_key: apiKey, email, app_name: PORTAL_APP_NAME };
  const { timestamp, sign } = signServerRequest(apiKey, signingSecret, body);

  const r = await fetch(`${PORTAL_BASE_URL}/api/functions/v1/check-whitelist`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Timestamp": String(timestamp),
      "X-Sign": sign,
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!r.ok) return false;
  const data = (await r.json()) as { allowed?: boolean };
  return data.allowed === true;
}

/**
 * Fire-and-forget analytics ping. Never throws — errors swallowed so it can't
 * break user flows.
 */
export function trackAnalytics(type: "visit" | "user", email?: string): void {
  const apiKey = process.env.PORTAL_API_KEY;
  if (!apiKey) return;
  const body: Record<string, unknown> = { api_key: apiKey, app_name: PORTAL_APP_NAME, type };
  if (type === "user" && email) body.email = email;
  fetch(`${PORTAL_BASE_URL}/api/functions/v1/report-analytics`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  }).catch(() => {});
}

/**
 * Check if a session is still active (polling for revocation).
 */
export async function checkPortalSession(sessionId: string): Promise<boolean> {
  const apiKey = portalApiKey();
  const signingSecret = portalSigningSecret();
  const body = { api_key: apiKey, session_id: sessionId };
  const { timestamp, sign } = signServerRequest(apiKey, signingSecret, body);

  const r = await fetch(`${PORTAL_BASE_URL}/api/functions/v1/check-session`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Timestamp": String(timestamp),
      "X-Sign": sign,
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!r.ok) return false;
  const data = (await r.json()) as { active?: boolean };
  return data.active === true;
}
