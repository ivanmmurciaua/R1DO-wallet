/*
  aa-config.ts — PINNED Account Abstraction contract addresses (single source of
  truth). These addresses + the owner (deriveOwnerKey from the PRF) + threshold +
  saltNonce FULLY determine the counterfactual Safe address. They must NEVER change
  once users exist: any change → a different derived address → users locked out of
  their funds. Pinned EXPLICITLY (not left to the SDK's defaults) so a
  permissionless / safe-deployments update can never silently move the address.

  Values are the canonical Safe 1.4.1 + Safe4337Module 0.3.0 deployments,
  cross-checked against ~/Escritorio/the-great-dev/src/lib/aa-config.ts AND delta1's
  own src/app/constants.tsx (ENTRYPOINT + SAFE_4337_MODULE match). Frozen from here.

  ── L1 vs L2 SINGLETON (the footgun) ──────────────────────────────────────────
  The Safe singleton differs by chain type: `Safe` (L1) vs `SafeL2` (L2). Since the
  singleton enters the CREATE2 initcode, the SAME owner derives a DIFFERENT address
  on an L1 vs an L2 (but the SAME address across all L2s). Which singleton applies
  is a STATIC per-chain property declared in networks.ts (`safeSingleton:"l1"|"l2"`)
  — NEVER detected at runtime (a getCode probe would need an RPC and break the
  offline / counterfactual derivation that login and stealth addresses rely on).
  Sepolia = l1, Arbitrum One = l2, Ethereum mainnet (future) = l1.
*/
import type { Address } from "viem";

export const ENTRYPOINT_ADDRESS: Address = "0x0000000071727De22E5E9d8BAf0edAc6f37da032"; // EntryPoint v0.7 — same on all chains
export const ENTRYPOINT_VERSION = "0.7" as const;

export const SAFE_VERSION = "1.4.1" as const;

// Singletons — pick via networks.ts `safeSingleton`. NEVER change post-launch.
export const SAFE_L1_SINGLETON_ADDRESS: Address = "0x41675C099F32341bf84BFc5382aF534df5C7461a"; // Safe (L1)
export const SAFE_L2_SINGLETON_ADDRESS: Address = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762"; // SafeL2 (L2)

export const SAFE_PROXY_FACTORY_ADDRESS: Address = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
export const SAFE_MODULE_SETUP_ADDRESS: Address = "0x2dd68b007B46fBe91B9A7c3EDa5A7a1063cB5b47";
export const SAFE_4337_MODULE_ADDRESS: Address = "0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226";
export const MULTI_SEND_ADDRESS: Address = "0x38869bf66a61cF6bDB996A6aE40D5853Fd43B526";
export const MULTI_SEND_CALL_ONLY_ADDRESS: Address = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2";

// Fixed so the derived Safe address is deterministic for a given owner. Frozen.
export const SAFE_SALT_NONCE = 0n;
