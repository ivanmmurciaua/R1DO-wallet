import localforage from "localforage";
import { LOCAL_WALLET_LIST } from "@/app/constants";
import { WalletMeta } from "@/types";
import type { StealthUTXO } from "@/lib/stealth";
import { activeChainId, NETWORKS } from "@/lib/networks";

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
// Scan state is partitioned per {username, chainId}: stealth UTXOs and the scan
// cursor are chain-specific (an address scanned on chain A means nothing on B),
// so each chain gets its own keys — no cross-chain mixing when the network
// switcher lands. Reads/writes always target the ACTIVE chain (read internally,
// not threaded through call sites, so every sync render reader stays untouched).
const scanCursorKey = (u: string) => `${NS}/scan/${u.toLowerCase()}/${activeChainId()}/cursor`;
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
  // UTXOs now live in IndexedDB — clear the cache + durable store too.
  utxoCache.delete(u);
  hydratedUsers.delete(u);
  void utxoDB().removeItem(u).catch(() => {});
};

// ── Per-account record ───────────────────────────────────────────────────────
// Small, mostly write-once metadata bundled into one object per account.

interface Account {
  zk?: string;                 // cached 0zk (public, deterministic) — instant "Unlock"
  metaAddress?: `0x${string}`; // Δ stealth meta-address (public, off-chain shareable)
  directory?: string;          // directory contract address this user is published to
  findableNudgeDismissed?: boolean; // user dismissed the "make me findable" banner
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

// Δ: no on-chain registry — the meta-address is public data distributed
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

export const setDirectoryMark = (username: string, directoryAddress: string): void => {
  // Becoming findable makes the "nudge dismissed" flag moot — drop the property
  // entirely (not just set false) so the account object stays clean.
  const acct = readAccount(username);
  delete acct.findableNudgeDismissed;
  acct.directory = directoryAddress;
  localStorage.setItem(acctKey(username), JSON.stringify(acct));
};

// Persisted dismissal of the "make me findable" nudge, so it doesn't nag on
// every reload. Safe to dismiss: the action is always available from Settings.
// Cleared automatically once findable (see setDirectoryMark).
export const getFindableNudgeDismissed = (username: string): boolean =>
  readAccount(username).findableNudgeDismissed ?? false;

export const setFindableNudgeDismissed = (username: string): void =>
  patchAccount(username, { findableNudgeDismissed: true });

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
    const raw = localStorage.getItem(scanCursorKey(username)) ?? "{}";
    const c = JSON.parse(raw);
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

// UTXO store key — partitioned per {username, chainId} (see scanCursorKey note).
const ukey = (u: string) => `${u.toLowerCase()}:${activeChainId()}`;
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

  utxoCache.set(k, arr);
  hydratedUsers.add(k);
};

export const getStealthUTXOs = (username: string): StealthUTXO[] => readUtxos(username);

// Spendable UTXOs only — drops the tombstoned (spentAt) ones. Use this for every
// balance sum and spend planner so dead, one-time addresses stop costing RPC.
// History / receive / merge paths keep using the raw getStealthUTXOs (a spent
// UTXO re-discovered after a cursor reset must dedup against its tombstone, not
// resurrect as fresh).
export const getSpendableUTXOs = (username: string): StealthUTXO[] =>
  readUtxos(username).filter((u) => !u.spentAt);

export const getLastScannedBlock = (username: string): bigint | null => {
  const { block } = readCursor(username);
  return block ? BigInt(block) : null;
};

// Does this user have a stealth scan cursor for `chainId`? A cursor is a resume
// point: a payment on that chain is caught the next time the user scans it (the
// scanner picks up from the cursor). WITHOUT one, a fresh scan would start "from
// now" and silently skip anything already received — so a cursor-less chain must
// NEVER be advertised as receivable (the late-scan hazard the feedback flagged).
export const hasScanCursor = (username: string, chainId: number): boolean => {
  try {
    const raw = localStorage.getItem(`${NS}/scan/${username.toLowerCase()}/${chainId}/cursor`);
    if (!raw) return false;
    const c = JSON.parse(raw) as ScanCursor;
    return typeof c.block === "string" && c.block.length > 0;
  } catch {
    return false;
  }
};

