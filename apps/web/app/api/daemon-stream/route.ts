import { NextRequest } from "next/server";

const DAEMON_URL = process.env.NARA_DAEMON_URL ?? "http://localhost:4000";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest): Promise<Response> {
  const headers: Record<string, string> = { accept: "text/event-stream" };
  const ownerEmail = req.headers.get("x-owner-email");
  if (ownerEmail) headers["x-owner-email"] = ownerEmail;

  const upstream = await fetch(`${DAEMON_URL}/api/logs/stream`, {
    headers,
    cache: "no-store",
  });

  if (!upstream.ok || !upstream.body) {
    return new Response("Upstream stream error", { status: 502 });
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}
