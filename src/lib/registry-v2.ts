/* ════════════════════════════════════════════════════════════════════
   registry-v2.ts — Argon2id-gated encrypted username directory (client)

   Replaces the legacy plaintext PasskeyRegistry. The chain stores only
   `fp → nonce ‖ XChaCha20-Poly1305(padded payload)`:

     u       = NFKC(lowercase(trim(username)))
     salt    = keccak256(utf8(u ‖ "|r1do/salt/v2"))[0..16]   (deterministic)
     k       = Argon2id(u [‖ 0x00 ‖ pin], salt, m=64MiB, t=3, p=1) → 32B
     fp      = keccak256(k ‖ "r1do/fp/v2")                   (mapping key)
     encKey  = HKDF-SHA256(k, info="r1do/enc/v2")            (AEAD key)
     payload = version ‖ rawIdLen ‖ rawId ‖ safeAddress ‖ hasMeta ‖ meta
               ‖ hasZk ‖ zkLen ‖ zk(0zk bech32)   (v3 adds the 0zk tail)
               padded to PAYLOAD_SIZE so every entry is the same length.

   Three pay-by-name rails resolve from one entry: public (safeAddress),
   stealth Δ (metaAddress), and RAILGUN shielded (zkAddress) — all optional
   except safeAddress.

   What this buys: nothing quantum-harvestable at rest (symmetric only),
   and mass username enumeration costs ~1 s × 64 MiB per guess instead of
   a free keccak. What it does NOT do: hide an entry from someone who
   already knows the username (directed lookup IS the feature), or
   protect funds (that's the PRF-derived owner key + future PQ sigs).
   ════════════════════════════════════════════════════════════════════ */

import { keccak256, concat, toHex, hexToBytes, stringToBytes, bytesToString, getAddress } from "viem";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { argon2id } from "hash-wasm";
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { directoryAddress } from "./networks";
import type { SafeWallet } from "./aa-client";

export const ARGON2_MEMORY_KIB = 65536; // 64 MiB
export const ARGON2_ITERATIONS = 3;
export const ARGON2_PARALLELISM = 1;

// Fixed plaintext size. v3 layout (all fields fixed-width so every entry is
// indistinguishable):
//   version(1) ‖ rawIdLen(2) ‖ rawId(64) ‖ safe(20) ‖ hasMeta(1) ‖ meta(1251)
//   ‖ hasZk(1) ‖ zkLen(2) ‖ zk(160)
// The directory contract is opaque (stores the AEAD blob as-is), so adding the
// 0zk needs NO contract change — only this codec + a bigger PAYLOAD_SIZE.
// The directory isn't deployed yet, so the size bump enters clean (no migration).
const VERSION = 0x03;
const RAWID_MAX = 64;
const META_SIZE = 1251;
const ZK_MAX = 160; // 0zk bech32 string (~127 chars) + margin
const NONCE_SIZE = 24;

const OFF_RAWID = 3;
const OFF_SAFE = OFF_RAWID + RAWID_MAX; // 67
const OFF_HASMETA = OFF_SAFE + 20; // 87
const OFF_META = OFF_HASMETA + 1; // 88
const OFF_HASZK = OFF_META + META_SIZE; // 1339
const OFF_ZKLEN = OFF_HASZK + 1; // 1340
const OFF_ZK = OFF_ZKLEN + 2; // 1342
export const PAYLOAD_SIZE = OFF_ZK + ZK_MAX; // 1502

export type DirectoryEntry = {
  rawId: string; // hex (no 0x), as used by loadFromDevice
  safeAddress: `0x${string}`;
  metaAddress: `0x${string}` | null; // PQ meta-address → private pay-by-name (stealth Δ)
  zkAddress?: string | null; // 0zk bech32 → Railgun shielded pay-by-name (v3)
};

export type DirectoryKeys = {
  fp: `0x${string}`; // bytes32 mapping key
  encKey: Uint8Array; // 32B AEAD key — never leaves the client
};

export function normalizeUsername(username: string): string {
  return username.trim().toLowerCase().normalize("NFKC");
}

