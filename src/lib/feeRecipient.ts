/*
  feeRecipient.ts — resolves the operator's fee destination (lib/fees.ts).

  The recipient is NOT a hardcoded address: it's a directory USER, the nick
  `r1do-wallet`, registered as findable and with privacy ON (so it has BOTH
  rails). This way collection reuses the entire pay-by-nick rail and the
  operator's revenue is private (each fee lands in a one-time stealth/0zk output).

  DUAL-RAIL: charged in the world where the op happens, never crossing worlds.
    - LIGHT world  → metaAddress (Δ1 stealth payment)
    - SHADOW world → zkAddress   (Railgun 0zk transfer)

  Cached: the entry is static once registered, so we avoid repeating readDirectory's
  Argon2id (~1s) + on-chain read on every quote.

  PREREQUISITE: `r1do-wallet` must be registered (findable + privacy ON). Until it
  is, getFeeRecipient() returns null and the caller decides (Phase 2: with no
  resolvable recipient, no fee is charged — fail-open, the user's op never breaks
  just because we can't collect).
*/
import { readDirectory } from "./registry-v2";

/** The operator's directory nick. No PIN: app-resolvable so fees can be collected. */
export const FEE_RECIPIENT_NICK = "r1do-wallet";

export type FeeWorld = "light" | "shadow";

export type FeeRecipient = {
  /** LIGHT rail — Δ1 meta-address (stealth pay-by-nick). */
  metaAddress: `0x${string}`;
  /** SHADOW rail — Railgun 0zk (shielded transfer). null if it has no privacy. */
  zkAddress: string | null;
  /** Public rail (for completeness; the normal fee uses meta/0zk). */
  safeAddress: `0x${string}`;
};

let cached: FeeRecipient | null = null;

/**
 * Resolve `r1do-wallet` → its fee destination (cached). Returns null if the nick
 * isn't registered yet or exposes no stealth rail (without metaAddress there's no
 * private way to collect).
 */
export async function getFeeRecipient(): Promise<FeeRecipient | null> {
  if (cached) return cached;

  const entry = await readDirectory(FEE_RECIPIENT_NICK);
  if (!entry || !entry.metaAddress) return null;

  cached = {
    metaAddress: entry.metaAddress,
    zkAddress: entry.zkAddress ?? null,
    safeAddress: entry.safeAddress,
  };
  return cached;
}

/**
 * Collection address for the op's world. Shadow requires zkAddress; if the
 * recipient has no registered 0zk, returns null (the caller can't collect on
 * that rail and decides — don't break the op).
 */
export function feeRecipientRail(r: FeeRecipient, world: FeeWorld): string | null {
  return world === "shadow" ? r.zkAddress : r.metaAddress;
}

/** Invalidate the cache (e.g. after (re)registering the operator's nick). */
export function clearFeeRecipientCache(): void {
  cached = null;
}
