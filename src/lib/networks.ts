/*
  networks.ts — chain/network registry (single source of truth, UI + infra).

  Mirrors pool/protocols.ts. The wallet is NOT tied to Sepolia: it's one of
  several possible chains. Every chain-specific value (viem chain object, RPC
  failover list, explorer URL, bundler path slug, chainId) is defined here ONCE
  so no component hardcodes "sepolia" / an RPC URL / 11155111 / an etherscan URL
  in N places.

  For now there is a SINGLE network (Sepolia) and NO switcher — the active
  network is always the default (first in the list). When a second chain lands,
  add it to NETWORKS and surface a switcher; nothing downstream changes because
  everything reads activeNetwork() / its helpers.

  SDK-free on purpose (no Railgun imports) so importing this never pulls the
  engine into the login bundle. The Railgun NetworkName mapping lives in the
  pool layer (pool/railgun.ts), keyed off the active network id.
*/
import type { Address, Chain } from "viem";
import { sepolia, arbitrum } from "viem/chains";

export type NetworkId = "sepolia" | "arbitrum";

/** A getLogs endpoint paired with the max block range it reliably serves in the
    browser. See the `logsRpcUrls` field for why the window is per-RPC. */
export type LogsRpc = { url: string; window: number };

export type Network = {
  id: NetworkId;
  /** viem chain object — source of truth for chainId, display name, explorers. */
  chain: Chain;
  /** RPC failover list, tried in order (PublicNode first — handles big scans). */
  rpcUrls: readonly string[];
  /** RPC subset the scanner uses for getLogs, tried IN ORDER (fastest/widest first),
      each paired with the max block range it reliably serves IN THE BROWSER (its
      `window`). Separate from `rpcUrls` because the two jobs want opposite things:
      the getTransaction fan-out is real load, sharded across every node; getLogs is
      one request per window, so order (not rotation) is what matters.

      Why a PER-RPC window (not one global size): each provider caps getLogs at a
      different range, and a window bigger than a node's cap fails — sometimes loudly
      (pocket 500s at 500k, PROVEN in-browser), sometimes SILENTLY ([] with no error,
      which pocket does on Sepolia) → a silent scan gap. So the scanner asks each node
      only what it serves: tenderly does 500k in one shot (a month in ~17s), and when
      it is down it falls to lava/pocket at 50k (slower but safe). No node is ever
      asked past its cap, so neither a 500 nor a silent truncation can happen.

        rpc        50k      200k        1M       browser cap (real)
        lava      1307ms   91146ms   14311ms     < 500k (didn't serve it)
        pocket    1284ms   13866ms      CAP      < 500k (500'd at 500k)
        sentio     CAP       CAP       CAP       < 50k → excluded, fan-out only
        tenderly   722ms    1521ms    8197ms     ≥ 500k (served a month fine)

      (The ms are Node/isolated — good for RELATIVE range capability, NOT for health;
      the browser caps on the right are what the scanner actually trusts.) Omit to
      fall back to `rpcUrls` at the default window. Every url must also be in `rpcUrls`
      so the CSP connect-src already covers it. */
  logsRpcUrls?: readonly LogsRpc[];
  /** RPCs the scanner's getTransaction fan-out aims at FIRST, one shard each.
      Subset of `rpcUrls`; fallback still covers the whole fleet, so this only
      decides who is asked first, never who can answer.

      Exists because sharding across every url was WORSE than not sharding: a dead
      node's shard fails, viem's fallback rotates it onto a live node anyway, and the
      live ones end up eating the dead ones' load PLUS a wasted round trip each. The
      shard count has to be the number of HEALTHY nodes, not the number of nodes.

      Health here means health IN A BROWSER, which is the only place that counts and
      the one place a Node bench can't see (no CORS, no Origin, no preflight — it has
      already lied about this fleet twice). Observed in the app's console under a real
      scan: pocket 500s almost everything, tenderly serves but rate-limits, lava 500s
      occasionally, sentio was the only one that never erred. Omit to use `rpcUrls`. */
  scanRpcUrls?: readonly string[];
  /** URL-path slug used by infra providers (Pimlico bundler/paymaster). */
  bundlerSlug: string;
  /** Which Safe singleton this chain uses: `Safe` (L1) vs `SafeL2` (L2). STATIC,
      declared here — NEVER getCode-detected (that needs an RPC and breaks the
      offline/counterfactual derivation login+stealth rely on). It enters the
      CREATE2 initcode, so it's address-critical.

      POLICY (2026-07): `SafeL2` on EVERY network — including L1s like Ethereum
      mainnet and Sepolia. `SafeL2` is NOT L2-only: it's `Safe` + event emission
      (an indexing convention, not a restriction) and is the GUARANTEED default on
      every present and future L2. The Safe address is chain-independent given the
      pinned inputs, so one singleton everywhere ⇒ ONE global permanent address per
      owner across all standard EVM chains — which is exactly what the single global
      directory needs. The tiny event-gas premium (mostly on cheap L2s) buys that
      universality. Keep this "l2" everywhere; "l1" stays only for a chain that
      genuinely lacks SafeL2. See aa-config.ts and directory-multinetwork rationale. */
  safeSingleton: "l1" | "l2";
  /** Apply the operator-fee gas floor (fee = max(0.1%, gas)) on this chain.
      OFF on testnets — Sepolia's gas is unrepresentative and dwarfs the 0.1%,
      breaking testing; ON for production chains. Defaults to true when omitted. */
  gasFloor?: boolean;
  /** getLogs window (blocks) for the stealth scanner. Fast chains mint blocks so
      quickly that a fixed 1000-block window explodes into hundreds of windows
      (Arbitrum ~0.25s/block → 336 windows). Sized to the largest range every node
      in `logsRpcUrls` serves cleanly (probed) — NOT every node in `rpcUrls`, which
      is what held this at 10000 while sentio (the only one that caps under 50k) was
      still in the getLogs path. Defaults to 1000 (Sepolia's benched size).

      Also the scan's CHECKPOINT granularity: the cursor advances once per window,
      so an interrupted scan re-does at most one. That bounds it by WALL CLOCK, not
      by blocks — measured, a 200k window costs ~12.7s, about what a 10k window cost
      before the fan-out was sharded (~9.8s). Same work at risk, 20× the coverage. */
  scanWindowBlocks?: number;
  /** Known paymaster address(es) sponsoring THIS chain's Δ stealth payments. When
      set, the scanner filters getLogs by them (indexed field) → it only fetches OUR
      candidate UserOps, not the whole chain's 4337 traffic (~22× fewer tx fetches on
      Arbitrum). COMPLETE by construction: our app is the only thing that mints Δ
      payments and sponsors every one via Pimlico, so every scan-recoverable payment
      is an EntryPoint UserOp carrying one of these. Array → a Pimlico paymaster
      rotation just appends the new address (keep old ones for history). OMIT to
      disable (scan all EntryPoint ops) until the chain's paymaster is CONFIRMED
      on-chain — a wrong address would silently hide funds. */
  scanPaymasters?: readonly `0x${string}`[];
  /** OUR OWN paymaster (R1DOPaymaster) that sponsors THIS chain's Δ stealth sends,
      when set. This is the lever that makes the scan cheap: with it, buildSafeClient
      routes ops through our paymaster instead of Pimlico's SHARED one, so every Δ
      payment's UserOperationEvent carries an address that belongs ONLY to us. The
      scanner then filters getLogs by it (via scanPaymasters, which MUST also list
      it) and every hit is already a Δ payment — the fan-out of downloading the whole
      chain's 4337 traffic just to trial-decrypt it disappears. OMIT to keep
      sponsoring via Pimlico (the pre-own-paymaster behaviour). Per-chain by nature:
      a fresh deploy per network (Sepolia's ≠ Arbitrum's), unlike the cross-chain
      pinned set in aa-config.ts — which is why it lives here, not there. Contained
      blast radius: only chains that set this route through the own paymaster. */
  deltaPaymaster?: `0x${string}`;
  /** R1DODirectory (pay-by-name) contract, PINNED in code (not env). There is ONE
      global directory for the whole app, hosted on the canonical directory network
      (DIRECTORY_NETWORK_ID) — NOT one per chain. So this is set ONLY on that one
      network; every other network leaves it undefined and all directory reads/
      writes are routed to the directory network regardless of the active chain
      (SafeL2-everywhere makes the user's address identical there). A future backup
      could mirror the entry onto other chains' directories, but that's opt-in and
      far off. Absent on every non-directory network. */
  directoryAddress?: Address;
};

