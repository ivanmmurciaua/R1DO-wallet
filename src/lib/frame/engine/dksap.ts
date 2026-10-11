// DKSAP discovery layer (P1.3a): ML-KEM-512 key agreement for stealth-address discovery.
// The recipient publishes an ML-KEM encapsulation key (the "viewing" half of its meta
// address); a sender encapsulates to get a shared secret + ciphertext and a short view
// tag; the recipient decapsulates to recover the same shared secret and scans by view tag.
// The shared secret then drives the blinded-ML-DSA stealth key (P1.3b). ML-KEM-512 is
// FIPS-203 standard (matches pq-dksap's kyber_py ML_KEM_512).
import { ml_kem512 } from '@noble/post-quantum/ml-kem.js';
import { shake256 } from '@noble/hashes/sha3';

export const KEM_EK_BYTES = 800;   // ML-KEM-512 encapsulation key
export const VIEW_TAG_BYTES = 1;
const VIEW_KDF = new TextEncoder().encode('pq-dksap/view/v1');
const VIEW_TAG_KDF = new TextEncoder().encode('pq-dksap/viewtag/v1');

export interface MetaKeys { encapsulationKey: Uint8Array; decapsulationKey: Uint8Array; }

/** Recipient meta keys from a 32-byte seed (deterministic). */
export function genMeta(seed: Uint8Array): MetaKeys {
  const kemSeed = shake256(new Uint8Array([...VIEW_KDF, ...seed]), { dkLen: 64 });
  const { publicKey, secretKey } = ml_kem512.keygen(kemSeed);
  return { encapsulationKey: publicKey, decapsulationKey: secretKey };
}

export function viewTag(ss: Uint8Array): Uint8Array {
  return shake256(new Uint8Array([...VIEW_TAG_KDF, ...ss]), { dkLen: VIEW_TAG_BYTES });
}

export interface Announcement { sharedSecret: Uint8Array; cipherText: Uint8Array; viewTag: Uint8Array; }

/** Sender: encapsulate to the recipient's published encapsulation key. */
export function senderDerive(encapsulationKey: Uint8Array): Announcement {
  const { cipherText, sharedSecret } = ml_kem512.encapsulate(encapsulationKey);
  return { sharedSecret, cipherText, viewTag: viewTag(sharedSecret) };
}

/** Recipient: recover the shared secret from a ciphertext; optionally filter by view tag. */
export function recipientRecover(dk: Uint8Array, cipherText: Uint8Array, tag?: Uint8Array): Uint8Array | null {
  const ss = ml_kem512.decapsulate(cipherText, dk);
  if (tag && !eq(viewTag(ss), tag)) return null;
  return ss;
}

function eq(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!; return d === 0;
}
