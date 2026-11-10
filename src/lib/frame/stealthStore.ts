// Rail-owned store for STEALTH (privacy=true) accounts on the Hegota rail.
//
// Each stealth account comes from an ML-KEM ticket {ct, viewTag}: the account is a function of
// (passkey PRF, ticket, the ticket's scheme), and the ticket is NOT recoverable from the passkey (it holds
// fresh randomness). So a ticket is the ONLY copy of what spends its address: tickets are never
// deleted here, "forget" only hides them. The store lives on this device only; clearing storage
// or changing device loses those funds unless the ticket was backed up. Entirely rail-owned and
// removable. Reads never throw. Writes that could lose a ticket (addTicket)
// THROW instead of failing silently, and NO write ever replaces stored data it could not parse: an
// unparseable value (corrupt JSON, or JSON that is not an array) is first copied verbatim to
// `<key>.corrupt.<timestamp>`, and the write is refused if that copy cannot be made. Those backups
// are never deleted here; corruptTicketBackups() lists them so the UI can warn.

type Addr = `0x${string}`;

// ---------------------------------------------------------------------------------------------
// v1: stealth tickets (leanSphincs-s or ML-DSA-44)
// ---------------------------------------------------------------------------------------------

/** The account class a ticket's address was derived for. A spend routes by THIS, not by the user's
    current selection, so switching schemes never strands a ticket. */
export type TicketScheme = "leanSphincs-s" | "ML-DSA-44";

export interface LssStealthTicket {
  v: 1;
  scheme: TicketScheme;
  stealthAddress: Addr;
  ct: Addr;
  viewTag: Addr;
  createdAt: number;
  hidden?: boolean;
}

const ticketsKey = (user: string): string => `r1do/frame/lss-stealth/${user}/tickets`;

/** What a key holds: nothing, a parsed array, or a raw value that is NOT a JSON array (kept as-is). */
type Stored = { kind: "empty" } | { kind: "list"; list: unknown[] } | { kind: "corrupt"; raw: string } | { kind: "unavailable" };

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // access itself can throw (blocked site data)
  }
}

function readStored(key: string): Stored {
  const ls = storage();
  if (!ls) return { kind: "unavailable" };
  let raw: string | null;
  try {
    raw = ls.getItem(key);
  } catch {
    return { kind: "unavailable" };
  }
  if (raw === null || raw === "") return { kind: "empty" };
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? { kind: "list", list: v } : { kind: "corrupt", raw };
  } catch {
    return { kind: "corrupt", raw };
  }
}

const backupPrefix = (key: string): string => `${key}.corrupt.`;

/** Copy an unparseable value verbatim to `<key>.corrupt.<timestamp>` before anything overwrites it.
    Throws if the copy cannot be written (the caller must then not overwrite the original). */
function backupCorrupt(ls: Storage, key: string, raw: string): string {
  let at = Date.now();
  while (ls.getItem(`${backupPrefix(key)}${at}`) !== null) at++; // never clobber an older backup
  const bkey = `${backupPrefix(key)}${at}`;
  ls.setItem(bkey, raw);
  if (ls.getItem(bkey) !== raw) throw new Error("backup did not read back");
  return bkey;
}

/** Strict write for data that must not be lost: throws on any storage failure. If `key` holds
    unparseable data it is backed up first (never silently replaced). */
function writeListStrict(key: string, list: unknown[]): void {
  const ls = storage();
  if (!ls) throw new Error("browser storage is unavailable; nothing was stored");
  const cur = readStored(key);
  if (cur.kind === "corrupt") {
    try {
      backupCorrupt(ls, key, cur.raw);
    } catch (e) {
      throw new Error(`stored tickets are unreadable and could not be backed up, refusing to overwrite them (${e instanceof Error ? e.message : String(e)})`);
    }
  }
  const json = JSON.stringify(list);
  try {
    ls.setItem(key, json);
  } catch (e) {
    throw new Error(`could not write the ticket store (${e instanceof Error ? e.message : String(e)}); nothing was changed`);
  }
}

const isHex = (x: unknown): x is Addr => typeof x === "string" && x.startsWith("0x");

const schemeOf = (x: unknown): TicketScheme | null =>
  x === "leanSphincs-s" || x === "ML-DSA-44" ? x : null;

/** This user's stealth tickets of both schemes (empty if none / storage unavailable), each with
    its scheme normalised. Malformed entries (or an unknown scheme) are skipped on read but never
    rewritten away. */
/** The address of a raw stored entry, lowercased, or null if the entry is malformed. */
const addrOf = (x: unknown): string | null => {
  const a = (x as { stealthAddress?: unknown } | null)?.stealthAddress;
  return isHex(a) ? a.toLowerCase() : null;
};

export function getTickets(user: string): LssStealthTicket[] {
  const st = readStored(ticketsKey(user));
  if (st.kind !== "list") return [];
  const out: LssStealthTicket[] = [];
  for (const x of st.list) {
    const t = x as Partial<LssStealthTicket> | null;
    const scheme = schemeOf((t as { scheme?: unknown } | null)?.scheme);
    if (t?.v === 1 && scheme && isHex(t.stealthAddress) && isHex(t.ct) && isHex(t.viewTag)) out.push({ ...(t as LssStealthTicket), scheme });
  }
  return out;
}

