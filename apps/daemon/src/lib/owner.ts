/**
 * Multi-tenant owner isolation helpers.
 *
 * Every API request from the Next.js web app carries an `x-owner-email` header
 * injected by the /api/daemon/* proxy after session cookie verification.
 * Routes read this via ownerFromContext() and filter DB queries accordingly.
 *
 * Workers (hunt, distribute) do NOT use this — they iterate all agents across
 * all owners. Each agent row carries owner_email, so per-user dashboards show
 * only that user's runs.
 */
import type { Context, MiddlewareHandler } from "hono";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { env } from "./env";

export const OWNER_HEADER = "x-owner-email";

/**
 * Extract authenticated owner email from request context.
 * Returns null if no header (public endpoint or misconfigured proxy).
 */
export function ownerFromContext(c: Context): string | null {
  const h = c.req.header(OWNER_HEADER);
  if (!h) return null;
  const trimmed = h.trim().toLowerCase();
  if (!trimmed.includes("@") || trimmed.length > 200) return null;
  return trimmed;
}

/**
 * Middleware that enforces owner presence. Reject requests without header.
 * Mount on routes that require authenticated user scope.
 */
export const requireOwner: MiddlewareHandler = async (c, next) => {
  const owner = ownerFromContext(c);
  if (!owner) return c.json({ error: "unauthorized: missing x-owner-email" }, 401);
  c.set("ownerEmail", owner);
  return next();
};

/**
 * Stable short hash of email for filesystem path segments.
 * Used to namespace wallet directories per-user without leaking the address.
 */
export function ownerSlug(email: string): string {
  return createHash("sha256").update(email.toLowerCase().trim()).digest("hex").slice(0, 16);
}

/**
 * Resolve wallet directory for a specific owner.
 * Layout:  <walletsDir>/<ownerSlug>/<agentId>.json
 */
export function ownerWalletsDir(email: string): string {
  return resolve(env.walletsDir, ownerSlug(email));
}

/**
 * Resolve master wallet file path for a specific owner.
 * Layout:  <walletsDir>/../master-wallets/<ownerSlug>.json
 */
export function ownerMasterWalletPath(email: string): string {
  return resolve(env.walletsDir, "..", "master-wallets", `${ownerSlug(email)}.json`);
}
