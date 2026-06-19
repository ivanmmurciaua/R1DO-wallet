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
};

export const NETWORKS: readonly Network[] = [
  {
    id: "sepolia",
    chain: sepolia,
    rpcUrls: [
      "https://ethereum-sepolia-rpc.publicnode.com",
      "https://eth-sepolia-testnet.api.pocket.network",
      "https://0xrpc.io/sep",
      "https://rpc.sepolia.ethpandaops.io",
    ],
    bundlerSlug: "sepolia",
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

/** RPC failover list for the active network (mutable copy). */
export function activeRpcUrls(): string[] {
  return [...activeNetwork().rpcUrls];
}

/** Explorer tx URL for a hash, or null if the active chain has no explorer. */
export function explorerTxUrl(hash: string): string | null {
  const base = activeNetwork().chain.blockExplorers?.default.url;
  return base ? `${base}/tx/${hash}` : null;
}