// Cross-tab write serialization. A ticket write is read-modify-write on one localStorage key, so
// two tabs writing at once could each write a list without the other's new ticket. Writes take the
// Web Lock named after the store key (same origin, all tabs); the lock name is the key itself.
// Where navigator.locks is missing, writes fall back to "read immediately before writing, then
// verify after writing that every ticket seen so far is still there, else merge it back and
// rewrite", for at most MERGE_ROUNDS rounds. Without a lock the verify waits SETTLE_MS first, so
// another tab that read before our write and writes right after it is caught (the window of a
// synchronous localStorage read-modify-write is far shorter). Best effort, not a guarantee: that is
// what the lock is for. Tickets are never deleted from this store (forget only hides), so merging
// back by address can only restore, never resurrect something removed on purpose.
const MERGE_ROUNDS = 5;
const SETTLE_MS = 60;

type LockManagerLike = { request: <T>(name: string, cb: () => Promise<T>) => Promise<T> };

function lockManager(): LockManagerLike | null {
  try {
    const l = (globalThis.navigator as { locks?: Partial<LockManagerLike> } | undefined)?.locks;
    return l && typeof l.request === "function" ? (l as LockManagerLike) : null;
  } catch {
    return null;
  }
}

/** Run `fn` holding the cross-tab lock for `key`; `locked` tells it whether a lock is really held. */
async function withTicketsLock<T>(key: string, fn: (locked: boolean) => Promise<T>): Promise<T> {
  const lm = lockManager();
  return lm ? lm.request(key, () => fn(true)) : fn(false);
}

const pause = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));

/** Apply `edit` to the stored list and make every ticket seen along the way end up stored. Each
    round re-reads right before writing (merging back any seen entry another writer dropped), then
    re-reads after writing (after SETTLE_MS when no lock is held); done once no seen ticket is
    missing. Throws on a storage failure (see writeListStrict) or if it does not converge within
    MERGE_ROUNDS. */
async function writeTicketsMerged(key: string, locked: boolean, edit: (list: unknown[]) => unknown[]): Promise<void> {
  const seen = new Map<string, unknown>(); // address -> entry, every well-formed entry observed
  const remember = (list: unknown[]) => {
    for (const x of list) {
      const a = addrOf(x);
      if (a && !seen.has(a)) seen.set(a, x);
    }
  };
  for (let round = 0; round < MERGE_ROUNDS; round++) {
    if (round > 0) await pause(20 + Math.floor(Math.random() * 60)); // let the other writer finish
    const st = readStored(key);
    if (st.kind === "unavailable") throw new Error("browser storage is unavailable; nothing was stored");
    const cur = st.kind === "list" ? st.list : [];
    remember(cur);
    const present = new Set(cur.map(addrOf));
    const restored = [...seen].filter(([a]) => !present.has(a)).map(([, x]) => x);
    const next = edit([...cur, ...restored]);
    remember(next);
    writeListStrict(key, next);
    if (!locked) await pause(SETTLE_MS);
    const after = readStored(key);
    if (after.kind !== "list") continue; // replaced by something unparseable: next round backs it up
    const stored = new Set(after.list.map(addrOf));
    if ([...seen.keys()].every((a) => stored.has(a))) return;
  }
  throw new Error("the ticket store kept changing under concurrent writes (another tab?); try again");
}

/** Insert a ticket (dedupe by address: an existing entry keeps its createdAt and hidden). Writes
    on top of the raw stored array so nothing already stored is ever dropped (malformed entries
    included); unparseable stored data is backed up first. Serialized across tabs (see above).
    THROWS if the ticket is not durably stored (read back after the write): the caller must then not
    hand out the address. */
export async function addTicket(user: string, t: LssStealthTicket): Promise<void> {
  const key = ticketsKey(user);
  if (readStored(key).kind === "unavailable") throw new Error("browser storage is unavailable; the ticket was not stored, do not fund this address");
  const addr = t.stealthAddress.toLowerCase();
  await withTicketsLock(key, (locked) =>
    writeTicketsMerged(key, locked, (all) => {
      const prev = all.find((x) => addrOf(x) === addr) as Partial<LssStealthTicket> | undefined;
      const merged: LssStealthTicket = { ...t, createdAt: prev?.createdAt ?? t.createdAt, hidden: prev?.hidden ?? t.hidden };
      return [...all.filter((x) => x !== prev), merged];
    }),
  );
  if (!getTickets(user).some((x) => x.stealthAddress.toLowerCase() === addr && x.ct.toLowerCase() === t.ct.toLowerCase())) {
    throw new Error("the ticket did not read back from storage; do not fund this address");
  }
}

/** "Forget" = hide from the list; the ticket itself is kept. Best-effort (a hide flag is cosmetic):
    it never writes over unparseable data and swallows storage errors. Serialized like addTicket, so
    rewriting the list can never drop a ticket another tab is adding. */
export async function setTicketHidden(user: string, stealthAddress: Addr, hidden: boolean): Promise<void> {
  const key = ticketsKey(user);
  if (readStored(key).kind !== "list") return;
  const addr = stealthAddress.toLowerCase();
  try {
    await withTicketsLock(key, async (locked) => {
      if (readStored(key).kind !== "list") return; // never write over unparseable data here
      await writeTicketsMerged(key, locked, (all) => all.map((x) => (addrOf(x) === addr ? { ...(x as object), hidden } : x)));
    });
  } catch {
    // Storage unavailable: the flag lasts only for this view.
  }
}

/** Keys of unparseable ticket data this store set aside for `user`, oldest first. Never deleted here: they may hold the only copy of a ticket. */
export function corruptTicketBackups(user: string): string[] {
  const ls = storage();
  if (!ls) return [];
  const prefix = backupPrefix(ticketsKey(user));
  const out: string[] = [];
  try {
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && k.startsWith(prefix)) out.push(k);
    }
  } catch {
    return out;
  }
  return out.sort();
}

/** True if the ticket key currently holds data that does not parse as a list (not yet backed up). */
export function ticketStoreUnreadable(user: string): boolean {
  return readStored(ticketsKey(user)).kind === "corrupt";
}
