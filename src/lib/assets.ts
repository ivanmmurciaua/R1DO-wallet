/*
  assets.ts — asset registry (multi-asset × multi-network foundation).

  Mirrors the networks.ts / pool/protocols.ts pattern. Today the wallet assumes
  a single native asset (getDecimals/getSymbol globals in localstorage.tsx). This
  module introduces a per-asset, per-network abstraction WITHOUT changing any
  behaviour: the native asset is still derived from prefs (the themeable ⧫/13
  unit), and the ERC20 token lists are declared but not yet consumed.

  Adding a chain (networks.ts) will force adding its assets here (the Record is
  keyed by NetworkId) — that's the discipline that keeps multi-network a flip of
  a switch, not a rewrite.

  SDK-free on purpose (no Railgun imports) so importing this stays light.
  Addresses lifted from the Railgun SDK token maps.
*/
import { formatUnits, parseUnits } from "viem";
import { getSymbol, getDecimals } from "./localstorage";
import { activeNetwork, type NetworkId } from "./networks";

export type AssetKind = "native" | "erc20";

export type Asset = {
  kind: AssetKind;
  symbol: string;
  decimals: number;
  /** undefined for the native asset; the ERC20 contract address otherwise. */
  address?: `0x${string}`;
  name?: string;
};

type NetworkAssets = {
  /** Curated ERC20 list for this chain (extensible; add-by-address is a later layer). */
  tokens: readonly Asset[];
  /** Base-token (wrapped native) address Railgun uses for the native shield/
      unshield path — needed in the Railgun ERC20 phase. */
  wrappedNative: `0x${string}`;
};

// NOTE: the NATIVE asset is intentionally NOT in this registry — it's derived
// from prefs via nativeAsset() (the wallet's themeable ⧫/13 unit), so Fase 0
// changes nothing on the native side.
const REGISTRY: Record<NetworkId, NetworkAssets> = {
  sepolia: {
    wrappedNative: "0xfff9976782d46cc05630d1f6ebab18b2324d6b14", // WETH (Railgun base token), 18 dec
    // Curated to match Railway (the official Railgun wallet) — these are the
    // Sepolia test tokens its POI infra actually supports (faucet + working POI).
    // Decimals READ ON-CHAIN (not assumed): this USDC deployment is 18, not 6.
    tokens: [
      { kind: "erc20", symbol: "DAI", decimals: 18, address: "0x3e622317f8C93f7328350cF0B56d9eD4C620C5d6", name: "Dai Stablecoin" },
      { kind: "erc20", symbol: "USDT", decimals: 6, address: "0x7169D38820dfd117C3FA1f22a697dBA58d90BA06", name: "Tether USD" },
      { kind: "erc20", symbol: "USDC", decimals: 18, address: "0x8267cF9254734C6Eb452a7bb9AAF97B392258b21", name: "USD Coin" },
    ],
  },
  // ── Multi-network prepared (activate in Fase 5: add to networks.ts NETWORKS +
  //    a switcher; this Record will then REQUIRE the new key) ──
  // arbitrum: {
  //   wrappedNative: "0x82af49447d8a07e3bd95bd0d56f35241523fbab1", // WETH
  //   tokens: [
  //     { kind: "erc20", symbol: "USDC", decimals: 6, address: "0xaf88d065e77c8cc2239327c5edb3a432268e5831" },
  //   ],
  // },
};

/** The native asset — themeable ⧫/13 unit from prefs (same source as today). */
export function nativeAsset(): Asset {
  return { kind: "native", symbol: getSymbol(), decimals: getDecimals() };
}

/** Curated ERC20s for the active network. */
export function activeTokens(): readonly Asset[] {
  return REGISTRY[activeNetwork().id].tokens;
}

/** Native + curated tokens for the active network (native first). */
export function activeAssets(): Asset[] {
  return [nativeAsset(), ...activeTokens()];
}

/** Base-token (wrapped native) address for the active network. */
export function activeWrappedNative(): `0x${string}` {
  return REGISTRY[activeNetwork().id].wrappedNative;
}

/** Look up a curated token by contract address on the active network. */
export function assetByAddress(address: string): Asset | undefined {
  const a = address.toLowerCase();
  return activeTokens().find((t) => t.address?.toLowerCase() === a);
}

// Per-asset format/parse — replace the global getDecimals()-based calls as each
// flow goes multi-asset (Fase 1/2). Native keeps working unchanged via nativeAsset().
export const formatAsset = (amount: bigint, asset: Asset): string => formatUnits(amount, asset.decimals);
export const parseAsset = (value: string, asset: Asset): bigint => parseUnits(value, asset.decimals);
