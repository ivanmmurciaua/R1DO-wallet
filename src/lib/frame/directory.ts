// Rail-owned pay-by-nick directory snapshot (FASE 2.3, off-chain resolve).
//
// The wallet RESOLVES @nick -> meta-address against a directory whose merkle root an
// operator publishes to the 0x8272 recent-root predeploy (EIP-8272). This module holds the
// STABLE half of that directory: its entries (nick -> meta), its source_id namespace, and
// its resolver address. The ephemeral half (which slot the current root was published at)
// is discovered on-chain at resolve time, so nothing here goes stale on a republish.
//
// Publishing / operating the directory is NOT done in the wallet (operator concern, for
// now): see r_hegota-testbed/engine-ts/test/publish_directory.ts. Entirely rail-owned and
// removable: the base wallet imports none of this.
//
// NOTE: this is a DEMO directory to light up recent-roots. The meta values are stand-ins
// (keccak of a tag), not real recipients; resolution authenticity is the point.
import { keccak256, toHex, type Hex } from "viem";
import { nickBytes, leafHash, merkleRootAndProof } from "@/lib/frame/engine/directory";

/** The directory's recent-root namespace at 0x8272: keccak(operator[20] || salt).
    Stable while the operator and salt are fixed (only the publish slot moves). */
export const DIRECTORY_SRC: Hex = "0x2f4465231e4089246e931372dab303efcf6228f468d9b57d6449f7ed0455761e";

/** The demo directory, in publish order (leaf index = position). nick -> meta-address. */
const DEMO_NAMES = ["alice", "bob", "carol", "dave"] as const;
const metaFor = (n: string): Hex => keccak256(toHex(`${n}-meta-address`));

export interface DirectoryEntry {
  name: string;
  nick: Hex;   // 32-byte right-padded utf8
  meta: Hex;   // 32-byte meta-address
}

export const DIRECTORY_ENTRIES: DirectoryEntry[] = DEMO_NAMES.map((name) => ({
  name,
  nick: nickBytes(name),
  meta: metaFor(name),
}));

const LEAVES: Hex[] = DIRECTORY_ENTRIES.map((e) => leafHash(e.nick, e.meta));

/** The directory's merkle root (derived from the entries, so it never drifts from them). */
export const DIRECTORY_ROOT: Hex = merkleRootAndProof(LEAVES, 0).root;

export interface NickLookup {
  name: string;
  nick: Hex;
  meta: Hex;
  proof: Hex[];
  /** A display/payout address derived from the meta (last 20 bytes), for the transparent rail. */
  address: Hex;
}

/** Find a nick in the directory and build its merkle proof, or null if not a member.
    Accepts a leading '@' and is case-insensitive. */
export function lookupNick(name: string): NickLookup | null {
  const clean = name.trim().replace(/^@/, "").toLowerCase();
  const idx = DIRECTORY_ENTRIES.findIndex((e) => e.name === clean);
  if (idx < 0) return null;
  const e = DIRECTORY_ENTRIES[idx]!;
  const { proof } = merkleRootAndProof(LEAVES, idx);
  return { name: e.name, nick: e.nick, meta: e.meta, proof, address: ("0x" + e.meta.slice(26)) as Hex };
}
