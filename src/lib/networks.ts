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
import type { Chain } from "viem";
import { sepolia } from "viem/chains";

export type NetworkId = "sepolia";

export type Network = {
  id: NetworkId;
  /** viem chain object — source of truth for chainId, display name, explorers. */
  chain: Chain;
  /** RPC failover list, tried in order (PublicNode first — handles big scans). */
  rpcUrls: readonly string[];
  /** URL-path slug used by infra providers (Pimlico bundler/paymaster). */
  bundlerSlug: string;
  /** Apply the operator-fee gas floor (fee = max(0.1%, gas)) on this chain.
      OFF on testnets — Sepolia's gas is unrepresentative and dwarfs the 0.1%,
      breaking testing; ON for production chains. Defaults to true when omitted. */
  gasFloor?: boolean;
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
    // Sepolia gas is testnet-inflated and unrepresentative → normally no gas floor.
    // TEMPORARILY true to TEST the gas-floor path on Sepolia — revert to false.
    gasFloor: true,
  },
] as const;

/**
 * The network currently in use. No switcher yet → always the default (first in
 * the list). When the switcher exists this reads the user's choice.
 */
export function activeNetwork(): Network {
  return NETWORKS[0];
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

/** Explorer tx URL for a hash, or null if the active chain has no explorer. */
export function explorerTxUrl(hash: string): string | null {
  const base = activeNetwork().chain.blockExplorers?.default.url;
  return base ? `${base}/tx/${hash}` : null;
}
