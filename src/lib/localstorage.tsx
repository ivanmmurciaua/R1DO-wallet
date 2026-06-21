import localforage from "localforage";
import { LOCAL_WALLET_LIST } from "@/app/constants";
import { WalletMeta } from "@/types";
import type { StealthUTXO } from "@/lib/stealth";

// ── localStorage layout (r1do/wallet/v1) ─────────────────────────────────────
// Everything the wallet keeps locally lives under one versioned namespace, so
// nothing is scattered and a whole account wipes in one call.
//
//   r1do/wallet/v1/wallets               → [{ username, privacy }]   (global list)
//   r1do/wallet/v1/lastUser              → "<username>"              (F5 restore)
//   r1do/wallet/v1/prefs                 → { decimals, symbol }      (UI prefs)
//   r1do/wallet/v1/acct/<u>              → { zk, metaAddress, directory }
//   r1do/wallet/v1/scan/<u>/cursor       → { block, count }          (tiny, hot)
//   r1do/wallet/v1/scan/<u>/utxos        → StealthUTXO[]             (large, cold)
//
// The two globals `wallets`/`lastUser` keep their constant names (LOCAL_WALLET_LIST
// / LOCAL_LAST_USER) but now point at the namespaced keys (see constants.tsx).
//
// Scan state is split on purpose: the scanner bumps the cursor on EVERY pass
// (~3 days of blocks) but only appends UTXOs occasionally. Keeping the cursor
// (block + count) in its own tiny key lets us re-serialize the potentially huge
// UTXO array ONLY when the set actually changed — the merge upstream is
// append-only/deduped, so a length change is a perfect change signal.
//
// Credentials (username → rawId) are NOT here: they live in the shared
// IndexedDB R1DOToolsDB (credstore.ts).

const NS = "r1do/wallet/v1";
const acctKey       = (u: string) => `${NS}/acct/${u.toLowerCase()}`;
const scanCursorKey = (u: string) => `${NS}/scan/${u.toLowerCase()}/cursor`;
const scanUtxosKey  = (u: string) => `${NS}/scan/${u.toLowerCase()}/utxos`;
const PREFS_KEY     = `${NS}/prefs`;

// ── Global wallet list ───────────────────────────────────────────────────────

const readWalletList = (): WalletMeta[] => {
  let raw: unknown[] = [];
  try {
    raw = JSON.parse(localStorage.getItem(LOCAL_WALLET_LIST) || "[]") || [];
  } catch {
    raw = [];
  }
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
  // Drop the whole per-account record + scan state — re-derives/rescans on next login.
  localStorage.removeItem(acctKey(u));
  localStorage.removeItem(scanCursorKey(u));
  localStorage.removeItem(scanUtxosKey(u)); // legacy copy, if any remains
  // UTXOs now live in IndexedDB — clear the cache + durable store too.
  utxoCache.delete(u);
  hydratedUsers.delete(u);
  void utxoDB().removeItem(u).catch(() => {});
};

// ── Per-account record ───────────────────────────────────────────────────────
// Small, mostly write-once metadata bundled into one object per account.

interface Account {
  zk?: string;                 // cached 0zk (public, deterministic) — instant "Unlock"
  metaAddress?: `0x${string}`; // Δ1 stealth meta-address (public, off-chain shareable)
  directory?: string;          // directory contract address this user is published to
}

const readAccount = (username: string): Account => {
  try {
    return JSON.parse(localStorage.getItem(acctKey(username)) || "{}") || {};
  } catch {
    return {};
  }
};

const patchAccount = (username: string, partial: Partial<Account>): void => {
  localStorage.setItem(acctKey(username), JSON.stringify({ ...readAccount(username), ...partial }));
};

// Cache the user's 0zk address so re-entering the private view shows
// "registered → Unlock" instantly, without an on-chain directory read.
export const getCachedPoolZk = (username: string): string | null =>
  readAccount(username).zk ?? null;

export const setCachedPoolZk = (username: string, zkAddress: string): void =>
  patchAccount(username, { zk: zkAddress });

// Δ1: no on-chain registry — the meta-address is public data distributed
// off-chain. Cached locally so the UI can offer it for sharing without
// touching the passkey (it re-derives deterministically from the PRF anyway).
export const saveMetaAddress = (username: string, metaAddress: `0x${string}`): void =>
  patchAccount(username, { metaAddress });

