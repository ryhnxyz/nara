import { NextResponse } from "next/server";
import { readSessionFromCookies } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Return the current authenticated user (from session cookie).
 * Used by client components to display logged-in email / show logout button.
 */
export async function GET() {
  const session = await readSessionFromCookies();
  if (!session) return NextResponse.json({ authenticated: false }, { status: 401 });
  return NextResponse.json({
    authenticated: true,
    email: session.email,
    appName: session.appName,
    whitelisted: session.whitelisted,
  });
}
