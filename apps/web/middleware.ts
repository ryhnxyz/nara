import { NextRequest, NextResponse } from "next/server";
import { readSessionFromRequest } from "@/lib/session";

/**
 * Auth middleware — protects all dashboard routes.
 *
 * Public routes (no session required):
 *   - /login  (sign-in page)
 *   - /api/portal/init-sso  (starts SSO flow, no session yet)
 *   - /api/auth/callback    (portal redirect target)
 *   - /api/auth/logout      (safe without session)
 *   - /api/auth/me          (returns 401 when no session, that's expected)
 *
 * Everything else requires a valid session cookie with whitelisted=true.
 * For API calls to /api/daemon/* we also inject x-owner-email so the daemon
 * can scope DB queries to this user.
 */

const PUBLIC_PATHS = [
  "/login",
  "/api/portal/init-sso",
  "/api/auth/callback",
  "/api/auth/logout",
  "/api/auth/me",
];

function isPublic(pathname: string): boolean {
  for (const p of PUBLIC_PATHS) {
    if (pathname === p || pathname.startsWith(p + "/")) return true;
  }
  if (pathname.startsWith("/_next/")) return true;
  if (pathname === "/favicon.ico") return true;
  return false;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();

  const session = await readSessionFromRequest(req);

  if (!session || !session.whitelisted) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (pathname.startsWith("/api/daemon/") || pathname.startsWith("/api/daemon-stream")) {
    const headers = new Headers(req.headers);
    headers.set("x-owner-email", session.email);
    return NextResponse.next({ request: { headers } });
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    /*
     * Match everything except:
     * - _next static assets
     * - favicon
     * - public files with extensions (images, fonts, etc.)
     */
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|webp|svg|ico|css|js)$).*)",
  ],
};
