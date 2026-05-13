import { NextRequest, NextResponse } from "next/server";
import crypto from "node:crypto";
import { initGatewaySession } from "@/lib/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Start Mystr Portal SSO flow. Returns a gateway_url the client redirects to.
 * api_key + signing_secret stay server-side.
 */
export async function POST(req: NextRequest) {
  try {
    // Derive canonical origin from env (production: NEXT_PUBLIC_APP_ORIGIN) with fallback to request
    const origin = process.env.NEXT_PUBLIC_APP_ORIGIN || new URL(req.url).origin;
    const redirectUri = `${origin}/api/auth/callback`;
    const state = crypto.randomBytes(16).toString("hex");

    const gatewayUrl = await initGatewaySession(redirectUri, state);

    const res = NextResponse.json({ gateway_url: gatewayUrl });
    // Store state in httpOnly cookie for CSRF verification in callback
    res.cookies.set("nara_oauth_state", state, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 600, // 10 min — init session TTL is 5, extra headroom
    });
    return res;
  } catch (err) {
    const message = (err as Error).message;
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