export const NETWORKS: readonly Network[] = [
  {
    id: "sepolia",
    chain: sepolia,
    // Curated from scripts/rpc-bench.sh (2026-06-23). ONE list feeds BOTH the
    // light world (getBalance/eth_call + the stealth scanner's BATCHED
    // getTransaction fan-out) AND Railgun's engine (archive eth_getLogs + ethers
    // batching). So every entry must serve: (a) archive getLogs cleanly, and
    // (b) JSON-RPC batches of ≥17 (both viem and ethers batch by default — a node
    // that rejects batches 500s every batched POST and poisons the fallback).
    // Verified all four below pass both. EXCLUDED: drpc (free tier caps batches
    // at 3 → 500s the scanner/engine batches, the flood we hit), publicnode (403
    // archive), 1rpc (50-block getLogs cap), nodies (250-block cap), pocket
    // (empty getLogs), zan (CU-metered), owlracle (origin-locked), omniatech
    // (down). Index 0 is primary; tenderly last as it 429s under heavy volume.
    rpcUrls: [
      "https://0xrpc.io/sep",
      "https://rpc.sepolia.ethpandaops.io",
      "https://sepolia.rpc.sentio.xyz",
      "https://sepolia.gateway.tenderly.co",
    ],
    bundlerSlug: "sepolia",
    // SafeL2 on EVERY chain (incl. this L1-style testnet) → one global address per
    // owner. Sepolia was reset for this migration, so the address change is a
    // non-issue. See the `safeSingleton` field doc for the full rationale.
    safeSingleton: "l2",
    // Sepolia gas is testnet-inflated and unrepresentative → no gas floor here.
    gasFloor: false,
    // Δ scanning fix (2026-07-18): route Δ sends through OUR OWN paymaster
    // (R1DOPaymaster, inheriting the audited eth-infinitism BasePaymaster v0.7.0,
    // deployed on Sepolia) instead of Pimlico's shared one, so the scanner filters
    // getLogs by an address that is ONLY ours → every hit is already a Δ payment, no
    // fan-out. Sepolia was reset for the migration, so there is no pre-cutover history
    // to keep: the filter is our paymaster alone. (A first permissive build lived at
    // 0x89f7B1…9f7A; superseded by this audited-base one.)
    deltaPaymaster: "0xf3741d1732c0d55d6E6f527654bc2cdcF3eC3236",
    scanPaymasters: ["0xf3741d1732c0d55d6E6f527654bc2cdcF3eC3236"],
    // No directory here — the single global directory lives on Arbitrum
    // (DIRECTORY_NETWORK_ID). The old Sepolia directory (0x72587C42…) is abandoned.
  },
  {
    id: "arbitrum",
    chain: arbitrum, // Arbitrum One (chainId 42161).
    // Curated from scripts/rpc-bench.sh (2026-07-01), same bar as Sepolia: every
    // entry must serve (a) archive eth_getLogs cleanly — a 403/cap POISONS the
    // ethers FallbackProvider quorum the Railgun engine relies on — and (b) JSON-RPC
    // batches of ≥17 (viem + ethers batch by default). These five pass both, full
    // 6 MB archive getLogs and 20/20 burst (lava/pocket/sentio ~0.22–0.36s; arb1
    // official mildly 429s a burst; tenderly handles huge ranges but 429s under
    // sustained volume → last). Index 0 is the scanner primary; OPS_RPC_URL takes
    // index 1 so a heavy scan and a wallet op don't fight the same node.
    // EXCLUDED (measured): publicnode (403 "archive requires token" → poisons the
    // engine, same as Sepolia), drpc (batch of 17 → 0 results, free tier caps
    // batches), 1rpc (getLogs capped to 50 blocks), blastapi (10-block cap),
    // meowrpc (eth_getLogs unsupported + burst 429), onfinality (429 without key),
    // zan (CU-metered → getLogs "cu limit exceeded"), owlracle (origin-locked),
    // nodeflare (getLogs off on the public endpoint), fastnode/therpc/poolz/rpcfree
    // (empty/unresponsive). Keep in sync with next.config.ts connect-src (CSP).
    // NOTE: browser-usable only — the bench runs in Node (no CORS), so it can't see
    // that a node ships a broken CORS header. REMOVED arb1.arbitrum.io/rpc: it returns
    // `Access-Control-Allow-Origin: *,*` (duplicated) → the browser rejects EVERY
    // request to it, so it was pure dead weight that failed each getTransaction and
    // flooded the console. Re-add only if it fixes its CORS header.
    // tenderly history: commented out 2026-07-16 because, promoted to getLogs primary
    // AND a fan-out shard, it answered with a wall of 429s under the sustained volume
    // the fan-out generated. RESTORED 2026-07-18: the own paymaster (deltaPaymaster)
    // removed the fan-out entirely — a month is now ~11 wide getLogs, not thousands of
    // tx fetches — so the sustained-volume trigger is gone. It is the only node that
    // serves a WIDE getLogs fast (464ms at 10k, 1.5s at 200k vs lava's 67s/91s), which
    // is exactly the deep-scan bottleneck now. So: FIRST in logsRpcUrls (the single-
    // request path where it shines), LAST in rpcUrls, and still NOT a scanRpcUrls shard
    // primary (the one place its rate limit bit).
    rpcUrls: [
      "https://arb1.lava.build",
      "https://arb-one.api.pocket.network",
      "https://arbitrum-one.rpc.sentio.xyz",
      "https://arbitrum.gateway.tenderly.co",
    ],
    // getLogs only, fastest-first. tenderly leads: it serves wide ranges far faster
    // than lava/pocket and, with the fan-out gone, no longer 429s. lava/pocket follow
    // as fallback. sentio is absent (caps under 50k) — it stays in rpcUrls for fan-out.
    // Per-RPC windows (2026-07-18), from a browser fallback test: with tenderly
    // removed, a 500k getLogs FAILED — pocket 500'd in a loop, lava didn't save it,
    // the scan aborted. So lava/pocket's real browser cap is < 500k; 50k is known-good
    // (the earlier 2-min run). The scanner asks each node only its window: tenderly
    // serves 500k (a month in ~17s), and if it is down, lava/pocket serve 50k (slower
    // but safe) — no node is ever asked past its cap, so no 500 and no silent [] gap.
    logsRpcUrls: [
      // tenderly at 1M — a month in ~7s (11 windows). Canary passed (2026-07-18): the
      // scan found both known test UTXOs, which sit near the tail of their window, so
      // 1M is not tail-truncated; tenderly served a full 1M in the Node bench too. The
      // residual (an EMPTY older window can't prove it wasn't silently truncated) is
      // accepted because tenderly ERRORS on an over-range request rather than truncating
      // silently (silent [] is a cheap-node behaviour — pocket on Sepolia). lava/pocket
      // stay at their 50k browser cap, so getLogsAdaptive degrades to them on any error.
      { url: "https://arbitrum.gateway.tenderly.co", window: 1000000 },
      { url: "https://arb1.lava.build", window: 50000 },
      { url: "https://arb-one.api.pocket.network", window: 50000 },
    ],
    // Fan-out primaries, one shard each. pocket is deliberately NOT here: it is
    // RPC_URLS[1] = OPS_RPC_URL, and the whole point of that index is that a heavy
    // scan and a wallet op don't fight over the same node. It stays reachable as
    // fallback. So the scan aims at RPC_URLS[0] (the designated scanner primary) and
    // sentio, which was the one node that never erred in a real browser scan.
    scanRpcUrls: [
      "https://arb1.lava.build",
      "https://arbitrum-one.rpc.sentio.xyz",
    ],
    bundlerSlug: "arbitrum", // Pimlico v2 slug for Arbitrum One (verify: also accepts "42161").
    safeSingleton: "l2", // SafeL2 (as everywhere) → the one global address.
    gasFloor: true, // Real L2 gas → the floor is meaningful (unlike Sepolia).
    // ~0.25s/block → 1000-block windows explode (336+). Was 10000, which was sentio's
    // getLogs cap leaking into a global constant; sentio no longer answers getLogs, so
    // the cap is gone.
    //
    // SUPERSEDED by per-RPC windows (see logsRpcUrls above): the getLogs range is now
    // set per node (tenderly 500k, lava/pocket 50k), not by one global size. This field
    // survives only as the fallback window for a chain with NO logsRpcUrls list; Arbitrum
    // has one, so this value is unused here. Left at 50k (the known-safe floor) in case
    // the per-RPC list is ever dropped.
    scanWindowBlocks: 50000,
    // Δ scanning fix (2026-07-18): route Δ sends through OUR OWN paymaster
    // (R1DOPaymaster, audited BasePaymaster v0.7.0 base, deployed on Arbitrum One)
    // and filter the scan by it ALONE. Filtering by Pimlico's SHARED paymaster only
    // dropped ~22× of the fan-out (3933 → 176 per 10k window) because that paymaster
    // keeps sponsoring the whole chain; filtering by an address that is ONLY ours
    // removes the fan-out entirely (every hit is already a Δ payment → a month scans
    // in ~1s, proven on Sepolia). NO block-cutover (deliberate): pre-cutover Δ
    // payments sponsored by Pimlico that are not already cached in a device's
    // IndexedDB stop being re-discoverable — accepted at beta scale.
    deltaPaymaster: "0xAFcEBfF70C1B1D87B8dF4eA5bDbbf2b45A9d947E",
    scanPaymasters: ["0xAFcEBfF70C1B1D87B8dF4eA5bDbbf2b45A9d947E"],
    // Arbitrum One hosts the ONE global directory (DIRECTORY_NETWORK_ID). Every
    // directory read/write is routed here regardless of the active chain.
    directoryAddress: "0x2269f1f40b3A46fBB55bCa8F38Ad136532276F44",
  },
] as const;

