// Full ML-DSA-44 (Dilithium2, FIPS-204, SHAKE) in TS: keygen now, sign next. Needed for
// the DKSAP blinded stealth key, which @noble cannot produce (it hides s1/s2/t and uses
// standard bounds). Primitives ported from @noble-validated skas mldsa65.ts, retuned to
// ML-DSA-44 params (eta=2 sampling differs). Correctness oracle: keygen(seed).pk must equal
// @noble ml_dsa44.keygen(seed).publicKey byte-for-byte.
import { shake128, shake256 } from '@noble/hashes/sha3';

export const Q = 8380417, N = 256, D = 13, K = 4, L = 4;
export const ETA = 2, TAU = 39, GAMMA1 = 1 << 17, GAMMA2 = ((Q - 1) / 88) | 0;
export const BETA = TAU * ETA;              // 78
export const OMEGA = 80, T1_BITS = 10;
export type Poly = number[];

const ROOT = 1753;
const mod = (a: number) => ((a % Q) + Q) % Q;
function modpow(b: number, e: number, m: number): number { let r = 1; b %= m; while (e > 0) { if (e & 1) r = (r * b) % m; b = (b * b) % m; e >>= 1; } return r; }
function bitrev8(x: number): number { let r = 0; for (let i = 0; i < 8; i++) r = (r << 1) | ((x >> i) & 1); return r; }
const ZETAS: number[] = []; for (let i = 0; i < 256; i++) ZETAS.push(modpow(ROOT, bitrev8(i), Q));
const INV256 = modpow(256, Q - 2, Q);

export function ntt(a: Poly): Poly {
  let k = 0;
  for (let len = 128; len > 0; len >>= 1)
    for (let start = 0; start < N; start += 2 * len) {
      const zeta = ZETAS[++k]!;
      for (let j = start; j < start + len; j++) { const t = (zeta * a[j + len]!) % Q; a[j + len] = mod(a[j]! - t); a[j] = mod(a[j]! + t); }
    }
  return a;
}
export function invntt(a: Poly): Poly {
  let k = 256;
  for (let len = 1; len < N; len <<= 1)
    for (let start = 0; start < N; start += 2 * len) {
      const zeta = ZETAS[--k]!;
      for (let j = start; j < start + len; j++) { const t = a[j]!; a[j] = mod(t + a[j + len]!); a[j + len] = mod((mod(t - a[j + len]!) * (Q - zeta))); }
    }
  for (let j = 0; j < N; j++) a[j] = (a[j]! * INV256) % Q;
  return a;
}
// multiply (NTT domain) a*b pointwise
export function pointwise(a: Poly, b: Poly): Poly { const r: Poly = new Array(N); for (let i = 0; i < N; i++) r[i] = (a[i]! * b[i]!) % Q; return r; }

export function expandA(rho: Uint8Array): Poly[][] {
  const A: Poly[][] = [];
  for (let r = 0; r < K; r++) { const row: Poly[] = [];
    for (let s = 0; s < L; s++) {
      const xof = shake128.create({}).update(rho).update(Uint8Array.of(s, r));
      const poly: Poly = new Array(N); let f = 0;
      while (f < N) { const buf = xof.xof(3 * (N - f)); for (let i = 0; i + 2 < buf.length && f < N; i += 3) { const z = buf[i]! | (buf[i + 1]! << 8) | ((buf[i + 2]! & 0x7f) << 16); if (z < Q) poly[f++] = z; } }
      row.push(poly);
    } A.push(row); }
  return A;
}

// ExpandS for eta=2: half-byte z<15 -> coeff 2-(z mod 5).
export function expandS(rhoPrime: Uint8Array): { s1: Poly[]; s2: Poly[] } {
  const sample = (nonce: number): Poly => {
    const xof = shake256.create({}).update(rhoPrime).update(Uint8Array.of(nonce & 0xff, nonce >> 8));
    const p: Poly = new Array(N); let f = 0;
    while (f < N) { const buf = xof.xof(N); for (const byte of buf) { for (const z of [byte & 15, byte >> 4]) { if (z < 15 && f < N) p[f++] = mod(ETA - (z % 5)); } if (f === N) break; } }
    return p;
  };
  const s1: Poly[] = [], s2: Poly[] = [];
  for (let j = 0; j < L; j++) s1.push(sample(j));
  for (let j = 0; j < K; j++) s2.push(sample(L + j));
  return { s1, s2 };
}

// Power2Round: returns [t1, t0] with t = t1*2^D + t0, t0 in (-2^12, 2^12].
export function power2round(c: number): [number, number] {
  let r0 = c & ((1 << D) - 1); if (r0 > (1 << (D - 1))) r0 -= (1 << D);
  return [(c - r0) >> D, r0];
}

