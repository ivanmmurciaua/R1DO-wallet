import { LOCAL_WALLET_LIST } from "@/app/constants";
import { WalletMeta } from "@/types";
import type { StealthUTXO } from "@/lib/stealth";
import { saveWalletCredential } from "@/lib/credstore";

// v2: localStorage holds only per-wallet metadata ({ username, privacy }).
// Credentials (username → rawId) live in the shared IndexedDB R1DOToolsDB
// (credstore.ts); stealth caches in the STEALTH_* keys below.

const readWalletList = (): WalletMeta[] => {
  const raw: unknown[] =
    JSON.parse(localStorage.getItem(LOCAL_WALLET_LIST) || "[]") || [];
  return raw
    .filter((w): w is Record<string, unknown> => !!w && typeof w === "object")
    .filter((w) => typeof w.username === "string" && w.username !== "")
    .map((w) => ({ username: w.username as string, privacy: !!w.privacy }));
};

const writeWalletList = (list: WalletMeta[]): void => {
  localStorage.setItem(LOCAL_WALLET_LIST, JSON.stringify(list));
};

export const getWalletMetas = (): WalletMeta[] => readWalletList();

export const getWalletMeta = (username: string): WalletMeta | null => {
  const u = username.toLowerCase();
  return readWalletList().find((w) => w.username.toLowerCase() === u) ?? null;
};

export const setWalletMeta = (username: string, privacy?: boolean): void => {
  const list = readWalletList();
  const u = username.toLowerCase();
  const existing = list.find((w) => w.username.toLowerCase() === u);
  const entry: WalletMeta = {
    username,
    privacy: privacy ?? existing?.privacy ?? false,
  };
  writeWalletList(
    existing
      ? list.map((w) => (w.username.toLowerCase() === u ? entry : w))
      : [...list, entry],
  );
};

export const removeWalletMeta = (username: string): void => {
  const u = username.toLowerCase();
  writeWalletList(readWalletList().filter((w) => w.username.toLowerCase() !== u));
  // Drop the per-wallet caches too — they re-derive/rescan on next login.
  for (const name of new Set([username, u])) {
    localStorage.removeItem(`${STEALTH_UTXOS_PREFIX}_${name}`);
    localStorage.removeItem(`${STEALTH_BLOCK_PREFIX}_${name}`);
    localStorage.removeItem(`${STEALTH_META_PREFIX}_${name}`);
    localStorage.removeItem(`${DIRECTORY_MARK_PREFIX}_${name}`);
    localStorage.removeItem(`${POOL_ZK_PREFIX}_${name}`);
  }
};

// Marks "this user's entry exists in directory <address>" so logins skip the
// Argon2id + on-chain check. Keyed to the directory address: redeploying the
// contract invalidates the mark and triggers a lazy re-publish.
const DIRECTORY_MARK_PREFIX = "DIRECTORY_PUBLISHED";

export const getDirectoryMark = (username: string): string | null =>
  localStorage.getItem(`${DIRECTORY_MARK_PREFIX}_${username}`);

export const setDirectoryMark = (username: string, directoryAddress: string): void => {
  localStorage.setItem(`${DIRECTORY_MARK_PREFIX}_${username}`, directoryAddress);
};

/* One-time migration from the v1 list format ({ username, fingerprint,
   passkey: { rawId, coordinates, verifierAddress }, privacy }): the rawId
   moves into the shared credential store, the rest collapses to metadata.
   Entries with fingerprint === "" were aborted registrations — dropped. */
