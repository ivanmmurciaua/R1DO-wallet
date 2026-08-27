/* credstore.ts — shared credential store (IndexedDB "R1DOToolsDB")
   Same database and record format as the R1DO Tools suite (notes/tasks/
   chat js/r1do-auth.js): when the wallet is served from the same origin
   as the tools, one passkey registered in any of them is visible to all.
   Record: { username, credentialId, credentialIdRaw: number[], prfSupported, createdAt } */

const DB_NAME = "R1DOToolsDB";
const LEGACY_DB_NAME = "R1DONotesDB";
const STORE_NAME = "credentials";

let _db: IDBDatabase | null = null;

function openDB(name: string, version?: number, upgrade?: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = version !== undefined ? indexedDB.open(name, version) : indexedDB.open(name);
    // Safety timeout: on mobile, indexedDB.open() can hang indefinitely (a held
    // connection blocking an upgrade, a stalled backend). Without this the login
    // screen sits on "Loading wallets..." forever. Reject so callers move on.
    const timer = setTimeout(() => reject(new Error(`indexedDB.open timeout: ${name}`)), 8000);
    const done = (fn: () => void) => {
      clearTimeout(timer);
      fn();
    };
    if (upgrade) req.onupgradeneeded = (e) => upgrade((e.target as IDBOpenDBRequest).result);
    req.onsuccess = () => done(() => resolve(req.result));
    req.onerror = () => done(() => reject(req.error));
    // A concurrent open holding an older version blocks this one — don't hang on it.
    req.onblocked = () => done(() => reject(new Error(`indexedDB.open blocked: ${name}`)));
  });
}

function getAll(db: IDBDatabase): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    if (!db.objectStoreNames.contains(STORE_NAME)) return resolve([]);
    const req = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
}

const UPGRADE = (db: IDBDatabase) => {
  if (!db.objectStoreNames.contains(STORE_NAME)) {
    const store = db.createObjectStore(STORE_NAME, { keyPath: "username" });
    store.createIndex("credentialId", "credentialId", { unique: false });
    store.createIndex("createdAt", "createdAt", { unique: false });
  }
};

// Right after a heavy shadow session, mobile IndexedDB can be transiently busy
// (the engine's big scan still flushing to disk), so the FIRST open times out.
// It frees up "after a while", so retry with backoff instead of failing the
// whole login flow on one timeout — the recurring "loading forever" bug.
async function openDBWithRetry(): Promise<IDBDatabase> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await openDB(DB_NAME, 1, UPGRADE);
    } catch (e) {
      lastErr = e;
      console.warn(`[credstore] open attempt ${attempt} failed, retrying:`, e);
      await new Promise((r) => setTimeout(r, Math.min(1500 * attempt, 5000)));
    }
  }
  throw lastErr;
}

// A single in-flight init shared by all callers, so a slow open isn't multiplied
// by every concurrent credential read racing to open the same DB.
let _initInFlight: Promise<IDBDatabase> | null = null;
async function initDB(): Promise<IDBDatabase> {
  if (_db) return _db;
  if (_initInFlight) return _initInFlight;
  _initInFlight = (async () => {
    const db = await openDBWithRetry();
    _db = db;
    await runLegacyMigration(db);
    return db;
  })();
  try {
    return await _initInFlight;
  } finally {
    _initInFlight = null;
  }
}

async function runLegacyMigration(db: IDBDatabase): Promise<void> {
  // One-time migration from the legacy tools DB (only if it exists).
  try {
    const current = await getAll(db);
    // indexedDB.databases() can itself hang on some mobile browsers — cap it so
    // it never wedges init after the open already succeeded.
    const listDbs = indexedDB.databases
      ? await Promise.race([
          indexedDB.databases(),
          new Promise<IDBDatabaseInfo[]>((_, rej) =>
            setTimeout(() => rej(new Error("databases() timeout")), 3000),
          ),
        ])
      : [];
    if (current.length === 0 && listDbs.length) {
      const names = listDbs.map((d) => d.name);
      if (names.includes(LEGACY_DB_NAME)) {
        const old = await openDB(LEGACY_DB_NAME);
        const records = await getAll(old);
        old.close();
        if (records.length > 0) {
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORE_NAME, "readwrite");
            const store = tx.objectStore(STORE_NAME);
            for (const rec of records) store.put(rec);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
        }
      }
    }
  } catch (e) {
    console.warn("[credstore] legacy migration skipped:", e);
  }
}

function hexToArray(rawIdHex: string): number[] {
  const clean = rawIdHex.replace(/^0x/, "");
  const out: number[] = [];
  for (let i = 0; i < clean.length; i += 2) out.push(parseInt(clean.slice(i, i + 2), 16));
  return out;
}