export function bitPack(values: Poly, bits: number): Uint8Array {
  const out = new Uint8Array(Math.ceil((values.length * bits) / 8)); let acc = 0, ab = 0, pos = 0;
  for (const v of values) { acc |= v << ab; ab += bits; while (ab >= 8) { out[pos++] = acc & 0xff; acc >>>= 8; ab -= 8; } }
  if (ab > 0) out[pos] = acc & 0xff; return out;
}
export function packPk(rho: Uint8Array, t1: Poly[]): Uint8Array {
  const pk = new Uint8Array(32 + (K * N * T1_BITS) / 8); pk.set(rho, 0); let off = 32;
  for (const p of t1) { pk.set(bitPack(p, T1_BITS), off); off += (N * T1_BITS) / 8; } return pk;
}

export interface SecretParts { rho: Uint8Array; rhoPrime: Uint8Array; K: Uint8Array; s1: Poly[]; s2: Poly[]; t: Poly[]; t0: Poly[]; t1: Poly[]; aHat: Poly[][]; }

export function keygen(seed: Uint8Array): { publicKey: Uint8Array; sk: SecretParts } {
  // (rho, rhoPrime, K) = H(seed || k || l, 128)
  const h = shake256(new Uint8Array([...seed, K, L]), { dkLen: 128 });
  const rho = h.slice(0, 32), rhoPrime = h.slice(32, 96), Kk = h.slice(96, 128);
  const aHat = expandA(rho);
  const { s1, s2 } = expandS(rhoPrime);
  const s1Hat = s1.map((p) => ntt(p.slice()));
  const t: Poly[] = [], t0: Poly[] = [], t1: Poly[] = [];
  for (let i = 0; i < K; i++) {
    const acc: Poly = new Array(N).fill(0);
    for (let j = 0; j < L; j++) { const prod = pointwise(aHat[i]![j]!, s1Hat[j]!); for (let n = 0; n < N; n++) acc[n] = (acc[n]! + prod[n]!) % Q; }
    const ti = invntt(acc); for (let n = 0; n < N; n++) ti[n] = mod(ti[n]! + s2[i]![n]!);
    t.push(ti);
    const r1: Poly = new Array(N), r0: Poly = new Array(N);
    for (let n = 0; n < N; n++) { const [a, b] = power2round(ti[n]!); r1[n] = a; r0[n] = b; }
    t1.push(r1); t0.push(r0);
  }
  return { publicKey: packPk(rho, t1), sk: { rho, rhoPrime, K: Kk, s1, s2, t, t0, t1, aHat } };
}

// ---------------------------------------------------------------------------
// Signing (FIPS-204 ML-DSA.Sign_internal), standard. Validated via @noble.verify.
// ---------------------------------------------------------------------------
const centered = (c: number) => (c > Q >> 1 ? c - Q : c);
function infNorm(p: Poly): number { let m = 0; for (const c of p) { const a = Math.abs(centered(c)); if (a > m) m = a; } return m; }

// Decompose r -> [r1, r0], r in [0,Q); r0 centered in (-gamma2, gamma2].
export function decompose(r: number): [number, number] {
  const rp = mod(r);
  let r0 = rp % (2 * GAMMA2); if (r0 > GAMMA2) r0 -= 2 * GAMMA2;
  if (rp - r0 === Q - 1) return [0, r0 - 1];
  return [(rp - r0) / (2 * GAMMA2), r0];
}
const highBits = (r: number) => decompose(r)[0];
const lowBits = (r: number) => decompose(r)[1];
// MakeHint: 1 if adding z flips the high bits of r.
function makeHint(z: number, r: number): number { return highBits(r) !== highBits(mod(r + z)) ? 1 : 0; }

// SampleInBall (tau=39): c with tau nonzero +/-1 coeffs.
export function sampleInBall(ctilde: Uint8Array): Poly {
  const c: Poly = new Array(N).fill(0);
  const xof = shake256.create({}).update(ctilde);
  const buf = xof.xof(8);           // first 8 bytes = sign bits
  let signs = 0n; for (let i = 0; i < 8; i++) signs |= BigInt(buf[i]!) << BigInt(8 * i);
  let bitpos = 0;
  for (let i = N - TAU; i < N; i++) {
    let j: number;
    do { j = xof.xof(1)[0]!; } while (j > i);
    c[i] = c[j]!;
    c[j] = Number((signs >> BigInt(bitpos)) & 1n) ? Q - 1 : 1;
    bitpos++;
  }
  return c;
}

// ExpandMask: L polys with coeffs in (-gamma1, gamma1], from rhoPrime2 || (kappa+r).
function expandMask(rhoPrime2: Uint8Array, kappa: number): Poly[] {
  const GAMMA1_BITS = 18; // gamma1 = 2^17
  const out: Poly[] = [];
  for (let r = 0; r < L; r++) {
    const idx = kappa + r;
    const xof = shake256.create({}).update(rhoPrime2).update(Uint8Array.of(idx & 0xff, idx >> 8));
    const bytes = xof.xof((N * GAMMA1_BITS) / 8);
    const vals = unpackBits(bytes, GAMMA1_BITS, N);
    out.push(vals.map((v) => mod(GAMMA1 - v)));
  }
  return out;
}
function unpackBits(data: Uint8Array, bits: number, count: number): number[] {
  const out = new Array<number>(count); const mask = (1 << bits) - 1; let acc = 0, ab = 0, pos = 0;
  for (let i = 0; i < count; i++) { while (ab < bits) { acc |= data[pos++]! << ab; ab += 8; } out[i] = acc & mask; acc = acc >>> bits; ab -= bits; }
  return out;
}

