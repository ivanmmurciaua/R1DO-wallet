/*
  network.ts — LOCAL registry for the hegota frame-native rail.

  This mirrors the SHAPE of the base src/lib/networks.ts Network type but stays
  deliberately SELF-CONTAINED: it defines its own FrameNetwork type and imports
  nothing from the base registry and nothing from any hegota engine package. The
  whole point of FASE 0 is a removable rail surface: deleting this folder must
  leave the base wallet untouched, so there can be no coupling in either direction.

  A frame-native network has NO privacy pool (Railgun) and NO 4337 backend: it is
  served by the frame-tx rail. Those two facts are encoded as literal types
  (backendKind "frame-native", pool: false) so a mismatch is a compile error, not
  a runtime surprise.
*/

/** A frame-native chain descriptor. LOCAL on purpose (do not import from the base
    networks.ts or from the engine). `pool` is the literal `false`: a frame-native
    network has no shadow (Railgun) world available on this rail. */
export type FrameNetwork = {
  /** Stable rail-local id (e.g. "hegota"). */
  id: string;
  /** EVM chain id. */
  chainId: number;
  /** Human-readable display name. */
  name: string;
  /** RPC failover list, tried in order. */
  rpcUrls: readonly string[];
  /** Block explorer base URL, when the chain has one. */
  explorerUrl?: string;
  /** Faucet claim endpoint, when the chain is a testnet with one. */
  faucetUrl?: string;
  /** Native currency symbol. */
  symbol: string;
  /** Which backend serves this network. Always the frame rail here. */
  backendKind: "frame-native";
  /** No privacy pool on the frame rail (literal false). */
  pool: false;
  /** Rail singletons on this chain. The devnet resets, so these are anchors, not law:
      a reset changes the verifier (and therefore every AccountPQ address). */
  singletons?: {
    /** ZKNOX inline ML-DSA verifier (baked into each AccountPQ). */
    verifier?: `0x${string}`;
    /** CREATE2 factory that places AccountPQ at its deterministic address. */
    accountFactory?: `0x${string}`;
    /** Open on-chain paymaster that pays the one-time account deploy (no guards; only
        risks its own gas, user funds protected by the account's ML-DSA gate). */
    openSponsor?: `0x${string}`;
  };
};

/** Hegota testnet (frame-native rail). chainId 8141. Read-only in FASE 0. */
export const HEGOTA: FrameNetwork = {
  id: "hegota",
  chainId: 8141,
  name: "Hegota",
  rpcUrls: ["https://rpc1.privacy.ethrex.xyz"],
  explorerUrl: "https://dora.privacy.ethrex.xyz",
  faucetUrl: "https://faucet.privacy.ethrex.xyz/api/claim",
  symbol: "ETH",
  backendKind: "frame-native",
  pool: false,
  singletons: {
    // THE canonical ZKNOX inline ML-DSA verifier (verifyInline(demo) == VALID, 15438 bytes).
    // The wallet ASSUMES this exists and must error if it is gone (a devnet reset wipes it),
    // never auto-deploy one: an AccountPQ address depends on this, so it has to be stable.
    verifier: "0x0328c92be059d250e47650272aa09db2c7257f1f",
    accountFactory: "0xd0526914f1045eb6ec89f9a93c8599306f9f667a",
    openSponsor: "0x655aab4c59b587fd7882ff6566198b40c45a7f21",
  },
};

/** Every frame-native network known to this rail. */
export const FRAME_NETWORKS: readonly FrameNetwork[] = [HEGOTA];

/** Look up a frame-native network by its rail-local id, or undefined. */
export function frameNetworkById(id: string): FrameNetwork | undefined {
  return FRAME_NETWORKS.find((n) => n.id === id);
}
