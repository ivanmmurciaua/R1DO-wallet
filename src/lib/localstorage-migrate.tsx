/*
  localstorage-migrate.tsx — ONE-SHOT migration of the pre-namespace localStorage
  keys into the r1do/wallet/v1 layout (see lib/localstorage.tsx).

  ⚠️ SURGICAL & TEMPORARY. This file is self-contained on purpose: it hardcodes
  both the OLD key strings and the NEW ones, depends on nothing else, runs once
  (guarded by a done-flag), and is non-destructive (skips if the new layout
  already has data). To retire it in a future iteration: delete this file and
  its single call site in LoginWithPasskey.tsx. Nothing else references it.
*/

const DONE_FLAG = "r1do/wallet/v1/_migrated";

// New-layout key builders (mirror lib/localstorage.tsx — kept local on purpose).
const NEW = {
  wallets: "r1do/wallet/v1/wallets",
  lastUser: "r1do/wallet/v1/lastUser",
  prefs: "r1do/wallet/v1/prefs",
  acct: (u: string) => `r1do/wallet/v1/acct/${u}`,
  cursor: (u: string) => `r1do/wallet/v1/scan/${u}/cursor`,
  utxos: (u: string) => `r1do/wallet/v1/scan/${u}/utxos`,
};

// Old (pre-namespace) keys.
const OLD_GLOBAL = {
  walletList: "SAFE_KEY_WALLET_LIST",
  lastUser: "SAFE_LAST_USER",
  amount: "LOCAL_AMOUNT_CONFIG",
  symbol: "LOCAL_SYMBOL_CONFIG",
  theme: "LOCAL_THEME_MODE", // dead key — just sweep it
};
const OLD_PREFIX = {
  metaAddress: "STEALTH_META_ADDRESS_",
  zk: "POOL_ZK_ADDRESS_",
  directory: "DIRECTORY_PUBLISHED_",
  block: "STEALTH_LAST_BLOCK_",
  utxos: "STEALTH_UTXOS_",
};

type Acct = { zk?: string; metaAddress?: string; directory?: string };
type Scan = { block?: string; utxos?: string };

export function migrateLocalStorageToV1(): void {
  try {
    if (typeof localStorage === "undefined") return;
    if (localStorage.getItem(DONE_FLAG)) return;
    // If the new layout is already populated, assume there's nothing to move.
    if (localStorage.getItem(NEW.wallets)) {
      localStorage.setItem(DONE_FLAG, "1");
      return;
    }

    const accounts: Record<string, Acct> = {};
    const scans: Record<string, Scan> = {};
    const toDelete: string[] = [];

    // Collect per-account keys first (don't mutate storage while iterating).
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key) continue;
      const val = localStorage.getItem(key);
      if (val == null) continue;
      const suffix = (p: string) => (key.startsWith(p) ? key.slice(p.length).toLowerCase() : null);

      let u: string | null;
      if ((u = suffix(OLD_PREFIX.metaAddress)) !== null) (accounts[u] ??= {}).metaAddress = val;
      else if ((u = suffix(OLD_PREFIX.zk)) !== null) (accounts[u] ??= {}).zk = val;
      else if ((u = suffix(OLD_PREFIX.directory)) !== null) (accounts[u] ??= {}).directory = val;
      else if ((u = suffix(OLD_PREFIX.block)) !== null) (scans[u] ??= {}).block = val;
      else if ((u = suffix(OLD_PREFIX.utxos)) !== null) (scans[u] ??= {}).utxos = val;
      else continue;
      toDelete.push(key);
    }

    // ── Globals ──
    const list = localStorage.getItem(OLD_GLOBAL.walletList);
    if (list) localStorage.setItem(NEW.wallets, list); // same {username,privacy}[] shape
    const last = localStorage.getItem(OLD_GLOBAL.lastUser);
    if (last) localStorage.setItem(NEW.lastUser, last);

    const amount = localStorage.getItem(OLD_GLOBAL.amount);
    const symbol = localStorage.getItem(OLD_GLOBAL.symbol);
    const prefs: { decimals?: number; symbol?: string } = {};
    if (amount && !Number.isNaN(parseInt(amount))) prefs.decimals = parseInt(amount);
    if (symbol) prefs.symbol = symbol;
    if (Object.keys(prefs).length) localStorage.setItem(NEW.prefs, JSON.stringify(prefs));

    [OLD_GLOBAL.walletList, OLD_GLOBAL.lastUser, OLD_GLOBAL.amount, OLD_GLOBAL.symbol, OLD_GLOBAL.theme]
      .forEach((k) => localStorage.removeItem(k));

    // ── Per-account record ──
    for (const [u, acct] of Object.entries(accounts)) {
      const clean = Object.fromEntries(Object.entries(acct).filter(([, v]) => v != null));
      if (Object.keys(clean).length) localStorage.setItem(NEW.acct(u), JSON.stringify(clean));
    }

    // ── Per-account scan (split cursor/utxos, with the count guard) ──
    for (const [u, s] of Object.entries(scans)) {
      let count = 0;
      if (s.utxos) {
        localStorage.setItem(NEW.utxos(u), s.utxos);
        try {
          count = (JSON.parse(s.utxos) || []).length;
        } catch {
          count = 0;
        }
      }
      localStorage.setItem(NEW.cursor(u), JSON.stringify({ block: s.block ?? null, count }));
    }

    for (const k of toDelete) localStorage.removeItem(k);
    localStorage.setItem(DONE_FLAG, "1");
    console.log(
      `[migrate→v1] moved ${Object.keys(accounts).length} account(s), ${Object.keys(scans).length} scan set(s)`,
    );
  } catch (e) {
    console.warn("[migrate→v1] skipped:", e);
  }
}
