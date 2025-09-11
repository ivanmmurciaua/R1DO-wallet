import { Address } from "viem";

export const LOCAL_WALLET_LIST = "SAFE_KEY_WALLET_LIST";
export const RPC_URL = "https://sepolia-rollup.arbitrum.io/rpc";
export const CHAIN_NAME = "arbitrum-sepolia";
export const BUNDLER_URL = `https://api.pimlico.io/v1/${CHAIN_NAME}/rpc?add_balance_override&apikey=${process.env.NEXT_PUBLIC_PIMLICO_API_KEY}`;
export const PAYMASTER_URL = `https://api.pimlico.io/v2/${CHAIN_NAME}/rpc?add_balance_override&apikey=${process.env.NEXT_PUBLIC_PIMLICO_API_KEY}`;
export const REGISTRY_ADDRESS = process.env
  .NEXT_PUBLIC_REGISTRY_ADDRESS as Address;

// Constants to avoid future Safe default config changes
// If using Pimlico, see https://docs.pimlico.io/guides/how-to/erc20-paymaster/contract-addresses#erc-20-paymaster-contract-addresses
export const PAYMASTER_ADDRESS = "0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402";

//If using Pimlico, see https://docs.pimlico.io/references/paymaster/verifying-paymaster/endpoints - v6
export const ENTRYPOINT_ADDRESS = "0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789";

// See SAFE_MODULES_ADDRESS
export const SAFE_MODULES_VERSION = "0.2.0";

// https://docs.safe.global/advanced/smart-account-supported-networks?module=Safe+4337+Module
export const SAFE_MODULES_ADDRESS =
  "0xa581c4A4DB7175302464fF3C06380BC3270b4037";

// This or newer. Works well with 0.2.0
export const SAFE_SW_VERSION = "1.4.1";
