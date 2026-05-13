import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function clearAndRedirect(req: NextRequest) {
  const origin = process.env.NEXT_PUBLIC_APP_ORIGIN || new URL(req.url).origin;
  const res = NextResponse.redirect(new URL("/login", origin));
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
  return res;
}

export async function GET(req: NextRequest) {
  return clearAndRedirect(req);
}
export async function POST(req: NextRequest) {
  return clearAndRedirect(req);
}
