// Rail-owned ticket store for STEALTH (privacy=true) payments on the Hegota rail.
//
// A stealth payment produces an OFF-CHAIN ticket {ct, viewTag} (the ML-KEM ciphertext + view
// tag) that the recipient needs to later recover and spend the funds at the stealth address.
// There is no announcer / courier yet, so the sender-to-self flow parks its own tickets here,
// in localStorage, keyed per user. This module is entirely rail-owned and removable: nothing
// in the base wallet depends on it, and every read/write is guarded so storage never throws.

export interface StealthTicket {
  stealthAddress: `0x${string}`;
  ct: `0x${string}`;
  viewTag: `0x${string}`;
  createdAt: number;
}

const keyFor = (user: string): string => `r1do/frame/stealth/${user}/tickets`;

function load(user: string): StealthTicket[] {
  try {
    const raw = globalThis.localStorage?.getItem(keyFor(user));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as StealthTicket[]) : [];
  } catch {
    return [];
  }
}

function save(user: string, tickets: StealthTicket[]): void {
  try {
    globalThis.localStorage?.setItem(keyFor(user), JSON.stringify(tickets));
  } catch {
    // Storage unavailable (SSR, private mode, quota): the store is best-effort, never throw.
  }
}

/** Append a ticket for `user` (de-duplicated by stealthAddress; newest wins). */
export function addTicket(user: string, t: StealthTicket): void {
  const rest = load(user).filter((x) => x.stealthAddress.toLowerCase() !== t.stealthAddress.toLowerCase());
  save(user, [...rest, t]);
}

/** All tickets stored for `user` (empty array if none / storage unavailable). */
export function getTickets(user: string): StealthTicket[] {
  return load(user);
}

/** Drop the ticket for `stealthAddress` (e.g. after it has been spent). */
export function removeTicket(user: string, stealthAddress: `0x${string}`): void {
  const addr = stealthAddress.toLowerCase();
  save(user, load(user).filter((x) => x.stealthAddress.toLowerCase() !== addr));
}