function arrayToHex(bytes: number[]): string {
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64url(bytes: number[]): string {
  const bin = String.fromCharCode(...bytes);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// ── localStorage mirror ───────────────────────────────────────────────────────
// The credential id is a PUBLIC WebAuthn identifier (never the private key), so
// mirroring it to localStorage is safe. The point: while the Railgun engine is
// scanning it saturates the per-origin IndexedDB backend, so opening R1DOToolsDB
// times out for the whole scan — freezing anything that needs a credential.
// localStorage is synchronous and immune to that, so reads serve from here first
// and IndexedDB becomes a best-effort source of truth synced in the background.
const CRED_CACHE_KEY = "r1do/wallet/v1/credCache";
type Cred = { username: string; rawId: string };

function readCache(): Cred[] | null {
  try {
    const raw = localStorage.getItem(CRED_CACHE_KEY);
    if (!raw) return null;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : null;
  } catch {
    return null;
  }
}

function writeCache(list: Cred[]): void {
  try {
    localStorage.setItem(CRED_CACHE_KEY, JSON.stringify(list));
  } catch {
    /* storage disabled / full — the DB remains the source of truth */
  }
}

/** Add/replace one credential in the localStorage mirror (case-insensitive). */
function upsertCache(cred: Cred): void {
  const list = readCache() ?? [];
  const rest = list.filter(
    (c) => c.username.toLowerCase() !== cred.username.toLowerCase(),
  );
  writeCache([...rest, cred]);
}

/** Read the credential list straight from IndexedDB (no cache). */
async function listFromDB(): Promise<Cred[]> {
  const db = await initDB();
  const recs = await getAll(db);
  return recs
    .filter(
      (r) =>
        typeof r.username === "string" &&
        Array.isArray(r.credentialIdRaw) &&
        (r.credentialIdRaw as number[]).length > 0,
    )
    .map((r) => ({
      username: r.username as string,
      rawId: arrayToHex(r.credentialIdRaw as number[]),
    }));
}

export async function saveWalletCredential(username: string, rawIdHex: string): Promise<void> {
  const raw = hexToArray(rawIdHex);
  // Update the localStorage mirror FIRST (synchronous, never blocked) so the
  // credential is immediately usable even while IndexedDB is saturated by a scan.
  upsertCache({ username, rawId: arrayToHex(raw) });
  const db = await initDB(); // may retry under contention; the mirror already has it
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put({
      username,
      credentialId: base64url(raw),
      credentialIdRaw: raw,
      prfSupported: true,
      createdAt: new Date().toISOString(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** Returns the rawId (hex, as loadFromDevice expects) or null. Cache-first:
    served from the localStorage mirror when present so it never blocks on the
    IndexedDB open (which times out for the whole duration of an engine scan). */
export async function getWalletCredential(username: string): Promise<{ rawId: string } | null> {
  const all = await listWalletCredentials();
  const m = all.find((r) => r.username.toLowerCase() === username.toLowerCase());
  return m ? { rawId: m.rawId } : null;
}

/** Every credential in the shared store (wallet- and tools-registered alike).
    Cache-first: if the localStorage mirror has entries, return them immediately
    and refresh from IndexedDB in the background; otherwise read IndexedDB (with
    retry) and populate the mirror. This keeps credential access instant and
    immune to the IndexedDB saturation caused by the engine's tree scan. */
export async function listWalletCredentials(): Promise<{ username: string; rawId: string }[]> {
  const cached = readCache();
  if (cached && cached.length > 0) {
    // Refresh the mirror in the background — never block the caller on IndexedDB.
    void listFromDB()
      .then((fresh) => {
        if (fresh.length > 0) writeCache(fresh);
      })
      .catch(() => {});
    return cached;
  }
  // No usable mirror yet → we must read IndexedDB. Populate the mirror on success.
  const list = await listFromDB();
  if (list.length > 0) writeCache(list);
  return list;
}

/** Forgets the credential record (case-insensitive). The passkey itself
    survives on the authenticator — a resident-key login re-learns it. */
export async function deleteWalletCredential(username: string): Promise<void> {
  // Drop it from the localStorage mirror first (synchronous, never blocked).
  writeCache((readCache() ?? []).filter(
    (c) => c.username.toLowerCase() !== username.toLowerCase(),
  ));
  const db = await initDB();
  const recs = await getAll(db);
  const targets = recs.filter(
    (r) =>
      typeof r.username === "string" &&
      (r.username as string).toLowerCase() === username.toLowerCase(),
  );
  if (targets.length === 0) return;
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    for (const t of targets) tx.objectStore(STORE_NAME).delete(t.username as string);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