/** localStorage key holding the user's chosen network id. Kept here (not in
    constants.tsx) so networks.ts stays SDK-free and import-cycle-free — constants
    imports networks, never the reverse. */
export const ACTIVE_NETWORK_KEY = "r1do/wallet/v1/network";

/** The network a fresh user (no persisted choice) starts on, and the selector's
    default. Arbitrum One — the production chain. */
export const DEFAULT_NETWORK_ID: NetworkId = "arbitrum";

/**
 * The network currently in use. Reads the user's persisted choice
 * (ACTIVE_NETWORK_KEY) on the client; falls back to the default (NETWORKS[0]) on
 * the server (no localStorage) or when nothing/invalid is stored.
 *
 * The switcher persists + RELOADS the page (Settings), so all module-level consts
 * derived from the active network (RPC_URLS, BUNDLER_URL… in constants.tsx) are
 * re-evaluated fresh on the next load — no runtime reactivity needed. Note the
 * DIRECTORY is NOT affected: it's pinned to directoryNetwork() regardless of this.
 *
 * HYDRATION INVARIANT: this returns a DIFFERENT value on the server (always
 * NETWORKS[0]) vs the client (the persisted choice), so it must NEVER feed the
 * DOM that React hydrates on first paint. Today it's safe because every
 * network-derived render is gated behind `deployed` (wallet UI) or a closed
 * dialog (the Settings selector) — both false at first paint — so the initial
 * server HTML carries no network token (verified: SSR HTML has zero). If you ever
 * render `networkName()`/chain-derived text UNGATED at first paint, guard it with
 * a `mounted` flag (render NETWORKS[0] until mounted) or you'll get a mismatch.
 */