/** The expensive step (~1 s, 64 MiB): one Argon2id evaluation. */
export async function deriveDirectoryKeys(
  username: string,
  pin?: string,
): Promise<DirectoryKeys> {
  const u = normalizeUsername(username);
  const password = pin ? `${u}\u0000${pin}` : u;

  // Deterministic per-user salt — domain separation without a
  // chicken-and-egg lookup (salt secrecy is not required).
  const salt = hexToBytes(keccak256(stringToBytes(`${u}|r1do/salt/v2`))).slice(0, 16);

  const k = await argon2id({
    password,
    salt,
    parallelism: ARGON2_PARALLELISM,
    iterations: ARGON2_ITERATIONS,
    memorySize: ARGON2_MEMORY_KIB,
    hashLength: 32,
    outputType: "binary",
  });

  const fp = keccak256(concat([k, stringToBytes("r1do/fp/v2")]));
  const encKey = hkdf(sha256, k, undefined, "r1do/enc/v2", 32);
  k.fill(0);

  return { fp, encKey };
}

export function encodeDirectoryPayload(entry: DirectoryEntry): Uint8Array {
  const rawIdBytes = hexToBytes(`0x${entry.rawId.replace(/^0x/, "")}`);
  if (rawIdBytes.length === 0 || rawIdBytes.length > RAWID_MAX) {
    throw new Error(`rawId must be 1..${RAWID_MAX} bytes`);
  }

  const out = new Uint8Array(PAYLOAD_SIZE); // zero-padded
  out[0] = VERSION;
  out[1] = (rawIdBytes.length >> 8) & 0xff;
  out[2] = rawIdBytes.length & 0xff;
  out.set(rawIdBytes, OFF_RAWID); // fixed-width field
  out.set(hexToBytes(entry.safeAddress), OFF_SAFE);
  if (entry.metaAddress) {
    out[OFF_HASMETA] = 0x01;
    out.set(hexToBytes(entry.metaAddress), OFF_META);
  }
  if (entry.zkAddress) {
    const zkBytes = stringToBytes(entry.zkAddress);
    if (zkBytes.length > ZK_MAX) {
      throw new Error(`0zk address too long (${zkBytes.length} > ${ZK_MAX})`);
    }
    out[OFF_HASZK] = 0x01;
    out[OFF_ZKLEN] = (zkBytes.length >> 8) & 0xff;
    out[OFF_ZKLEN + 1] = zkBytes.length & 0xff;
    out.set(zkBytes, OFF_ZK);
  }
  return out;
}

export function decodeDirectoryPayload(pt: Uint8Array): DirectoryEntry {
  const version = pt[0];
  // v2 = pre-0zk (no zk tail); v3 = with the optional 0zk field.
  if (version !== 0x02 && version !== 0x03) {
    throw new Error("Unknown directory payload version");
  }
  const rawIdLen = (pt[1] << 8) | pt[2];
  const rawId = toHex(pt.slice(OFF_RAWID, OFF_RAWID + rawIdLen)).slice(2);
  const safeAddress = getAddress(toHex(pt.slice(OFF_SAFE, OFF_SAFE + 20))) as `0x${string}`;
  const hasMeta = pt[OFF_HASMETA] === 0x01;
  const metaAddress = hasMeta
    ? (toHex(pt.slice(OFF_META, OFF_META + META_SIZE)) as `0x${string}`)
    : null;

  let zkAddress: string | null = null;
  if (version >= 0x03 && pt[OFF_HASZK] === 0x01) {
    const zkLen = (pt[OFF_ZKLEN] << 8) | pt[OFF_ZKLEN + 1];
    zkAddress = bytesToString(pt.slice(OFF_ZK, OFF_ZK + zkLen));
  }
  return { rawId, safeAddress, metaAddress, zkAddress };
}

/** payload → on-chain blob: nonce(24) ‖ XChaCha20-Poly1305 ciphertext. */
export function sealDirectoryEntry(
  encKey: Uint8Array,
  payload: Uint8Array,
): `0x${string}` {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_SIZE));
  const ct = xchacha20poly1305(encKey, nonce).encrypt(payload);
  return toHex(concat([nonce, ct]));
}

export function openDirectoryEntry(
  encKey: Uint8Array,
  blob: `0x${string}`,
): DirectoryEntry | null {
  try {
    const bytes = hexToBytes(blob);
    const nonce = bytes.slice(0, NONCE_SIZE);
    const ct = bytes.slice(NONCE_SIZE);
    const pt = xchacha20poly1305(encKey, nonce).decrypt(ct);
    return decodeDirectoryPayload(pt);
  } catch {
    return null; // wrong key (different username/pin) or corrupted entry
  }
}

/* ───────────────────────── on-chain access ───────────────────────── */

