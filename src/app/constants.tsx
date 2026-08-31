import { directoryAddress } from "@/lib/networks";

// localStorage globals — namespaced under r1do/wallet/v1 (see lib/localstorage.tsx).
export const LOCAL_WALLET_LIST = "r1do/wallet/v1/wallets";
export const LOCAL_LAST_USER = "r1do/wallet/v1/lastUser";
// NOTE: reading the chain goes through rpcClient() in lib/client.tsx (the single
// live, failover transport over activeRpcUrls). There are deliberately NO frozen
// RPC consts here anymore — they froze the RPC list at import and ignored the
// user's overrides.
// Bundler + paymaster go through our OWN server proxy (app/api/pimlico) so the
// Pimlico API key never reaches the client bundle — it lives server-side as
// PIMLICO_API_KEY (NOT NEXT_PUBLIC_). The relay-kit just sees a JSON-RPC URL;
// the proxy injects the key and forwards to Pimlico. Bundler and paymaster share
// the same upstream, so one route serves both. Built as an absolute URL from the
// runtime origin (client-only); on server/SSR `window` is absent and it falls
// back to a relative path, never actually used (wallet init runs client-side).
const PIMLICO_PROXY_PATH = "/api/pimlico";
const PIMLICO_PROXY_ORIGIN = typeof window !== "undefined" ? window.location.origin : "";
export const BUNDLER_URL = `${PIMLICO_PROXY_ORIGIN}${PIMLICO_PROXY_PATH}`;
export const PAYMASTER_URL = BUNDLER_URL;
// Same proxy, but tells the server which network's Pimlico slug to forward to via
// `?net=`. The active chain is implicit server-side (activeNetwork), so this is
// what lets a directory op (pinned to Arbitrum) route to Arbitrum's bundler even
// while the app runs on another chain. The proxy validates the id against the
// registry. Bundler + paymaster share this URL, so both route to the same chain.
export const bundlerUrlFor = (netId: string): string => `${BUNDLER_URL}?net=${netId}`;
// v2: encrypted username directory (R1DODirectory.sol). Optional — login never
// depends on it; it only powers pay-by-username. Now a SINGLE global directory
// pinned in the network registry (not env): one address for the whole app, used
// both as the on-chain target and as the per-user "published to" mark.
export const DIRECTORY_ADDRESS = directoryAddress();

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
