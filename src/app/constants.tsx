import { Address } from "viem";

export const LOCAL_WALLET_LIST = "SAFE_KEY_WALLET_LIST";
export const LOCAL_LAST_USER = "SAFE_LAST_USER";
export const RPC_URL = "https://sepolia.drpc.org";
export const CHAIN_NAME = "sepolia";
export const BUNDLER_URL = `https://api.pimlico.io/v2/${CHAIN_NAME}/rpc?apikey=${process.env.NEXT_PUBLIC_PIMLICO_API_KEY}`;
export const PAYMASTER_URL = `https://api.pimlico.io/v2/${CHAIN_NAME}/rpc?apikey=${process.env.NEXT_PUBLIC_PIMLICO_API_KEY}`;
export const REGISTRY_ADDRESS = process.env
  .NEXT_PUBLIC_REGISTRY_ADDRESS as Address;

// Constants to avoid future Safe default config changes
// If using Pimlico, see https://docs.pimlico.io/guides/how-to/erc20-paymaster/contract-addresses#erc-20-paymaster-contract-addresses
// https://docs.pimlico.io/references/paymaster/verifying-paymaster/endpoints
export const ENTRYPOINT_ADDRESS = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";

// https://docs.safe.global/advanced/smart-account-supported-networks?module=Safe+4337+Module
export const SAFE_MODULES_VERSION = "0.3.0";
export const SAFE_MODULES_ADDRESS =
  "0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226";

// This or newer. Works well with 0.2.0
export const SAFE_SW_VERSION = "1.4.1";

// P256 / secp256r1 verifiers — EIP-7212 precompile (0x0100) + FCL fallback
// SharedSigner tries precompile first (~6.9k gas), falls back to FCL if empty
export const FCL_P256_VERIFIER = "0xA86e0054C51E4894D88762a017ECc5E5235f5DBA";
const _P256_PRECOMPILE = 0x0100n;
export const PACKED_VERIFIERS = (_P256_PRECOMPILE << 160n) | BigInt(FCL_P256_VERIFIER);
// uint176 hex string — used as verifierAddress in PasskeyArgType
export const PACKED_VERIFIERS_HEX = `0x${PACKED_VERIFIERS.toString(16).padStart(44, "0")}` as const;
