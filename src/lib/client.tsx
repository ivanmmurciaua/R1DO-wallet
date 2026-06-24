import {
  BUNDLER_URL,
  ENTRYPOINT_ADDRESS,
  PAYMASTER_URL,
  OPS_RPC_URL,
  SAFE_MODULES_ADDRESS,
  SAFE_MODULES_VERSION,
  SAFE_SW_VERSION,
  sepoliaTransport,
} from "@/app/constants";
import { PaymasterOptions, Safe4337Pack } from "@safe-global/relay-kit";
import { createPublicClient } from "viem";
import { activeChain } from "@/lib/networks";

export const client = createPublicClient({
  chain: activeChain(),
  transport: sepoliaTransport(),
});

const paymasterOptions: PaymasterOptions = {
  isSponsored: true,
  paymasterUrl: PAYMASTER_URL,
};

// v2: the Safe owner is a plain secp256k1 key derived from the passkey PRF
// (deriveOwnerKey). Standard ecrecover verification — no WebAuthn signer
// contract, no P-256 coordinates anywhere.
export const safeClientFromOwner = async (
  ownerPrivateKey: `0x${string}`,
): Promise<Safe4337Pack> => {
  const { privateKeyToAccount } = await import("viem/accounts");
  const ownerAddress = privateKeyToAccount(ownerPrivateKey).address;

  return Safe4337Pack.init({
    // Operations RPC ≠ scanner's primary, so a heavy scan can't 429 the reads
    // the relay-kit needs to build/deploy (Pimlico is bundler-only and can't
    // serve eth_getCode/eth_call/eth_getBalance — verified -32601).
    provider: OPS_RPC_URL,
    signer: ownerPrivateKey,
    bundlerUrl: BUNDLER_URL,
    safeModulesVersion: SAFE_MODULES_VERSION,
    customContracts: {
      entryPointAddress: ENTRYPOINT_ADDRESS,
      safe4337ModuleAddress: SAFE_MODULES_ADDRESS,
    },
    paymasterOptions,
    options: {
      safeVersion: SAFE_SW_VERSION,
      owners: [ownerAddress],
      threshold: 1,
    },
  });
};

export const getLastBlock = async (): Promise<string> => {
  return (await client.getBlockNumber()).toString();
};
