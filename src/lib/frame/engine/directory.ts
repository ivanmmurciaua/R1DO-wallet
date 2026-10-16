// EIP-8272 recent roots + native pay-by-nick directory (FASE 2.3 vendored subset).
//
// Faithful copy of the standalone engine's directory.ts, adapted to delta1's toolchain
// (extensionless imports). Byte-exact with the Python reference (poc_r.py / poc_d.py /
// DirectoryResolver.sol) and validated live on hegota by the engine's spike_paybynick.
//
// The wallet uses this READ-ONLY (off-chain resolve): to turn @nick into a meta-address
// it builds a sorted-pair merkle proof and asks the DirectoryResolver (view eth_call) to
// authenticate the directory's recent root at 0x8272 and check membership, storage-free.
// Publishing / operating the directory is NOT done here (operator concern, for now).
import { keccak256, encodeAbiParameters, toHex, concat, padHex, slice, type Hex } from "viem";

/** The RECENT_ROOT predeploy (EIP-8272). */
export const RECENT_ROOT = "0x0000000000000000000000000000000000008272" as Hex;
/** Slot ring size: a reference is valid while current_slot - slot <= RING - 1. */
export const RING = 8192n;

const ENTRY_DOMAIN = keccak256(toHex("RECENT_ROOT_ENTRY"));
const STORAGE_DOMAIN = keccak256(toHex("RECENT_ROOT_STORAGE"));

function u64be(n: bigint | number): Hex {
  return toHex(BigInt(n), { size: 8 });
}
const kconcat = (parts: Hex[]): Hex => keccak256(concat(parts));

/** source_id = keccak(caller[20] || salt[32]): a directory's namespace at 0x8272. */
export function sourceId(caller: Hex, salt: Hex): Hex {
  return kconcat([caller.toLowerCase() as Hex, salt]);
}

/** entry_hash = keccak(ENTRY_DOMAIN || source_id || u64_be(slot) || root). */
export function entryHash(src: Hex, slot: bigint | number, root: Hex): Hex {
  return kconcat([ENTRY_DOMAIN, src, u64be(slot), root]);
}

/** storage_key = keccak(STORAGE_DOMAIN || source_id || u64_be(slot % RING)). */
export function storageKey(src: Hex, slot: bigint | number): Hex {
  return kconcat([STORAGE_DOMAIN, src, u64be(BigInt(slot) % RING)]);
}

/** The 72-byte reference tuple: source_id(32) || u64_be(slot)(8) || root(32). */
export function recentRootTuple(src: Hex, slot: bigint | number, root: Hex): Hex {
  return concat([src, u64be(slot), root]);
}

/** Calldata for the legacy WRITE of a root to 0x8272: salt(32) || root(32). */
export function writeRootCalldata(salt: Hex, root: Hex): Hex {
  return concat([salt, root]);
}

// ---- merkle (sorted-pair keccak, matches DirectoryResolver.sol + poc_d.py) --------

/** A directory leaf: keccak(nick(32) || metaAddr(32)). */
export function leafHash(nick: Hex, meta: Hex): Hex {
  return kconcat([nick, meta]);
}

/** A nick as a 32-byte field: UTF-8 bytes, right-padded with zeros (ljust). */
export function nickBytes(name: string): Hex {
  return padHex(toHex(name), { size: 32, dir: "right" });
}

function parent(a: Hex, b: Hex): Hex {
  return a.toLowerCase() <= b.toLowerCase() ? kconcat([a, b]) : kconcat([b, a]);
}

/** Root + proof for the leaf at `idx` (OZ-style: an odd trailing node is promoted). */
export function merkleRootAndProof(leaves: Hex[], idx: number): { root: Hex; proof: Hex[] } {
  const proof: Hex[] = [];
  let level = [...leaves];
  let i = idx;
  while (level.length > 1) {
    const next: Hex[] = [];
    for (let j = 0; j < level.length; j += 2) {
      if (j + 1 < level.length) next.push(parent(level[j]!, level[j + 1]!));
      else next.push(level[j]!);
    }
    if ((i ^ 1) < level.length) proof.push(level[i ^ 1]!);
    i = Math.floor(i / 2);
    level = next;
  }
  return { root: level[0]!, proof };
}

/** Verify a sorted-pair merkle proof (mirror of DirectoryResolver.resolve step 2). */
export function merkleVerify(leaf: Hex, proof: Hex[], root: Hex): boolean {
  let h = leaf;
  for (const p of proof) h = parent(h, p);
  return h.toLowerCase() === root.toLowerCase();
}

// ---- resolver (DirectoryResolver.resolve) -----------------------------------------

/** 4-byte selector of resolve(bytes32,uint64,bytes32,bytes32,bytes32,bytes32[]). */
export const RESOLVE_SELECTOR: Hex = slice(
  keccak256(toHex("resolve(bytes32,uint64,bytes32,bytes32,bytes32,bytes32[])")), 0, 4,
);

/** Calldata for DirectoryResolver.resolve: selector || abi(src, slot, root, nick, meta, proof). */
export function resolveCalldata(
  src: Hex, slot: bigint | number, root: Hex, nick: Hex, meta: Hex, proof: Hex[],
): Hex {
  const args = encodeAbiParameters(
    [
      { type: "bytes32" }, { type: "uint64" }, { type: "bytes32" },
      { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32[]" },
    ],
    [src, BigInt(slot), root, nick, meta, proof],
  );
  return concat([RESOLVE_SELECTOR, args]);
}
