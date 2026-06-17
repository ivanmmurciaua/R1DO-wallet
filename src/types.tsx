export type PasskeyResponseType = {
  rawId: string;
  prfOutput?: Uint8Array;
};

// v2: localStorage keeps only per-wallet metadata. Credentials (username →
// rawId) live in the shared IndexedDB R1DOToolsDB (src/lib/credstore.ts).
export type WalletMeta = {
  username: string;
  privacy?: boolean;
};
