/*
  network.ts — LOCAL registry for the hegota frame-native rail.

  This mirrors the SHAPE of the base src/lib/networks.ts Network type but stays
  deliberately SELF-CONTAINED: it defines its own FrameNetwork type and imports
  nothing from the base registry and nothing from any hegota engine package. The
  rail is a removable surface: deleting this folder must
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
      a reset changes the verifier (and therefore every AccountMldsaS address). */
  singletons?: {
    /** ZKNOX inline ML-DSA verifier, verifyInline(pk, h, sig). Baked into the initcode (and kept in
        storage) of every AccountMldsaS (ML-DSA-44 rail). */
    verifier?: `0x${string}`;
    /** Generic CREATE2 factory (calldata salt || initcode), shared by both account classes. */
    accountFactory?: `0x${string}`;
    /** Open on-chain sponsor that pays the one-time account deploy for any initcode (no guards;
        only risks its own gas, user funds are protected by the account's signature gate). */
    openSponsor?: `0x${string}`;
    /** leanSphincs-s stateless verifier, verify(bytes32,bytes32,bytes32,bytes) (stored in each account). */
    lssVerifier?: `0x${string}`;
    /** Frame module each SphincsFrameAccountS delegates verifyFrameAndApprove(uint256) to. */
    lssFrameModule?: `0x${string}`;
    /** Keyless paymaster: its VERIFY frame APPROVEs PAYMENT only if EXTCODEHASH(tx.sender) equals
        lssAccountCodehash. No key, no operator; refillable with a plain ETH transfer. */
    lssPaymaster?: `0x${string}`;
    /** Runtime codehash of the SphincsFrameAccountS class (the paymaster's gate; preflight check). */
    lssAccountCodehash?: `0x${string}`;
    /** Keyless paymaster of the ML-DSA-44 rail: same runtime as lssPaymaster with only the gated
        class hash swapped (mldsaAccountCodehash). A SEPARATE balance on purpose: an ML-DSA spend
        costs ~15.3M gas, so sharing one balance would let the expensive class drain the cheap one. */
    mldsaPaymaster?: `0x${string}`;
    /** Runtime codehash of the AccountMldsaS class (commit + verifier in storage, so one hash for
        every key; the ML-DSA paymaster's gate and the preflight check). */
    mldsaAccountCodehash?: `0x${string}`;
  };
};

/** Hegota testnet (frame-native rail). chainId 8141. */
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
    // never auto-deploy one: an AccountMldsaS address depends on this, so it has to be stable.
    // Used by the ML-DSA-44 rail (AccountMldsaS).
    verifier: "0x0328c92be059d250e47650272aa09db2c7257f1f",
    accountFactory: "0xd0526914f1045eb6ec89f9a93c8599306f9f667a",
    openSponsor: "0x655aab4c59b587fd7882ff6566198b40c45a7f21",
    // leanSphincs-s rail. Like the verifier above, these are part of every account's initcode,
    // so a devnet reset that re-anchors them changes every address: error, never auto-deploy.
    lssVerifier: "0xae3ba3e1dc1bd3866608eca1498d3e9263b3481a",
    lssFrameModule: "0xaa481e835ec1b82e528d6d36d432f9af440b4295",
    lssPaymaster: "0xba5eec1c86aa5d27ae8e283fa22c8df888b680de",
    lssAccountCodehash: "0x084e0548828c282ea6e8bc70139b7657d267a156d4e7e936869fec6fd2d4924b",
    // ML-DSA-44 rail. The paymaster is keyless (no withdraw, refillable by a plain transfer).
    mldsaPaymaster: "0x84f81d3a37428646bf7292460312c4b687e6ea75",
    mldsaAccountCodehash: "0x54d7443d7f95569f60ceff1214759da88842a59a9c28909f77413935a406adac",
  },
};

/** Every frame-native network known to this rail. */
export const FRAME_NETWORKS: readonly FrameNetwork[] = [HEGOTA];

/** Look up a frame-native network by its rail-local id, or undefined. */
export function frameNetworkById(id: string): FrameNetwork | undefined {
  return FRAME_NETWORKS.find((n) => n.id === id);
}
