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

export type Network = {
  id: NetworkId;
  /** viem chain object — source of truth for chainId, display name, explorers. */
  chain: Chain;
  /** RPC failover list, tried in order (PublicNode first — handles big scans). */
  rpcUrls: readonly string[];
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
      (Arbitrum ~0.25s/block → 336 windows). Sized to the LARGEST range ALL of this
      chain's RPCs serve cleanly (probed): Arbitrum = 10000 (all 5 RPCs return
      identical full results → 10× fewer windows). Defaults to 1000 (Sepolia's
      benched size) when omitted. */
  scanWindowBlocks?: number;
  /** Known paymaster address(es) sponsoring THIS chain's Δ1 stealth payments. When
      set, the scanner filters getLogs by them (indexed field) → it only fetches OUR
      candidate UserOps, not the whole chain's 4337 traffic (~22× fewer tx fetches on
      Arbitrum). COMPLETE by construction: our app is the only thing that mints Δ1
      payments and sponsors every one via Pimlico, so every scan-recoverable payment
      is an EntryPoint UserOp carrying one of these. Array → a Pimlico paymaster
      rotation just appends the new address (keep old ones for history). OMIT to
      disable (scan all EntryPoint ops) until the chain's paymaster is CONFIRMED
      on-chain — a wrong address would silently hide funds. */
  scanPaymasters?: readonly `0x${string}`[];
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
    // Sepolia gas is testnet-inflated and unrepresentative → normally no gas floor.
    // TEMPORARILY true to TEST the gas-floor path on Sepolia — revert to false.
    gasFloor: true,
    // Same Pimlico v0.7 singleton paymaster as Arbitrum (confirmed on-chain: deployed
    // + actively sponsoring on Sepolia). ~3.6× fewer tx fetches here (lower total
    // traffic than Arbitrum). scanWindowBlocks omitted → default 1000.
    scanPaymasters: ["0x777777777777AeC03fd955926DbF81597e66834C"],
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
    rpcUrls: [
      "https://arb1.lava.build",
      "https://arb-one.api.pocket.network",
      "https://arbitrum-one.rpc.sentio.xyz",
      "https://arbitrum.gateway.tenderly.co",
    ],
    bundlerSlug: "arbitrum", // Pimlico v2 slug for Arbitrum One (verify: also accepts "42161").
    safeSingleton: "l2", // SafeL2 (as everywhere) → the one global address.
    gasFloor: true, // Real L2 gas → the floor is meaningful (unlike Sepolia).
    // ~0.25s/block → 1000-block windows explode (336+). All 5 RPCs above serve a
    // 10k getLogs cleanly (probed: identical 4039 logs) → 10× fewer scan windows.
    scanWindowBlocks: 10000,
    // Pimlico verifying paymaster on Arbitrum, CONFIRMED on-chain from our own ops.
    // Filtering getLogs by it drops ~22× of the tx fan-out (3933 → 176 per 10k window).
    scanPaymasters: ["0x777777777777AeC03fd955926DbF81597e66834C"],
    // Arbitrum One hosts the ONE global directory (DIRECTORY_NETWORK_ID). Every
    // directory read/write is routed here regardless of the active chain.
    directoryAddress: "0x2269f1f40b3A46fBB55bCa8F38Ad136532276F44",
  },
] as const;

/** localStorage key holding the user's chosen network id. Kept here (not in
    constants.tsx) so networks.ts stays SDK-free and import-cycle-free — constants
    imports networks, never the reverse. */
export const ACTIVE_NETWORK_KEY = "r1do/wallet/v1/network";

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
  return NETWORKS[0];
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
const RAILGUN_SUPPORTED_IDS: readonly NetworkId[] = ["sepolia"];

/** Whether the ACTIVE network has the shielded (shadow) pool available. When false
    the UI must block entering the private world (Railgun would throw at pool boot). */
export function poolSupported(): boolean {
  return RAILGUN_SUPPORTED_IDS.includes(activeNetwork().id);
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

/** Explorer tx URL for a hash, or null if the active chain has no explorer. */
export function explorerTxUrl(hash: string): string | null {
  const base = activeNetwork().chain.blockExplorers?.default.url;
  return base ? `${base}/tx/${hash}` : null;
}