// Chains it's SAFE to receive on: any with a cursor, plus the active one (it's
// being scanned right now). Names are chain.name, active first. Used by the
// Receive screens to tell the user exactly where a payment won't be missed.
export const receivableChainNames = (username: string): string[] => {
  const active = activeChainId();
  return NETWORKS.filter((n) => n.chain.id === active || hasScanCursor(username, n.chain.id))
    .sort((a, b) => (a.chain.id === active ? -1 : b.chain.id === active ? 1 : 0))
    .map((n) => n.chain.name);
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

// Durable variant for the WINDOWED scan: AWAITS the idb UTXO commit BEFORE
// advancing the cursor, so the cursor can never outrun the persisted UTXOs. If
// the user leaves mid-scan, the cursor sits at the last window whose UTXOs are
// safely in idb → no UTXO is ever skipped on resume. (saveStealthScan's write is
// fire-and-forget — fine for a single end-of-scan save, NOT for per-window.)
export const saveStealthScanDurable = async (
  username: string,
  utxos: StealthUTXO[],
  lastBlock: bigint,
): Promise<void> => {
  const { count } = readCursor(username);
  if (utxos.length !== count) {
    const k = ukey(username);
    utxoCache.set(k, utxos);
    hookFlush();
    await utxoDB().setItem(k, utxos); // await the idb commit BEFORE the cursor
  }
  writeCursor(username, { block: lastBlock.toString(), count: utxos.length });
};

// Append one stealth UTXO WITHOUT advancing the scan cursor — used by ghost-mode
// unshield and off-chain Courier import, whose payments carry no on-chain blob,
// so the local note is the only way to re-derive the spending key on this device.
export const addStealthUTXO = (username: string, utxo: StealthUTXO): void => {
  const existing = readUtxos(username);
  if (existing.some((u) => u.stealthAddress.toLowerCase() === utxo.stealthAddress.toLowerCase())) return;
  // No on-chain blob backs these (ghost-mode / Courier) → the local note is the
  // only spending-key material. Mark localOnly so purge never hard-deletes them.
  const next = [...existing, { ...utxo, localOnly: true }];
  writeUtxos(username, next);
  const cur = readCursor(username);
  writeCursor(username, { block: cur.block, count: next.length });
};

// Merge a window's worth of SCANNED UTXOs, deduped, WITHOUT moving the cursor's
// block — the calendar deep-scan's persistence seam.
//
// The deep-scan sweeps a range BELOW the cursor, so it must never touch `block`:
// that field means "scanned forward up to here" and nothing else. Letting a
// backfill write it would drag the resume point backwards and re-scan (or worse,
// skip) live payments. So the cursor keeps its exact meaning, and the deep-scan
// contributes only UTXOs.
//
// Unlike addStealthUTXO this does NOT mark `localOnly`: these ARE backed by an
// on-chain blob (that is how the scanner found them), so purge may treat them as
// re-discoverable, exactly like the ones the forward scan stores.
//
// Durable (awaits the idb commit) so leaving mid-deep-scan still keeps whatever
// it already found. The deep-scan's own progress is in-memory and dies with the
// page — the money it turned up does not.
// Returns how many were actually NEW, so a caller can report "found 3" and mean
// it rather than counting re-reads of UTXOs it already had.
export const mergeStealthUTXOsDurable = async (
  username: string,
  utxos: StealthUTXO[],
): Promise<number> => {
  if (utxos.length === 0) return 0;
  const existing = readUtxos(username);
  const seen = new Set(existing.map((u) => u.stealthAddress.toLowerCase()));
  const fresh = utxos.filter((u) => {
    const a = u.stealthAddress.toLowerCase();
    if (seen.has(a)) return false; // dedups against tombstones too — a spent UTXO
    seen.add(a); //                   re-found by a backfill must NOT resurrect
    return true;
  });
  if (fresh.length === 0) return 0;

  const next = [...existing, ...fresh];
  const k = ukey(username);
  utxoCache.set(k, next);
  hookFlush();
  await utxoDB().setItem(k, next);
  const cur = readCursor(username);
  writeCursor(username, { block: cur.block, count: next.length });
  return fresh.length;
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

// Hard-removes one UTXO (matched by address) and fixes the cursor count so it
// stays a valid change signal. Unlike patch/hide this changes the set length —
// only ever call it on re-derivable notes (a chain re-scan can re-find them);
// NEVER on localOnly notes. applyStealthCleanup enforces that.
export const removeStealthUTXO = (username: string, stealthAddress: string): void => {
  const a = stealthAddress.toLowerCase();
  const next = readUtxos(username).filter((u) => u.stealthAddress.toLowerCase() !== a);
  writeUtxos(username, next);
  const cur = readCursor(username);
  writeCursor(username, { block: cur.block, count: next.length });
};

// Called when a refresh observes a previously-funded UTXO drained to 0. In
// "tombstone" mode (default) it stamps spentAt so the address drops out of
// future reads but the record + spending key survive. In "purge" mode it hard-
// removes re-derivable notes (smaller local footprint) but STILL only tombstones
// localOnly notes — deleting those = funds unspendable forever. Idempotent.
export const applyStealthCleanup = (username: string, stealthAddress: string): void => {
  const a = stealthAddress.toLowerCase();
  const utxo = readUtxos(username).find((u) => u.stealthAddress.toLowerCase() === a);
  if (!utxo || utxo.spentAt) return; // unknown or already tombstoned → no-op
  if (getUtxoCleanup() === "purge" && !utxo.localOnly) {
    removeStealthUTXO(username, stealthAddress);
  } else {
    patchStealthUTXO(username, stealthAddress, { spentAt: Date.now() });
  }
};

// One-shot sweep: hard-remove every tombstoned re-derivable note (localOnly
// stays). For the "purge now" action when a user opts into minimal footprint.
export const purgeSpentUTXOs = (username: string): void => {
  const next = readUtxos(username).filter((u) => !(u.spentAt && !u.localOnly));
  writeUtxos(username, next);
  const cur = readCursor(username);
  writeCursor(username, { block: cur.block, count: next.length });
};

// ── UI preferences ───────────────────────────────────────────────────────────

export type UtxoCleanup = "tombstone" | "purge";

interface Prefs {
  decimals?: number;
  symbol?: string;
  hideBalance?: boolean; // mask the balance + amounts with "*" (sticky across F5)
  // Spent-UTXO policy. "tombstone" (default): keep the record, just stop querying
  // it. "purge": also hard-delete re-derivable spent notes (localOnly always kept).
  // UI switch is locked to "tombstone" for now; the purge path is wired for when
  // it unlocks.
  utxoCleanup?: UtxoCleanup;
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

// Spent-UTXO policy (see Prefs). Default "tombstone"; switch locked there for now.
export const getUtxoCleanup = (): UtxoCleanup => readPrefs().utxoCleanup ?? "tombstone";

export const setUtxoCleanup = (mode: UtxoCleanup): void => patchPrefs({ utxoCleanup: mode });