export function activeNetwork(): Network {
  if (typeof window !== "undefined") {
    try {
      const id = window.localStorage.getItem(ACTIVE_NETWORK_KEY);
      const found = id ? NETWORKS.find((n) => n.id === id) : undefined;
      if (found) return found;
    } catch {
      /* localStorage blocked (private mode / SSR edge) → default below */
    }
  }
  // No persisted choice → the default network (Arbitrum One), not merely NETWORKS[0].
  return NETWORKS.find((n) => n.id === DEFAULT_NETWORK_ID) ?? NETWORKS[0];
}

/** Persist the active network choice. The caller reloads the page afterwards so
    the whole app (and the frozen module-level consts) re-reads it cleanly. */
export function setActiveNetwork(id: NetworkId): void {
  try {
    window.localStorage.setItem(ACTIVE_NETWORK_KEY, id);
  } catch {
    /* no-op — if we can't persist, the app just stays on the current network */
  }
}

/** Networks with a Railgun (shielded/shadow pool) deployment wired. MUST stay in
    sync with RAILGUN_NETWORK in pool/railgun.ts. Declared here (SDK-free) so the UI
    can gate the shadow world WITHOUT importing railgun.ts — whose module-load
    throws on an unsupported chain. */
const RAILGUN_SUPPORTED_IDS: readonly NetworkId[] = ["sepolia", "arbitrum"];