export const DIRECTORY_ABI = [
  {
    inputs: [{ name: "fp", type: "bytes32" }],
    name: "getEntry",
    outputs: [{ name: "", type: "bytes" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "fp", type: "bytes32" }],
    name: "hasEntry",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { name: "fp", type: "bytes32" },
      { name: "blob", type: "bytes" },
    ],
    name: "setEntry",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

/** Whether the (single, global) directory is configured. Always true in practice —
    the directory network is pinned in the registry — but kept as the opt-in guard
    the UI reads. */
export function directoryEnabled(): boolean {
  return !!directoryAddress();
}

/** Resolve a username: Argon2id → read blob → decrypt. Null if no entry. Reads the
    ONE global directory (on the directory network) via `directoryClient`, NOT the
    active chain. The caller pays the ~1 s Argon2id once. */
export async function readDirectory(
  username: string,
  pin?: string,
): Promise<DirectoryEntry | null> {
  const dir = directoryAddress();
  const { directoryClient } = await import("@/lib/client");

  const { fp, encKey } = await deriveDirectoryKeys(username, pin);
  const blob = (await directoryClient.readContract({
    address: dir,
    abi: DIRECTORY_ABI,
    functionName: "getEntry",
    args: [fp],
  })) as `0x${string}`;

  if (!blob || blob === "0x") return null;
  const entry = openDirectoryEntry(encKey, blob);
  encKey.fill(0);
  return entry;
}

/** Cheap existence check for an already-derived fingerprint (no Argon2id). */
export async function hasDirectoryEntry(fp: `0x${string}`): Promise<boolean> {
  const dir = directoryAddress();
  const { directoryClient } = await import("@/lib/client");
  return (await directoryClient.readContract({
    address: dir,
    abi: DIRECTORY_ABI,
    functionName: "hasEntry",
    args: [fp],
  })) as boolean;
}

/** Resolve a username → its registered 0zk (Railgun rail), or null. Does the
    Argon2id (~1s). Doubles as the brick for "pay someone by nick via RAILGUN". */
export async function resolvePoolAddress(
  username: string,
  pin?: string,
): Promise<string | null> {
  const entry = await readDirectory(username, pin);
  return entry?.zkAddress ?? null;
}

/** Read + decrypt this user's own entry by an already-derived fp (no Argon2id). */
async function readOwnEntry(
  fp: `0x${string}`,
  encKey: Uint8Array,
): Promise<DirectoryEntry | null> {
  const dir = directoryAddress();
  const { directoryClient } = await import("@/lib/client");
  const blob = (await directoryClient.readContract({
    address: dir,
    abi: DIRECTORY_ABI,
    functionName: "getEntry",
    args: [fp],
  })) as `0x${string}`;
  if (!blob || blob === "0x") return null;
  return openDirectoryEntry(encKey, blob);
}

/**
 * Add (or refresh) the user's 0zk in their directory entry — the RAILGUN
 * pay-by-name rail. Reads the current entry, and if it lacks this 0zk,
 * re-seals the payload (v3) with `zkAddress` and rewrites the slot via the
 * user's Safe (the slot's writer). Idempotent and best-effort: it never
 * blocks using the pool (the 0zk works without it; this is only so OTHERS
 * can pay you by nick). Returns what happened.
 */
export async function ensureZkInDirectory(
  wallet: SafeWallet,
  username: string,
  zkAddress: string,
): Promise<"published" | "already" | "skipped"> {
  if (!directoryEnabled()) return "skipped";
  const { fp, encKey } = await deriveDirectoryKeys(username);
  try {
    const current = await readOwnEntry(fp, encKey);
    // Opt-in model: NEVER create the directory entry here. Becoming findable is
    // a deliberate action (makeFindable). Entering the private world must not be
    // a backdoor auto-publish — so if there's no entry yet, skip. We only UPDATE
    // an existing entry to add the 0zk rail (the user IS already findable then).
    if (!current) return "skipped";
    if (current.zkAddress === zkAddress) return "already";

    // We're updating an EXISTING entry, so rawId/safeAddress come straight from
    // it. Only add the 0zk rail (and keep the stealth meta, falling back to the
    // local cache if the entry was published without one — e.g. a public wallet).
    const rawId = current.rawId;
    const safeAddress = current.safeAddress;

    let metaAddress = current.metaAddress ?? null;
    if (!metaAddress) {
      const { getMetaAddress } = await import("@/lib/localstorage");
      metaAddress = getMetaAddress(username);
    }

    const blob = sealDirectoryEntry(
      encKey,
      encodeDirectoryPayload({
        rawId,
        safeAddress,
        metaAddress,
        zkAddress,
      }),
    );
    const { setDirectoryEntry } = await import("@/lib/deploy");
    await setDirectoryEntry(wallet, fp, blob);
    return "published";
  } finally {
    encKey.fill(0);
  }
}