export const getMetaAddress = (username: string): `0x${string}` | null =>
  readAccount(username).metaAddress ?? null;

// Marks "this user's entry exists in directory <address>" so logins skip the
// Argon2id + on-chain check. Keyed to the directory address: redeploying the
// contract invalidates the mark and triggers a lazy re-publish.
export const getDirectoryMark = (username: string): string | null =>
  readAccount(username).directory ?? null;

export const setDirectoryMark = (username: string, directoryAddress: string): void =>
  patchAccount(username, { directory: directoryAddress });

// ── Stealth scan state — cursor (localStorage) + UTXO store (IndexedDB) ───────
//
// The cursor is tiny and hot (bumped every scan pass) → stays in localStorage.
// The UTXO array is the only large/unbounded structure → it would eventually
// blow the ~5 MB localStorage quota, so it lives in IndexedDB (via localforage).
//
// A synchronous in-memory cache fronts IndexedDB so every existing call site
// keeps its SYNC signature (React reads these in render):
//   · reads  → served from the cache
//   · writes → update the cache now, persist write-through (fire-and-forget)
// The cache is the runtime source of truth; IndexedDB is the durable backing.
// hydrateStealthStore() MUST run before the wallet subtree renders any sync
// read — page.tsx gates the wallet render on it.

interface ScanCursor {
  block: string | null; // last scanned block (decimal string) — null if never scanned
  count: number;        // number of UTXOs currently cached (change signal)
}

const readCursor = (username: string): ScanCursor => {
  try {
    const c = JSON.parse(localStorage.getItem(scanCursorKey(username)) || "{}");
    return { block: typeof c.block === "string" ? c.block : null, count: Number(c.count) || 0 };
  } catch {
    return { block: null, count: 0 };
  }
};

const writeCursor = (username: string, cursor: ScanCursor): void =>
  localStorage.setItem(scanCursorKey(username), JSON.stringify(cursor));

// IndexedDB-backed UTXO store + write-through cache.
const utxoCache = new Map<string, StealthUTXO[]>();
const hydratedUsers = new Set<string>();

let _utxoDB: LocalForage | null = null;
const utxoDB = (): LocalForage => {
  // Lazy-create (never at import time) so SSR/build never touch IndexedDB.
  if (!_utxoDB) _utxoDB = localforage.createInstance({ name: "R1DOWallet", storeName: "stealthUtxos" });
  return _utxoDB;
};

const ukey = (u: string) => u.toLowerCase();
const readUtxos = (username: string): StealthUTXO[] => utxoCache.get(ukey(username)) ?? [];

// Best-effort durability: write-through persists promptly, but a write fired in
// the instant before the tab closes might not commit. Flushing the whole cache
// on pagehide / background re-issues those puts so they land. Hooked once.
let _flushHooked = false;
const hookFlush = (): void => {
  if (_flushHooked || typeof window === "undefined") return;
  _flushHooked = true;
  const flush = () => { for (const [k, arr] of utxoCache) void utxoDB().setItem(k, arr).catch(() => {}); };
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(); });
};

// Update cache synchronously, then persist write-through. We always store the
// full array snapshot and JS is single-threaded, so queued idb transactions
// commit in call order — no torn/partial writes.
const writeUtxos = (username: string, arr: StealthUTXO[]): void => {
  const k = ukey(username);
  utxoCache.set(k, arr);
  hookFlush();
  void utxoDB().setItem(k, arr).catch((e) => console.error("[stealthStore] persist failed:", e));
};

// Load one account's UTXOs idb → cache. Idempotent. Await before any sync read
// of this user's UTXOs (page.tsx gates the wallet render on it).
export const hydrateStealthStore = async (username: string): Promise<void> => {
  const k = ukey(username);
  if (hydratedUsers.has(k)) return;
  hookFlush();
  let arr: StealthUTXO[] = [];
  try { arr = (await utxoDB().getItem<StealthUTXO[]>(k)) ?? []; } catch { arr = []; }

  // TEMP migration (remove alongside localstorage-migrate.tsx once all existing
  // testers have logged in once post-change): UTXOs used to live in localStorage.
  // If idb is empty but the legacy array exists, adopt it into idb and drop the
  // localStorage copy. New users never write that key, so this is dead code for
  // them. Non-destructive: any error leaves the legacy key untouched. Don't
  // delete this branch until you're sure no tester still has un-migrated UTXOs
  // (ghost / Courier notes aren't on-chain — orphaning them = data loss).
  if (arr.length === 0) {
    try {
      const legacy = localStorage.getItem(scanUtxosKey(username));
      const parsed = legacy ? JSON.parse(legacy) : null;
      if (Array.isArray(parsed) && parsed.length > 0) {
        arr = parsed;
        await utxoDB().setItem(k, arr);
        localStorage.removeItem(scanUtxosKey(username));
      }
    } catch { /* on any error, leave the legacy key untouched */ }
  }

  utxoCache.set(k, arr);
  hydratedUsers.add(k);
};

