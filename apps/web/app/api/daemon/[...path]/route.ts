import { NextRequest } from "next/server";

const DAEMON_URL = process.env.NARA_DAEMON_URL ?? "http://localhost:4000";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

async function proxy(req: NextRequest, path: string[]): Promise<Response> {
  const target = `${DAEMON_URL}/api/${path.join("/")}${req.nextUrl.search}`;

  // Forward original headers (accept/content-type/etc.) so SSE negotiation works.
  const forwardHeaders = new Headers();
  const acceptHeader = req.headers.get("accept");
  const contentType = req.headers.get("content-type");
  if (acceptHeader) forwardHeaders.set("accept", acceptHeader);
  if (contentType) forwardHeaders.set("content-type", contentType);

  // Middleware injects x-owner-email for authenticated users — forward so daemon can scope queries
  const ownerEmail = req.headers.get("x-owner-email");
  if (ownerEmail) forwardHeaders.set("x-owner-email", ownerEmail);

  const init: RequestInit = {
    method: req.method,
    headers: forwardHeaders,
    cache: "no-store",
    ...({ duplex: "half" } as Record<string, unknown>),
  };

  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.text();
  }

  const upstream = await fetch(target, init);

  // Pass the upstream body as a stream — DO NOT buffer with .text() or SSE breaks.
  const responseHeaders = new Headers();
  const upstreamCT = upstream.headers.get("content-type");
  if (upstreamCT) responseHeaders.set("content-type", upstreamCT);

  // If it's SSE, add streaming-friendly headers and disable buffering.
  if (upstreamCT?.includes("text/event-stream")) {
    responseHeaders.set("cache-control", "no-cache, no-transform");
    responseHeaders.set("connection", "keep-alive");
    responseHeaders.set("x-accel-buffering", "no");
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: responseHeaders,
  });
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await params).path);
}
export async function POST(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await params).path);
}
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await params).path);
}
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ path: string[] }> }) {
  return proxy(req, (await params).path);
}
