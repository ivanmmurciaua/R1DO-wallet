// DKSAP blinded ML-DSA-44 (P1.3b, construction A): over an ML-KEM shared secret `ss`, the
// sender derives the recipient's one-time stealth public key from the recipient's base
// public key (rho, t); the recipient recovers the matching blinded SIGNING key. The blinded
// key has secret norms up to 2*eta, so signing rejects at a widened BETA_BLINDED = tau*2*eta,
// which keeps the output z within the STANDARD bounds -> a standard verifier (and @noble)
// accepts it. Credit: blinded-ML-DSA construction from the pq-sap project.
import { shake256 } from '@noble/hashes/sha3';
import {
  Q, N, K, L, TAU, ETA, expandA, expandS, ntt, invntt, pointwise, power2round, packPk,
  type Poly, type SecretParts,
} from './dilithium44';

export const BETA_BLINDED = TAU * 2 * ETA; // 156
const BLIND_KDF = new TextEncoder().encode('pq-dksap/blind/v1');
const SIGN_KDF = new TextEncoder().encode('pq-dksap/sign/v1');
const mod = (a: number) => ((a % Q) + Q) % Q;

function blinding(ss: Uint8Array): { sP: Poly[]; eP: Poly[] } {
  const seed = shake256(new Uint8Array([...BLIND_KDF, ...ss]), { dkLen: 64 });
  const { s1, s2 } = expandS(seed);
  return { sP: s1, eP: s2 };
}

// t' = t + A*s' + e'  (A in NTT domain = expandA(rho))
function blindT(aHat: Poly[][], t: Poly[], sP: Poly[], eP: Poly[]): Poly[] {
  const sHat = sP.map((p) => ntt(p.slice()));
  const out: Poly[] = [];
  for (let i = 0; i < K; i++) {
    const acc: Poly = new Array(N).fill(0);
    for (let j = 0; j < L; j++) { const pr = pointwise(aHat[i]![j]!, sHat[j]!); for (let n = 0; n < N; n++) acc[n] = (acc[n]! + pr[n]!) % Q; }
    const as = invntt(acc);
    out.push(t[i]!.map((v, n) => mod(v + as[n]! + eP[i]![n]!)));
  }
  return out;
}
function split(tPrime: Poly[]): { t1: Poly[]; t0: Poly[] } {
  const t1: Poly[] = [], t0: Poly[] = [];
  for (const p of tPrime) { const a: Poly = new Array(N), b: Poly = new Array(N); for (let n = 0; n < N; n++) { const [x, y] = power2round(p[n]!); a[n] = x; b[n] = y; } t1.push(a); t0.push(b); }
  return { t1, t0 };
}

/** Sender: derive the recipient's stealth public key (packed) from (rho, base t, ss). */
export function senderStealthPk(rho: Uint8Array, t: Poly[], ss: Uint8Array): Uint8Array {
  const aHat = expandA(rho);
  const { sP, eP } = blinding(ss);
  const { t1 } = split(blindT(aHat, t, sP, eP));
  return packPk(rho, t1);
}

/** Recipient: form the blinded signing key (and its ss-derived signing seed). */
export function recipientBlindedKey(base: SecretParts, ss: Uint8Array): { sk: SecretParts; signK: Uint8Array } {
  const { sP, eP } = blinding(ss);
  const s1 = base.s1.map((p, j) => p.map((v, n) => mod(v + sP[j]![n]!)));
  const s2 = base.s2.map((p, i) => p.map((v, n) => mod(v + eP[i]![n]!)));
  const tPrime = blindT(base.aHat, base.t, sP, eP);
  const { t1, t0 } = split(tPrime);
  const signK = shake256(new Uint8Array([...SIGN_KDF, ...ss]), { dkLen: 32 });
  return { sk: { rho: base.rho, rhoPrime: base.rhoPrime, K: base.K, s1, s2, t: tPrime, t0, t1, aHat: base.aHat }, signK };
}
