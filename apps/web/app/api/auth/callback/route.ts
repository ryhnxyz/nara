import { NextRequest, NextResponse } from "next/server";
import { verifyPortalToken, checkWhitelist, trackAnalytics, PORTAL_APP_NAME } from "@/lib/portal";
import { SESSION_COOKIE, SESSION_COOKIE_OPTIONS, buildSession, encodeSession } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Portal redirects here after login with ?token=<jwt>&email=<email>.
 * We verify server-side, re-check whitelist, then set session cookie + redirect home.
 */
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const token = url.searchParams.get("token");
  const emailFromUrl = url.searchParams.get("email");
  const stateFromUrl = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  const origin = process.env.NEXT_PUBLIC_APP_ORIGIN || url.origin;

  if (error) {
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(error)}`, origin));
  }
  if (!token) {
    return NextResponse.redirect(new URL("/login?error=missing_token", origin));
  }

  // Optional CSRF state validation (init-sso set nara_oauth_state cookie)
  const cookieState = req.cookies.get("nara_oauth_state")?.value;
  if (stateFromUrl && cookieState && stateFromUrl !== cookieState) {
    return NextResponse.redirect(new URL("/login?error=state_mismatch", origin));
  }

  // Verify token via portal (recommended path — no local JWT parsing)
  const verified = await verifyPortalToken(token);
  if (!verified.valid) {
    return NextResponse.redirect(new URL(`/login?error=${encodeURIComponent(verified.reason)}`, origin));
  }

  const claims = verified.claims;
  const email = (claims.email || emailFromUrl || "").toLowerCase().trim();
  if (!email || !email.includes("@")) {
    return NextResponse.redirect(new URL("/login?error=no_email", origin));
  }

  // Re-validate whitelist (defence in depth — admin can revoke between login and callback)
  const stillAllowed = claims.whitelisted === true ? true : await checkWhitelist(email);
  if (!stillAllowed) {
    return NextResponse.redirect(new URL("/login?error=not_whitelisted", origin));
  }

  // Build session cookie (local TTL 24h — we revalidate via middleware if needed)
  const session = buildSession(
    email,
    claims.app_name ?? PORTAL_APP_NAME,
    true,
    claims.session_id ?? claims.sid,
  );

  // Fire-and-forget analytics
  trackAnalytics("user", email);
  trackAnalytics("visit");

  const res = NextResponse.redirect(new URL("/", origin));
  res.cookies.set(SESSION_COOKIE, encodeSession(session), SESSION_COOKIE_OPTIONS);
  // Clean up transient state cookie
  res.cookies.set("nara_oauth_state", "", { path: "/", maxAge: 0 });
  return res;
}
