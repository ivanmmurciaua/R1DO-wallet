import type { NextConfig } from "next";
import NodePolyfillPlugin from "node-polyfill-webpack-plugin";

// Static security headers. The Content-Security-Policy is NOT here: it is set
// per-request in middleware.ts (lib/csp.ts) so it can extend connect-src with the
// user's own authorized RPC origins without weakening it to a wildcard.
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  // Privacy: don't leak the wallet URL to RPC/aggregator backends.
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  allowedDevOrigins: ["effervescent-ana-unsystematically.ngrok-free.dev"],
  // The Railgun SDK needs Node polyfills in the browser (crypto/stream/buffer…).
  // Client bundle only; not needed on the server. (We verify with build, not dev.)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  webpack: (config: any, { isServer }: { isServer: boolean }) => {
    if (!isServer) {
      config.plugins.push(new NodePolyfillPlugin());
      config.resolve = config.resolve ?? {};
      config.resolve.fallback = { ...config.resolve.fallback, fs: false };
    }
    return config;
  },
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
};

export default nextConfig;
