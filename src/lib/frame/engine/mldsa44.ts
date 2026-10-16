// ML-DSA-44 (Dilithium2) public-key expansion for the ZKNOX_dilithium inline verifier.
// Ported from @noble-validated FIPS-204 primitives (skas mldsa65.ts) with K=L=4.
// Produces the on-chain PubKey = (aHat in NTT domain, tr = H(pk), t1 scaled<<D in NTT),
// each polynomial compacted to 32 uint256 words (8 coeffs/word, 32-bit lanes), exactly
// as ETHDILITHIUM's compact_256(32). All XOFs are SHAKE (NIST standard), so a signature
// produced by @noble/post-quantum ml_dsa44 verifies against it.
import { shake128, shake256 } from '@noble/hashes/sha3';

export const Q = 8380417;
export const N = 256;
export const D = 13;
export const K = 4;
export const L = 4;
export const T1_BITS = 10;
export type Poly = number[];

const ROOT = 1753;
function modpow(b: number, e: number, m: number): number { let r = 1; b %= m; while (e > 0) { if (e & 1) r = (r * b) % m; b = (b * b) % m; e >>= 1; } return r; }
function bitrev8(x: number): number { let r = 0; for (let i = 0; i < 8; i++) r = (r << 1) | ((x >> i) & 1); return r; }
const ZETAS: number[] = []; for (let i = 0; i < 256; i++) ZETAS.push(modpow(ROOT, bitrev8(i), Q));

export function ntt(a: Poly): Poly {
  let k = 0;
  for (let len = 128; len > 0; len >>= 1) {
    for (let start = 0; start < N; start += 2 * len) {
      const zeta = ZETAS[++k]!;
      for (let j = start; j < start + len; j++) {
        const t = (zeta * a[j + len]!) % Q;
        a[j + len] = (a[j]! - t + Q) % Q;
        a[j] = (a[j]! + t) % Q;
      }
    }
  }
  return a;
}

// A[r][s] = RejNTTPoly(SHAKE128(rho || s || r)), already in NTT domain.
export function expandA(rho: Uint8Array): Poly[][] {
  const A: Poly[][] = [];
  for (let r = 0; r < K; r++) {
    const row: Poly[] = [];
    for (let s = 0; s < L; s++) {
      const xof = shake128.create({}).update(rho).update(Uint8Array.of(s, r));
      const poly: Poly = new Array<number>(N);
      let filled = 0;
      while (filled < N) {
        const buf = xof.xof(3 * (N - filled));
        for (let i = 0; i + 2 < buf.length && filled < N; i += 3) {
          const z = buf[i]! | (buf[i + 1]! << 8) | ((buf[i + 2]! & 0x7f) << 16);
          if (z < Q) poly[filled++] = z;
        }
      }
      row.push(poly);
    }
    A.push(row);
  }
  return A;
}

export function bitUnpack(data: Uint8Array, bits: number, count: number): number[] {
  const out = new Array<number>(count);
  const mask = (1 << bits) - 1;
  let acc = 0, accBits = 0, pos = 0;
  for (let i = 0; i < count; i++) {
    while (accBits < bits) { acc |= data[pos++]! << accBits; accBits += 8; }
    out[i] = acc & mask; acc >>>= bits; accBits -= bits;
  }
  return out;
}

// compact_256(32): 256 coeffs -> 32 uint256, 8 coeffs per word in 32-bit little-endian lanes.
export function compact256(poly: Poly): bigint[] {
  const b = new Array<bigint>(32).fill(0n);
  for (let i = 0; i < N; i++) b[(i * 32) >> 8] |= BigInt(poly[i]!) << BigInt((i % 8) * 32);
  return b;
}

// From a standard FIPS-204 ML-DSA-44 packed pk (rho||t1), build the contract PubKey parts.
export function expandPk(pk: Uint8Array): { aHat: bigint[][][]; tr: Uint8Array; t1: bigint[][] } {
  const rho = pk.slice(0, 32);
  const tr = shake256(pk, { dkLen: 64 });
  const A = expandA(rho);
  const aHat = A.map((row) => row.map(compact256));
  // The SHAKE ZKNOX_dilithium expects t1 RAW (just unpacked from pk, compacted); it does
  // the (1<<D) scaling and NTT on-chain. (The keccak ETHDilithium path pre-scales it; we
  // must NOT, or verify fails.)
  const t1: bigint[][] = [];
  const perPoly = (N * T1_BITS) / 8; // 320 bytes
  for (let r = 0; r < K; r++) {
    const packed = pk.slice(32 + r * perPoly, 32 + (r + 1) * perPoly);
    t1.push(compact256(bitUnpack(packed, T1_BITS, N)));
  }
  return { aHat, tr, t1 };
}
