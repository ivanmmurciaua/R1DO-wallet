import { Address } from "viem";

export const RPC_URL = "https://sepolia-rollup.arbitrum.io/rpc";
export const CHAIN_NAME = "arbitrum-sepolia";
export const BUNDLER_URL = `https://api.pimlico.io/v1/${CHAIN_NAME}/rpc?add_balance_override&apikey=${process.env.NEXT_PUBLIC_PIMLICO_API_KEY}`;
export const PAYMASTER_URL = `https://api.pimlico.io/v2/${CHAIN_NAME}/rpc?add_balance_override&apikey=${process.env.NEXT_PUBLIC_PIMLICO_API_KEY}`;
export const REGISTRY_ADDRESS = process.env
  .NEXT_PUBLIC_REGISTRY_ADDRESS as Address;

// Constants to avoid future Safe default config changes
export const PAYMASTER_ADDRESS = "0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402";
export const ENTRYPOINT_ADDRESS = "0x0000000071727De22E5E9d8BAf0edAc6f37da032";
export const SAFE_MODULES_VERSION = "0.3.0";
export const SAFE_MODULES_ADDRESS =
  "0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226";
export const SAFE_SW_VERSION = "1.4.1";