/** Whether the ACTIVE network has the shielded (shadow) pool available. When false
    the UI must block entering the private world (Railgun would throw at pool boot). */
export function poolSupported(): boolean {
  return RAILGUN_SUPPORTED_IDS.includes(activeNetwork().id);
}

/** Every network the wallet supports (display names). The public Safe address is
    the same on all of them, so a public payment can land on any — no cursor needed. */
export function allNetworkNames(): string[] {
  return NETWORKS.map((n) => n.chain.name);
}

/** Networks where the shielded pool (0zk) lives. The 0zk address is the same on
    each, so a private transfer can be received on any Railgun-wired chain. */
export function railgunNetworkNames(): string[] {
  return NETWORKS.filter((n) => RAILGUN_SUPPORTED_IDS.includes(n.id)).map((n) => n.chain.name);
}

/** The network that hosts the ONE global directory. All pay-by-name reads/writes
    are pinned here regardless of the active chain — SafeL2-everywhere guarantees the
    user's Safe address is identical on this chain, so writing here is coherent. */
export const DIRECTORY_NETWORK_ID: NetworkId = "arbitrum";

/** The canonical directory network object (chain + RPCs + bundler slug). Throws at
    load if misconfigured — the directory is a hard dependency of pay-by-name. */
export function directoryNetwork(): Network {
  const net = NETWORKS.find((n) => n.id === DIRECTORY_NETWORK_ID);
  if (!net?.directoryAddress) {
    throw new Error(`directoryNetwork: "${DIRECTORY_NETWORK_ID}" has no directoryAddress`);
  }
  return net;
}