export const getStealthUTXOs = (username: string): StealthUTXO[] => readUtxos(username);

export const getLastScannedBlock = (username: string): bigint | null => {
  const { block } = readCursor(username);
  return block ? BigInt(block) : null;
};

// Persists a scan pass. The upstream merge is append-only/deduped, so the UTXO
// array is only re-written when its length changed; the cursor (tiny) is always
// updated. With a large UTXO set, cursor-only passes cost almost nothing.
export const saveStealthScan = (
  username: string,
  utxos: StealthUTXO[],
  lastBlock: bigint,
): void => {
  const { count } = readCursor(username);
  if (utxos.length !== count) writeUtxos(username, utxos);
  writeCursor(username, { block: lastBlock.toString(), count: utxos.length });
};

// Append one stealth UTXO WITHOUT advancing the scan cursor — used by ghost-mode
// unshield and off-chain Courier import, whose payments carry no on-chain blob,
// so the local note is the only way to re-derive the spending key on this device.
export const addStealthUTXO = (username: string, utxo: StealthUTXO): void => {
  const existing = readUtxos(username);
  if (existing.some((u) => u.stealthAddress.toLowerCase() === utxo.stealthAddress.toLowerCase())) return;
  const next = [...existing, utxo];
  writeUtxos(username, next);
  const cur = readCursor(username);
  writeCursor(username, { block: cur.block, count: next.length });
};

// Patches fields of one stored UTXO (matched by address) WITHOUT changing the
// set's length — so the scan cursor's count stays valid. Used to flip `hidden`
// (never delete: the local note is the only way to spend a Courier payment) and
// to stamp `receivedAt`.
export const patchStealthUTXO = (
  username: string,
  stealthAddress: string,
  patch: Partial<StealthUTXO>,
): void => {
  const a = stealthAddress.toLowerCase();
  writeUtxos(
    username,
    readUtxos(username).map((u) => (u.stealthAddress.toLowerCase() === a ? { ...u, ...patch } : u)),
  );
};

// ── UI preferences ───────────────────────────────────────────────────────────

interface Prefs {
  decimals?: number;
  symbol?: string;
  hideBalance?: boolean; // mask the balance + amounts with "*" (sticky across F5)
}

// Default to ETH's real 18 — now that the wallet handles actual ETH/ERC20s, the
// native unit should match on-chain by default. The user can still re-theme
// decimals/symbol in config.
export const DEFAULT_DECIMALS = 18;
export const DEFAULT_SYMBOL = "⧫";

const readPrefs = (): Prefs => {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}") || {};
  } catch {
    return {};
  }
};

const patchPrefs = (partial: Partial<Prefs>): void =>
  localStorage.setItem(PREFS_KEY, JSON.stringify({ ...readPrefs(), ...partial }));

export const getDecimals = (): number => {
  const { decimals } = readPrefs();
  if (typeof decimals !== "number") {
    patchPrefs({ decimals: DEFAULT_DECIMALS });
    return DEFAULT_DECIMALS;
  }
  return decimals;
};

export const setDecimalsConfig = (decimals: number): void => patchPrefs({ decimals });

export const getSymbol = (): string => readPrefs().symbol || DEFAULT_SYMBOL;

export const setSymbolConfig = (symbol: string): void => patchPrefs({ symbol });

// Balance privacy: when on, the headline balance and the Recent Transactions
// amounts render masked ("*"). Sticky so it survives reloads.
export const getHideBalance = (): boolean => readPrefs().hideBalance ?? false;

export const setHideBalance = (hide: boolean): void => patchPrefs({ hideBalance: hide });
