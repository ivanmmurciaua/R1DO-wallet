import { Address, http, fallback } from "viem";

// localStorage globals — namespaced under r1do/wallet/v1 (see lib/localstorage.tsx).
export const LOCAL_WALLET_LIST = "r1do/wallet/v1/wallets";
export const LOCAL_LAST_USER = "r1do/wallet/v1/lastUser";
// Primary RPC (default). PublicNode handles Railgun's big batched scans well.
export const RPC_URL = "https://ethereum-sepolia-rpc.publicnode.com";
// Failover order: PublicNode first (default), then community fallbacks. Used by
// every read client and passed to Railgun's loadProvider so a single RPC blip
// doesn't stall balances/scans (matters once many testers hit it at once).
export const RPC_URLS = [
  RPC_URL,
  "https://eth-sepolia-testnet.api.pocket.network",
  "https://0xrpc.io/sep",
  "https://rpc.sepolia.ethpandaops.io",
];
// Shared viem transport with automatic failover (tries RPC_URLS in order).
export const sepoliaTransport = () => fallback(RPC_URLS.map((u) => http(u)));
export const CHAIN_NAME = "sepolia";
export const BUNDLER_URL = `https://api.pimlico.io/v2/${CHAIN_NAME}/rpc?apikey=${process.env.NEXT_PUBLIC_PIMLICO_API_KEY}`;
export const PAYMASTER_URL = `https://api.pimlico.io/v2/${CHAIN_NAME}/rpc?apikey=${process.env.NEXT_PUBLIC_PIMLICO_API_KEY}`;
// v2: encrypted username directory (R1DODirectory.sol). Optional — login
// never depends on it; it only powers pay-by-username.
export const DIRECTORY_ADDRESS = process.env
  .NEXT_PUBLIC_DIRECTORY_ADDRESS as Address;

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

// v2: the P-256 verifier constants (EIP-7212 precompile + FCL fallback) are
// gone — the owner is a PRF-derived secp256k1 key, verified by ecrecover.
