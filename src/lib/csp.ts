/* csp.ts — the Content-Security-Policy, as data + a builder.

   Single source of truth for the policy. `middleware.ts` calls buildCsp() per
   request, appending the user's own RPC origins (from the r1do-rpc-hosts cookie)
   to connect-src — so a user can add their own RPC in-app without weakening the
   policy to a wildcard: connect-src stays `self` + the curated fleet + ONLY the
   origins the user explicitly authorized.

   The crown jewel is connect-src: even if injected/supply-chain code runs, it
   cannot exfiltrate a derived key to a host not on this list. Keep the base list
   in sync with src/lib/networks.ts (RPCs) + src/lib/pool/railgun.ts (POI node).

   Edge-safe: plain strings only, no viem/SDK imports (middleware runs on Edge). */

// connect-src allowlist (besides 'self'). EVERY backend the app talks to.
export const CSP_CONNECT_BASE: readonly string[] = [
  // Sepolia public RPCs (networks.ts)
  "https://0xrpc.io",
  "https://rpc.sepolia.ethpandaops.io",
  "https://sepolia.rpc.sentio.xyz",
  "https://sepolia.gateway.tenderly.co",
  // Arbitrum One public RPCs (networks.ts, curated via rpc-bench.sh). Needed even
  // while Sepolia is active: the pay-by-name directory is pinned to Arbitrum.
  "https://arb1.lava.build",
  "https://arb-one.api.pocket.network",
  "https://arbitrum-one.rpc.sentio.xyz",
  "https://arb1.arbitrum.io",
  "https://arbitrum.gateway.tenderly.co",
  // Etherscan v2 API — public-world transaction history (light side)
  "https://api.etherscan.io",
  // Chainlink ETH/USD on Ethereum mainnet (lib/oracle.ts) — global price fact.
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
];

/** A syntactically valid https origin (scheme + host + optional port, NO path)? */
export function isHttpsOrigin(s: string): boolean {
  return /^https:\/\/[a-z0-9.-]+(:\d{1,5})?$/i.test(s.trim());
}

/** Build the full CSP header value. `extraConnect` are user-authorized RPC origins
    (already validated with isHttpsOrigin); anything malformed is ignored. */
export function buildCsp(extraConnect: readonly string[] = []): string {
  const extra = [...new Set(extraConnect.filter(isHttpsOrigin))];
  const connectSrc = ["connect-src 'self'", ...CSP_CONNECT_BASE, ...extra].join(" ");
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "worker-src 'self' blob:",
    connectSrc,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "manifest-src 'self'",
    "upgrade-insecure-requests",
  ].join("; ");
}

/** Name of the cookie holding the user's authorized RPC origins (space-separated),
    read by middleware to extend connect-src. Written by lib/networks.ts. */
export const RPC_HOSTS_COOKIE = "r1do-rpc-hosts";
