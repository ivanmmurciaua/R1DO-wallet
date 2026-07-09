import { sepoliaTransport } from "@/app/constants";
import { createPublicClient, http, fallback } from "viem";
import { activeChain, directoryNetwork } from "@/lib/networks";
import { buildSafeWallet, type SafeWallet } from "@/lib/aa-client";

export const client = createPublicClient({
  chain: activeChain(),
  transport: sepoliaTransport(),
});

// Read client PINNED to the single global directory network (Arbitrum), NOT the
// active chain. Every pay-by-name lookup (getEntry/hasEntry) resolves here so the
// directory is one global island regardless of which chain the wallet operates on.
export const directoryClient = createPublicClient({
  chain: directoryNetwork().chain,
  transport: fallback(directoryNetwork().rpcUrls.map((u) => http(u))),
});

// v2: the Safe owner is a plain secp256k1 key derived from the passkey PRF
// (deriveOwnerKey). Standard ecrecover verification — no WebAuthn signer
// contract, no P-256 coordinates anywhere. The AA stack (pinned addresses,
// bundler/paymaster, L1/L2 singleton) lives in aa-client.ts; this is just the
// login-Safe (saltNonce 0) entry point kept for its existing call sites.
export const safeClientFromOwner = async (
  ownerPrivateKey: `0x${string}`,
): Promise<SafeWallet> => buildSafeWallet(ownerPrivateKey);

export const getLastBlock = async (): Promise<string> => {
  return (await client.getBlockNumber()).toString();
};
