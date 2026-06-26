import type { NextConfig } from "next";
import NodePolyfillPlugin from "node-polyfill-webpack-plugin";

// IPFS build: `IPFS_BUILD=1 next build` → produces a static ./out with relative
// paths (works served from the root of a CID on any gateway). Without the env
// var, the normal dev/build is left untouched.
const ipfs = process.env.IPFS_BUILD === "1";
const basePath = ipfs ? "/wallet" : "";

// ── Content-Security-Policy ────────────────────────────────────────────────
// The wallet's in-app firewall (the WAF guards the door; this guards what runs
// INSIDE the page and — crucially — where it may phone home). For a non-custodial
// wallet the crown jewel is `connect-src`: even if injected/supply-chain code runs,
// it cannot exfiltrate a derived key to an attacker server not on this list.
//
// `connect-src` must list EVERY backend the app talks to. Keep it in sync with
// src/lib/networks.ts (RPCs) and src/lib/pool/railgun.ts (POI node). The Railgun
// SDK also fetches zk proving artifacts (ipfs-lb.com) and quick-syncs the txid
// tree from its subsquid (rail-squid.squids.live / api.thegraph.com).
//
// NOTE on `script-src`: served via static headers (no nonce) because the dual
// IPFS/Vercel config rules out middleware (`output: export` forbids it). Hence
// 'unsafe-inline' (Next's hydration scripts + the PWA-SW inline script) — so
// script-src is NOT the strong layer here; connect-src is. 'wasm-unsafe-eval' +
// blob: workers are REQUIRED by snarkjs/hash-wasm or zk proving breaks.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  [
    "connect-src 'self'",
    // Sepolia public RPCs (networks.ts)
    "https://0xrpc.io",
    "https://rpc.sepolia.ethpandaops.io",
    "https://sepolia.rpc.sentio.xyz",
    "https://sepolia.gateway.tenderly.co",
    // Etherscan v2 API — public-world transaction history (light side)
    "https://api.etherscan.io",
    // Chainlink ETH/USD on Ethereum mainnet (lib/oracle.ts) — price is a GLOBAL
    // fact, always read from mainnet regardless of the active chain (fee gas-floor).
    "https://ethereum-rpc.publicnode.com",
    "https://rpc.mevblocker.io",
    "https://eth.drpc.org",
    "https://eth.api.pocket.network",
    "https://rpc.nodeflare.app",
    "https://eth.rpc.blxrbdn.com",
    // Railgun POI aggregator (railgun.ts)
    "https://ppoi.fdi.network",
    // Railgun zk artifacts + txid quick-sync (SDK internals)
    "https://ipfs-lb.com",
    "https://rail-squid.squids.live",
    "https://api.thegraph.com",
  ].join(" "),
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "manifest-src 'self'",
  "upgrade-insecure-requests",
].join("; ");

const SECURITY_HEADERS = [
  { key: "Content-Security-Policy", value: CSP },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  // Privacy: don't leak the wallet URL to RPC/aggregator backends.
  { key: "Referrer-Policy", value: "no-referrer" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
];

const nextConfig: NextConfig = {
  allowedDevOrigins: ["effervescent-ana-unsystematically.ngrok-free.dev"],
  // The Railgun SDK needs Node polyfills in the browser (crypto/stream/buffer…),
  // same as the vite-plugin-node-polyfills spike. Client bundle only; not needed
  // on the server. (We verify with build, not dev.)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  webpack: (config: any, { isServer }: { isServer: boolean }) => {
    if (!isServer) {
      config.plugins.push(new NodePolyfillPlugin());
      config.resolve = config.resolve ?? {};
      config.resolve.fallback = { ...config.resolve.fallback, fs: false };
    }
    return config;
  },
  // Exposed to the client to manually prefix the public/ assets that Next does
  // NOT prefix on its own (badge, manifest…) and to disable the PWA on IPFS.
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
    NEXT_PUBLIC_IPFS_BUILD: ipfs ? "1" : "",
  },
  // Security headers (CSP + friends). Only on the Vercel/server build — static
  // `output: export` (IPFS) ignores headers() entirely, and that bundle is frozen.
  ...(!ipfs && {
    async headers() {
      return [{ source: "/:path*", headers: SECURITY_HEADERS }];
    },
  }),
  // Served as a /wallet/ subfolder inside the R1DO-tools CID, on a subdomain
  // gateway (<CID>.ipfs.dweb.link/wallet/). `basePath` starts with "/" → it
  // doesn't break next/font (unlike a relative assetPrefix) and makes every route
  // /wallet/_next/… → resolving under the subfolder.
  ...(ipfs && {
    output: "export",
    images: { unoptimized: true },
    basePath,
    trailingSlash: true,
  }),
};

export default nextConfig;
