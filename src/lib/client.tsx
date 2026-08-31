import { createPublicClient, http, fallback, type PublicClient } from "viem";
import { activeChain, activeRpcUrls, directoryNetwork, rpcUrlsForNetwork } from "@/lib/networks";
import { buildSafeWallet, type SafeWallet } from "@/lib/aa-client";

/**
 * THE single way to read the active chain.
 *
 * A fresh viem public client over the user's LIVE RPC list (activeRpcUrls — which
 * honours the user's disable/add overrides) with automatic failover: when a node
 * errors, viem's fallback() moves to the next. Every on-chain read/call in the app
 * goes through this, so a disabled/dead node is never used and one blip never
 * stalls a read. Call it per use — never cache a frozen client (that was the bug:
 * a module-level client froze the RPC list at import).
 */
export function rpcClient(): PublicClient {
  return createPublicClient({
    chain: activeChain(),
    transport: fallback(activeRpcUrls().map((u) => http(u))),
  });
}

/**
 * Read client PINNED to the single global directory network (Arbitrum), NOT the
 * active chain — every pay-by-name lookup resolves here so the directory is one
 * global island regardless of which chain the wallet operates on.
 *
 * A FUNCTION (not a frozen const) over the directory network's LIVE RPC list
 * (rpcUrlsForNetwork honours the user's disable/add for that network) with
 * failover — same guarantees as rpcClient(). A frozen const here was the bug:
 * login's directory recovery kept hitting a node the user had disabled.
 */
export function directoryClient(): PublicClient {
  const net = directoryNetwork();
  return createPublicClient({
    chain: net.chain,
    transport: fallback(rpcUrlsForNetwork(net).map((u) => http(u))),
  });
}

// v2: the Safe owner is a plain secp256k1 key derived from the passkey PRF
// (deriveOwnerKey). Standard ecrecover verification — no WebAuthn signer
// contract, no P-256 coordinates anywhere. The AA stack (pinned addresses,
// bundler/paymaster, L1/L2 singleton) lives in aa-client.ts; this is just the
// login-Safe (saltNonce 0) entry point kept for its existing call sites.
export const safeClientFromOwner = async (
  ownerPrivateKey: `0x${string}`,
): Promise<SafeWallet> => buildSafeWallet(ownerPrivateKey);

export const getLastBlock = async (): Promise<string> => {
  return (await rpcClient().getBlockNumber()).toString();
};
