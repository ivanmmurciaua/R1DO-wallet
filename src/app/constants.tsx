export const RPC_URL = "https://sepolia-rollup.arbitrum.io/rpc";
export const CHAIN_NAME = "arbitrum-sepolia";
export const PAYMASTER_ADDRESS = "0x888888888888Ec68A58AB8094Cc1AD20Ba3D2402";
export const BUNDLER_URL = `https://api.pimlico.io/v1/${CHAIN_NAME}/rpc?add_balance_override&apikey=${process.env.NEXT_PUBLIC_PIMLICO_API_KEY}`;
export const PAYMASTER_URL = `https://api.pimlico.io/v2/${CHAIN_NAME}/rpc?add_balance_override&apikey=${process.env.NEXT_PUBLIC_PIMLICO_API_KEY}`;
export const REGISTRY_ADDRESS = process.env.NEXT_PUBLIC_REGISTRY_ADDRESS;
