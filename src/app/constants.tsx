import { Address, http, fallback } from "viem";
import { activeRpcUrls } from "@/lib/networks";

// localStorage globals — namespaced under r1do/wallet/v1 (see lib/localstorage.tsx).
export const LOCAL_WALLET_LIST = "r1do/wallet/v1/wallets";
export const LOCAL_LAST_USER = "r1do/wallet/v1/lastUser";
// Chain config is derived from the active network (see lib/networks.ts) — the
// single source of truth. These re-exports keep the existing wide imports
// working unchanged while the actual values live in one extensible registry.
// Failover order (see activeRpcUrls / the network registry): public RPCs only.
// Used by every read client and passed to Railgun's loadProvider so a single RPC
// blip doesn't stall balances/scans (matters once many testers hit it at once).
export const RPC_URLS = activeRpcUrls();
// Primary RPC (index 0 of the public list).
export const RPC_URL = RPC_URLS[0];
// Shared viem transport with automatic failover (tries RPC_URLS in order).
// Name kept for back-compat; it follows the active chain, not Sepolia per se.
export const sepoliaTransport = () => fallback(RPC_URLS.map((u) => http(u)));
// Bundler + paymaster go through our OWN server proxy (app/api/pimlico) so the
// Pimlico API key never reaches the client bundle — it lives server-side as
// PIMLICO_API_KEY (NOT NEXT_PUBLIC_). The relay-kit just sees a JSON-RPC URL;
// the proxy injects the key and forwards to Pimlico. Bundler and paymaster share
// the same upstream, so one route serves both. Built as an absolute URL from the
// runtime origin (client-only); on server/SSR `window` is absent and it falls
// back to a relative path, never actually used (wallet init runs client-side).
// NOTE: the static IPFS export has no server → no proxy; that build is frozen.
const PIMLICO_PROXY_PATH = `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/api/pimlico`;
const PIMLICO_PROXY_ORIGIN = typeof window !== "undefined" ? window.location.origin : "";
export const BUNDLER_URL = `${PIMLICO_PROXY_ORIGIN}${PIMLICO_PROXY_PATH}`;
export const PAYMASTER_URL = BUNDLER_URL;
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
