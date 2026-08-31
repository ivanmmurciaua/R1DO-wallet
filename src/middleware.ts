import { NextResponse, type NextRequest } from "next/server";
import { buildCsp, isHttpsOrigin, RPC_HOSTS_COOKIE } from "@/lib/csp";

/* Per-request Content-Security-Policy. The base policy (self + the curated RPC
   fleet + Railgun/POI backends) lives in lib/csp.ts; here we read the user's own
   authorized RPC origins from the r1do-rpc-hosts cookie and append them to
   connect-src. This lets a user add their own RPC in-app (Settings → RPCs → the
   [RELOAD TO APPLY] reload carries the new cookie) WITHOUT relaxing the policy to
   a wildcard: connect-src stays self + curated + only the origins the user chose.

   Applied to every path (`/:path*`) so the document AND the worker chunk both
   carry the policy — the engine's fetches run in that worker. */
export function middleware(req: NextRequest): NextResponse {
  const raw = req.cookies.get(RPC_HOSTS_COOKIE)?.value ?? "";
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw); // the writer percent-encodes (cookie-safe)
  } catch {
    /* malformed → treat as raw */
  }
  const extra = decoded
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(isHttpsOrigin);
  const res = NextResponse.next();
  res.headers.set("Content-Security-Policy", buildCsp(extra));
  return res;
}

export const config = {
  matcher: "/:path*",
};