/** The single global R1DODirectory (pay-by-name) address, on the directory network.
    Same value everywhere — the directory does NOT follow the active chain. */
export function directoryAddress(): Address {
  return directoryNetwork().directoryAddress!;
}

/** The active viem chain object (pass straight to createPublicClient, etc.). */
export function activeChain(): Chain {
  return activeNetwork().chain;
}

/** Active chain id (e.g. 11155111). */
export function activeChainId(): number {
  return activeNetwork().chain.id;
}

/** Display name from the chain object (e.g. "Sepolia"). */
export function networkName(): string {
  return activeNetwork().chain.name;
}

export function activeRpcUrls(): string[] {
  return [...activeNetwork().rpcUrls];
}

/** getLogs endpoints for the active chain, in order, each with its per-RPC window
    (see the `logsRpcUrls` field). Where no curated list exists, synthesizes one from
    `rpcUrls` at the default window (scanWindowBlocks) — so the scanner always has a
    windowed list to rotate through. */
export function activeLogsRpcs(): LogsRpc[] {
  const n = activeNetwork();
  if (n.logsRpcUrls) return [...n.logsRpcUrls];
  const window = scanWindowBlocks();
  return n.rpcUrls.map((url) => ({ url, window }));
}

/** RPCs the scanner's fan-out shards across on the active chain (see `scanRpcUrls`).
    Falls back to the full list where none is curated. */
export function activeScanRpcUrls(): string[] {
  const n = activeNetwork();
  return [...(n.scanRpcUrls ?? n.rpcUrls)];
}

/** Whether to apply the operator-fee gas floor on the active chain (default true). */
export function gasFloorEnabled(): boolean {
  return activeNetwork().gasFloor ?? true;
}

/** getLogs window (blocks) for the stealth scanner on the active chain (default 1000). */
export function scanWindowBlocks(): number {
  return activeNetwork().scanWindowBlocks ?? 1000;
}

/** Known paymaster allowlist for the active chain's stealth scan, or undefined (no
    filter → scan every EntryPoint op). See the `scanPaymasters` field for the safety
    invariant (only set where the address is confirmed). */
export function scanPaymasters(): readonly `0x${string}`[] | undefined {
  return activeNetwork().scanPaymasters;
}

/** OUR own paymaster address for the active chain's Δ sends, or undefined (sponsor
    via Pimlico). See the `deltaPaymaster` field — when set, buildSafeClient routes
    ops through it so the scanner can filter on an address that is only ours. */
export function deltaPaymaster(): `0x${string}` | undefined {
  return activeNetwork().deltaPaymaster;
}

/** Explorer tx URL for a hash, or null if the active chain has no explorer. */
export function explorerTxUrl(hash: string): string | null {
  const base = activeNetwork().chain.blockExplorers?.default.url;
  return base ? `${base}/tx/${hash}` : null;
}

/** Explorer address URL for an address, or null if the active chain has no explorer.
    Follows the active chain, so a stealth address links to the right network's explorer. */
export function explorerAddressUrl(address: string): string | null {
  const base = activeNetwork().chain.blockExplorers?.default.url;
  return base ? `${base}/address/${address}` : null;
}