// w1Encode: SimpleBitPack(w1, (q-1)/(2*gamma2)-1) -> 6 bits/coeff for ML-DSA-44.
const W1_BITS = 6;
function w1Encode(w1: Poly[]): Uint8Array {
  const out = new Uint8Array((K * N * W1_BITS) / 8); let off = 0;
  for (const p of w1) { out.set(bitPack(p, W1_BITS), off); off += (N * W1_BITS) / 8; } return out;
}

// sigEncode: ctilde(32) || z (18 bits, gamma1-coeff) || h (omega+k).
function packZ(z: Poly[]): Uint8Array {
  const out = new Uint8Array((L * N * 18) / 8); let off = 0;
  for (const p of z) { const enc = p.map((c) => GAMMA1 - centered(c)); out.set(bitPack(enc, 18), off); off += (N * 18) / 8; }
  return out;
}
function packHint(h: Poly[]): Uint8Array {
  const out = new Uint8Array(OMEGA + K); let idx = 0;
  for (let i = 0; i < K; i++) { for (let n = 0; n < N; n++) if (h[i]![n]) out[idx++] = n; out[OMEGA + i] = idx; }
  return out;
}

export function sign(sk: SecretParts, msg: Uint8Array, ctx: Uint8Array = new Uint8Array(0), rnd?: Uint8Array, beta: number = BETA, signK?: Uint8Array): Uint8Array {
  const pk = packPk(sk.rho, sk.t1);
  const tr = shake256(pk, { dkLen: 64 });
  const mPrime = new Uint8Array([0, ctx.length, ...ctx, ...msg]);
  const mu = shake256(new Uint8Array([...tr, ...mPrime]), { dkLen: 64 });
  const rndBytes = rnd ?? new Uint8Array(32);
  const rhoPrime2 = shake256(new Uint8Array([...(signK ?? sk.K), ...rndBytes, ...mu]), { dkLen: 64 });
  const s1Hat = sk.s1.map((p) => ntt(p.slice()));
  const s2Hat = sk.s2.map((p) => ntt(p.slice()));
  const t0Hat = sk.t0.map((p) => ntt(p.slice()));
  let kappa = 0;
  for (let iter = 0; iter < 1000; iter++) {
    const y = expandMask(rhoPrime2, kappa); kappa += L;
    const yHat = y.map((p) => ntt(p.slice()));
    // w = A*y
    const w: Poly[] = [];
    for (let i = 0; i < K; i++) { const acc: Poly = new Array(N).fill(0); for (let j = 0; j < L; j++) { const pr = pointwise(sk.aHat[i]![j]!, yHat[j]!); for (let n = 0; n < N; n++) acc[n] = (acc[n]! + pr[n]!) % Q; } w.push(invntt(acc)); }
    const w1 = w.map((p) => p.map(highBits));
    const ctilde = shake256(new Uint8Array([...mu, ...w1Encode(w1)]), { dkLen: 32 });
    const c = sampleInBall(ctilde); const cHat = ntt(c.slice());
    const z: Poly[] = []; for (let j = 0; j < L; j++) { const cs1 = invntt(pointwise(cHat, s1Hat[j]!)); z.push(y[j]!.map((v, n) => mod(v + cs1[n]!))); }
    if (Math.max(...z.map(infNorm)) >= GAMMA1 - beta) continue;
    // r0 = LowBits(w - c*s2)
    let r0ok = true; const r0: Poly[] = [];
    for (let i = 0; i < K; i++) { const cs2 = invntt(pointwise(cHat, s2Hat[i]!)); const wi = w[i]!.map((v, n) => mod(v - cs2[n]!)); r0.push(wi.map(lowBits)); }
    if (Math.max(...r0.map(infNorm)) >= GAMMA2 - beta) { r0ok = false; }
    if (!r0ok) continue;
    // hints
    const h: Poly[] = []; let hintCount = 0; let ct0ok = true;
    for (let i = 0; i < K; i++) {
      const ct0 = invntt(pointwise(cHat, t0Hat[i]!));
      if (infNorm(ct0) >= GAMMA2) { ct0ok = false; break; }
      const cs2 = invntt(pointwise(cHat, s2Hat[i]!));
      const hi: Poly = new Array(N);
      for (let n = 0; n < N; n++) { const r = mod(w[i]![n]! - cs2[n]! + ct0[n]!); hi[n] = makeHint(mod(-ct0[n]!), r); hintCount += hi[n]!; }
      h.push(hi);
    }
    if (!ct0ok || hintCount > OMEGA) continue;
    return new Uint8Array([...ctilde, ...packZ(z), ...packHint(h)]);
  }
  throw new Error('sign: too many rejections');
}
