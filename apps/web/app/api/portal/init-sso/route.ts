import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { initGatewaySession, clientIpFromHeaders } from "@/lib/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start Mystr Portal SSO flow. Returns a gateway_url the client redirects to.
 * api_key + signing_secret stay server-side.
 *
 * We forward the real client IP + UA to the portal so its rate limiter charges
 * the actual end user, not our VPS. Otherwise every sign-in from every user
 * looks like it's coming from our VPS IP and trips the per-IP WAF after a few
 * retries (Too many failed attempts from this IP).
 */
export async function POST(req: NextRequest) {
  try {
    const origin = process.env.NEXT_PUBLIC_APP_ORIGIN || new URL(req.url).origin;
    const redirectUri = `${origin}/api/auth/callback`;
    const state = crypto.randomBytes(16).toString("hex");

    const clientIp = clientIpFromHeaders(req.headers);
    const clientUa = req.headers.get("user-agent");

    const gatewayUrl = await initGatewaySession(redirectUri, state, clientIp, clientUa);

    const res = NextResponse.json({ gateway_url: gatewayUrl });
    res.cookies.set("nara_oauth_state", state, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 600,
    });
    return res;
  } catch (err) {
    const message = (err as Error).message;
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