export const migrateLegacyWalletList = async (): Promise<void> => {
  const raw: unknown[] =
    JSON.parse(localStorage.getItem(LOCAL_WALLET_LIST) || "[]") || [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const entries = raw.filter((w): w is any => !!w && typeof w === "object");
  if (!entries.some((w) => "passkey" in w || "fingerprint" in w)) return;

  const kept = entries.filter(
    (w) => typeof w.username === "string" && w.username !== "" && w.fingerprint !== "",
  );
  for (const w of kept) {
    const rawId = w.passkey?.rawId;
    if (typeof rawId === "string" && rawId !== "") {
      try {
        await saveWalletCredential(w.username, rawId);
      } catch (e) {
        console.warn("[localstorage] legacy credential migration failed:", e);
      }
    }
  }
  writeWalletList(kept.map((w) => ({ username: w.username, privacy: !!w.privacy })));
  console.log(`[localstorage] ✓ Migrated ${kept.length} wallet entr${kept.length === 1 ? "y" : "ies"} to the v2 format`);
};

const STEALTH_UTXOS_PREFIX   = "STEALTH_UTXOS";
const STEALTH_BLOCK_PREFIX   = "STEALTH_LAST_BLOCK";
const STEALTH_META_PREFIX    = "STEALTH_META_ADDRESS";
const POOL_ZK_PREFIX         = "POOL_ZK_ADDRESS";

// Cache the user's (public, deterministic) 0zk address so re-entering the
// private view shows "registered → Unlock" instantly, without an on-chain
// directory read. It's public data; the secret keys still re-derive from the
// passkey each session.
export const getCachedPoolZk = (username: string): string | null =>
  localStorage.getItem(`${POOL_ZK_PREFIX}_${username}`);

export const setCachedPoolZk = (username: string, zkAddress: string): void => {
  localStorage.setItem(`${POOL_ZK_PREFIX}_${username}`, zkAddress);
};

// Δ1: no on-chain registry — the meta-address is public data distributed
// off-chain. We cache it locally so the UI can offer it for sharing without
// touching the passkey (it re-derives deterministically from the PRF anyway).
export const saveMetaAddress = (username: string, metaAddress: `0x${string}`): void => {
  localStorage.setItem(`${STEALTH_META_PREFIX}_${username}`, metaAddress);
};

export const getMetaAddress = (username: string): `0x${string}` | null => {
  return localStorage.getItem(`${STEALTH_META_PREFIX}_${username}`) as `0x${string}` | null;
};

export const getStealthUTXOs = (username: string): StealthUTXO[] => {
  const raw = localStorage.getItem(`${STEALTH_UTXOS_PREFIX}_${username}`);
  return raw ? JSON.parse(raw) : [];
};

export const saveStealthScan = (
  username: string,
  utxos: StealthUTXO[],
  lastBlock: bigint,
): void => {
  localStorage.setItem(`${STEALTH_UTXOS_PREFIX}_${username}`, JSON.stringify(utxos));
  localStorage.setItem(`${STEALTH_BLOCK_PREFIX}_${username}`, lastBlock.toString());
};

// Append one stealth UTXO to the local registry WITHOUT touching the scan
// cursor — used by ghost-mode unshield, whose payment carries no on-chain blob,
// so the local note is the ONLY way to re-derive its spending key (this device).
export const addStealthUTXO = (username: string, utxo: StealthUTXO): void => {
  const existing = getStealthUTXOs(username);
  if (existing.some((u) => u.stealthAddress.toLowerCase() === utxo.stealthAddress.toLowerCase())) return;
  localStorage.setItem(`${STEALTH_UTXOS_PREFIX}_${username}`, JSON.stringify([...existing, utxo]));
};

export const getLastScannedBlock = (username: string): bigint | null => {
  const val = localStorage.getItem(`${STEALTH_BLOCK_PREFIX}_${username}`);
  return val ? BigInt(val) : null;
};

const LOCAL_AMOUNT_CONFIG = "LOCAL_AMOUNT_CONFIG";
const LOCAL_SYMBOL_CONFIG = "LOCAL_SYMBOL_CONFIG";

export const DEFAULT_DECIMALS = 13;
export const DEFAULT_SYMBOL = "⧫";

export const getDecimals = (): number => {
  const amountConfig = localStorage.getItem(LOCAL_AMOUNT_CONFIG);
  if (!amountConfig) {
    localStorage.setItem(LOCAL_AMOUNT_CONFIG, DEFAULT_DECIMALS.toString());
    return DEFAULT_DECIMALS;
  }

  return parseInt(amountConfig);
};

export const setDecimalsConfig = (decimals: number): void => {
  localStorage.setItem(LOCAL_AMOUNT_CONFIG, decimals.toString());
};

export const getSymbol = (): string => {
  return localStorage.getItem(LOCAL_SYMBOL_CONFIG) || DEFAULT_SYMBOL;
};

export const setSymbolConfig = (symbol: string): void => {
  localStorage.setItem(LOCAL_SYMBOL_CONFIG, symbol);
};
