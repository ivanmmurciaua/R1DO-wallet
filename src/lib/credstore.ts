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
    if (upgrade) req.onupgradeneeded = (e) => upgrade((e.target as IDBOpenDBRequest).result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
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

async function initDB(): Promise<IDBDatabase> {
  if (_db) return _db;
  _db = await openDB(DB_NAME, 1, (db) => {
    if (!db.objectStoreNames.contains(STORE_NAME)) {
      const store = db.createObjectStore(STORE_NAME, { keyPath: "username" });
      store.createIndex("credentialId", "credentialId", { unique: false });
      store.createIndex("createdAt", "createdAt", { unique: false });
    }
  });

  // One-time migration from the legacy tools DB (only if it exists).
  try {
    const current = await getAll(_db);
    if (current.length === 0 && indexedDB.databases) {
      const names = (await indexedDB.databases()).map((d) => d.name);
      if (names.includes(LEGACY_DB_NAME)) {
        const old = await openDB(LEGACY_DB_NAME);
        const records = await getAll(old);
        old.close();
        if (records.length > 0) {
          await new Promise<void>((resolve, reject) => {
            const tx = _db!.transaction(STORE_NAME, "readwrite");
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

  return _db;
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

export async function saveWalletCredential(username: string, rawIdHex: string): Promise<void> {
  const db = await initDB();
  const raw = hexToArray(rawIdHex);
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

/** Returns the rawId (hex, as loadFromDevice expects) or null. */
export async function getWalletCredential(username: string): Promise<{ rawId: string } | null> {
  const db = await initDB();
  const rec = await new Promise<{ credentialIdRaw?: number[] } | undefined>((resolve, reject) => {
    const req = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).get(username);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  if (rec?.credentialIdRaw?.length) return { rawId: arrayToHex(rec.credentialIdRaw) };

  // The tools store usernames verbatim while the wallet lowercases them —
  // fall back to a case-insensitive match.
  const all = await listWalletCredentials();
  const m = all.find((r) => r.username.toLowerCase() === username.toLowerCase());
  return m ? { rawId: m.rawId } : null;
}

/** Every credential in the shared store (wallet- and tools-registered alike). */
export async function listWalletCredentials(): Promise<{ username: string; rawId: string }[]> {
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

/** Forgets the credential record (case-insensitive). The passkey itself
    survives on the authenticator — a resident-key login re-learns it. */
export async function deleteWalletCredential(username: string): Promise<void> {
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
