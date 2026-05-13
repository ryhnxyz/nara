/**
 * Session cookie helpers (httpOnly, encrypted-ish via HMAC signing).
 *
 * Cookie name: nara_session
 * Payload: base64url(json) + "." + hmac(signing_secret, payload)
 *
 * Contains: { email, appName, whitelisted, sid, exp }
 * We don't need to store the raw JWT because the portal already verified it;
 * re-validation happens on each sensitive call via checkWhitelist/verify-token.
 */
import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "nara_session";
const DEFAULT_TTL_SEC = 60 * 60 * 24; // 24h local session regardless of portal JWT exp (we revalidate)

export interface SessionPayload {
  email: string;
  appName: string;
  whitelisted: boolean;
  sid?: string;
  exp: number; // unix seconds
}

function secret(): string {
  const s = process.env.PORTAL_SIGNING_SECRET || process.env.SESSION_SECRET;
  if (!s) throw new Error("PORTAL_SIGNING_SECRET (or SESSION_SECRET) not set");
  return s;
}

function b64urlEncode(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}
function b64urlDecode(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

export function encodeSession(payload: SessionPayload): string {
  const body = b64urlEncode(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function decodeSession(token: string): SessionPayload | null {
  if (!token) return null;
  const idx = token.indexOf(".");
  if (idx < 0) return null;
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  // Constant-time compare
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(body).toString("utf8")) as SessionPayload;
    if (!payload || typeof payload !== "object") return null;
    if (typeof payload.exp !== "number") return null;
    if (payload.exp * 1000 < Date.now()) return null;
    if (typeof payload.email !== "string" || !payload.email.includes("@")) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Build a new session payload with default TTL. */
export function buildSession(
  email: string,
  appName: string,
  whitelisted: boolean,
  sid?: string,
  ttlSec: number = DEFAULT_TTL_SEC,
): SessionPayload {
  return {
    email: email.toLowerCase().trim(),
    appName,
    whitelisted,
    sid,
    exp: Math.floor(Date.now() / 1000) + ttlSec,
  };
}

/** Read session from an incoming middleware request. */
export function readSessionFromRequest(req: NextRequest): SessionPayload | null {
  const raw = req.cookies.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  return decodeSession(raw);
}

/** Read session inside route handler / server component. */
export async function readSessionFromCookies(): Promise<SessionPayload | null> {
  const store = await cookies();
  const raw = store.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  return decodeSession(raw);
}

export const SESSION_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: DEFAULT_TTL_SEC,
};
