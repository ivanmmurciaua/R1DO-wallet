export const RPC_URL = "https://sepolia.drpc.org";
export const CHAIN_NAME = "sepolia";
export const PAYMASTER_ADDRESS = "0x0000000000325602a77416A16136FDafd04b299f";
export const BUNDLER_URL = `https://api.pimlico.io/v1/${CHAIN_NAME}/rpc?add_balance_override&apikey=${process.env.NEXT_PUBLIC_PIMLICO_API_KEY}`;
export const PAYMASTER_URL = `https://api.pimlico.io/v2/${CHAIN_NAME}/rpc?add_balance_override&apikey=${process.env.NEXT_PUBLIC_PIMLICO_API_KEY}`;
export const REGISTRY_ADDRESS = "0xD6cC5C4ABa98c4AA41ced0555f96c76DF37971eB";
