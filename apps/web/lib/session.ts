/**
 * Session cookie helpers — Edge-runtime compatible via Web Crypto API.
 *
 * Cookie name: nara_session
 * Payload: base64url(json) + "." + hmac(signing_secret, payload)
 *
 * Works in BOTH Next.js middleware (Edge runtime, no node:crypto) and
 * API routes (Node runtime). Uses globalThis.crypto.subtle everywhere.
 */
import type { NextRequest } from "next/server";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "nara_session";
const DEFAULT_TTL_SEC = 60 * 60 * 24; // 24h local session (revalidated against portal)

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

// ---- base64url helpers (no Buffer — Edge-safe) ----
function b64urlEncodeBytes(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlEncodeString(s: string): string {
  const bytes = new TextEncoder().encode(s);
  return b64urlEncodeBytes(bytes);
}
function b64urlDecodeToString(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

async function hmacSha256(secretKey: string, data: string): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await globalThis.crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return b64urlEncodeBytes(new Uint8Array(sig));
}

function timingSafeEqualStr(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function encodeSession(payload: SessionPayload): Promise<string> {
  const body = b64urlEncodeString(JSON.stringify(payload));
  const sig = await hmacSha256(secret(), body);
  return `${body}.${sig}`;
}

export async function decodeSession(token: string): Promise<SessionPayload | null> {
  if (!token) return null;
  const idx = token.indexOf(".");
  if (idx < 0) return null;
  const body = token.slice(0, idx);
  const sig = token.slice(idx + 1);
  const expected = await hmacSha256(secret(), body);
  if (!timingSafeEqualStr(sig, expected)) return null;
  try {
    const payload = JSON.parse(b64urlDecodeToString(body)) as SessionPayload;
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

/** Read + verify session from an incoming middleware request. */
export async function readSessionFromRequest(req: NextRequest): Promise<SessionPayload | null> {
  const raw = req.cookies.get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  return decodeSession(raw);
}

/** Read + verify session inside route handler / server component. */
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
