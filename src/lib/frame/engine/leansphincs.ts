// leanSphincs-s (keccak) signer for the Hegota rail: hash-based, stateless-per-signature, deterministic.
//
// Wraps the wasm32 build of nconsigny/SPHINCS- signers/leansphincs-s-keccak (MIT, see NOTICE-leansphincs.md). The
// signatures verify on-chain against the leanSphincs-s verifier `verify(bytes32 pkSeed, bytes32 pkRoot, bytes32
// message, bytes sig)` (selector 0x2bf6eda8; 0xae3bA3e1DC1bD3866608ECA1498D3e9263B3481a on ethrex privacy-8141).
//
// Self-contained: the wasm is embedded as base64 (./lss-wasm-bytes), the wasm-bindgen glue is inlined below (no
// `import.meta.url`, no fetch, no Node imports), so it bundles the same under webpack/Next and runs in a Web Worker.
// CSP: needs 'wasm-unsafe-eval' in script-src (delta1 lib/csp.ts already has it).
//
// Threading: the sync calls compile the module synchronously on first use. That is fine inside a Web Worker (the
// intended home: keygen is ~0.8 s of CPU). On a browser MAIN thread, Chrome refuses sync compiles over 4 KB, so call
// `await lssInit()` first there (it compiles asynchronously; every later call is then sync).
//
// Secrets: the key returned by lssKeygen is the upstream key file and CONTAINS THE SEED. Keep it inside the worker.
//
// Bundle isolation: import this module ONLY from the rail's worker side (src/lib/frame/lssRail.ts, which only
// pq.worker.ts imports), never from a client component, network.ts or pqClient.ts, so the base64 wasm stays out of
// the main bundle.
import { LSS_WASM_B64 } from "./lss-wasm-bytes";

// ---------------------------------------------------------------------------------------------------------------
// Fixed parameters.
//
// b = 13, cache = 16384 is upstream's `Tier::Light` (the wasm maps exactly this pair to Light; any other pair is a
// Custom tier). Chosen because:
//   - keygen ~0.8 s and sign ~70 ms single-threaded wasm (measured, see OUT.md), acceptable in a worker on a phone;
//   - the key file is small (16,736 B), the same as any b: signature size is fixed (4,164 B);
//   - Light's design target is 20,000 signatures per key (upstream README). Signing keeps NO counter: staying under
//     the budget is the caller's job (for one-shot stealth keys it is moot; for the transparent account it is a
//     long-lived but finite budget).
//   - ONE SEED = ONE b (upstream operational rule): two keys from the same seed at different b can forge each other's
//     signatures with public data only. So b is a constant here, it is NOT a parameter, and it is baked into the seed
//     derivation tag ("b13"); a future tier change must use a new tag (new seed), never the same seed.
// ---------------------------------------------------------------------------------------------------------------
export const LSS_B = 13;
export const LSS_CACHE_BYTES = 16384;
export const LSS_SIG_BYTES = 4164;
export const LSS_SIGNATURE_BUDGET = 20_000;

// Seed derivation is NOT done here: the rail derives each 32-byte seed with its own domain-tag primitive
// (railCore.ts seedFor, shake256(tag || prf)), and the tags pin b ("b13"). This module only takes a seed.

// ---------------------------------------------------------------------------------------------------------------
// wasm-bindgen glue (ported from the generated --target web lss_wasm.js, wasm-bindgen 0.2.100; initSync path only).
// ---------------------------------------------------------------------------------------------------------------
interface LssExports {
  memory: WebAssembly.Memory;
  keygen: (a: number, b: number, c: number, d: number) => [number, number, number, number];
  public_key: (a: number, b: number) => [number, number, number, number];
  sign: (a: number, b: number, c: number, d: number) => [number, number, number, number];
  verify: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number];
  __wbindgen_export_0: WebAssembly.Table;
  __wbindgen_malloc: (a: number, b: number) => number;
  __externref_table_dealloc: (a: number) => void;
  __wbindgen_free: (a: number, b: number, c: number) => void;
  __wbindgen_start: () => void;
}

let wasm: LssExports | undefined;
let mem8: Uint8Array | null = null;
const decoder = new TextDecoder("utf-8", { ignoreBOM: true, fatal: true });

function u8(): Uint8Array {
  if (mem8 === null || mem8.byteLength === 0) mem8 = new Uint8Array(wasm!.memory.buffer);
  return mem8;
}

function imports(): WebAssembly.Imports {
  return {
    wbg: {
      __wbindgen_error_new: (ptr: number, len: number) =>
        new Error(decoder.decode(u8().subarray(ptr >>> 0, (ptr >>> 0) + len))),
      __wbindgen_init_externref_table: () => {
        const table = wasm!.__wbindgen_export_0;
        const offset = table.grow(4);
        table.set(0, undefined);
        table.set(offset + 0, undefined);
        table.set(offset + 1, null);
        table.set(offset + 2, true);
        table.set(offset + 3, false);
      },
    },
  };
}

function finish(instance: WebAssembly.Instance): void {
  wasm = instance.exports as unknown as LssExports;
  mem8 = null;
  wasm.__wbindgen_start();
}

function wasmBytes(): ArrayBuffer {
  const bin = atob(LSS_WASM_B64);
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return buf;
}

let initPromise: Promise<void> | undefined;

/** Async init (compiles off the critical path). Required before any call on a browser main thread; optional in a worker. */
export function lssInit(): Promise<void> {
  if (wasm) return Promise.resolve();
  if (!initPromise) {
    initPromise = (async () => {
      const { instance } = await WebAssembly.instantiate(wasmBytes(), imports());
      if (!wasm) finish(instance);
    })();
  }
  return initPromise;
}

function ready(): LssExports {
  if (!wasm) finish(new WebAssembly.Instance(new WebAssembly.Module(wasmBytes()), imports()));
  return wasm!;
}

function pass(w: LssExports, arg: Uint8Array): [number, number] {
  const ptr = w.__wbindgen_malloc(arg.length, 1) >>> 0;
  u8().set(arg, ptr);
  return [ptr, arg.length];
}

function takeError(w: LssExports, idx: number): unknown {
  const value = w.__wbindgen_export_0.get(idx);
  w.__externref_table_dealloc(idx);
  return value;
}

function takeBytes(w: LssExports, ret: [number, number, number, number]): Uint8Array {
  if (ret[3]) throw takeError(w, ret[2]);
  const out = u8().subarray(ret[0] >>> 0, (ret[0] >>> 0) + ret[1]).slice();
  w.__wbindgen_free(ret[0], ret[1], 1);
  return out;
}

function need32(x: Uint8Array, what: string): void {
  if (!(x instanceof Uint8Array) || x.length !== 32) throw new Error(`${what} must be 32 bytes`);
}

// ---------------------------------------------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------------------------------------------

/** Light-tier key (b = 13, 16 KiB cache) from a 32-byte seed. Returns the key file (SECRET: contains the seed). */
export function lssKeygen(seed32: Uint8Array): Uint8Array {
  need32(seed32, "seed");
  const w = ready();
  const [p, l] = pass(w, seed32);
  return takeBytes(w, w.keygen(p, l, LSS_B, LSS_CACHE_BYTES));
}

/** The on-chain key words: pkSeed and pkRoot, each a high-aligned bytes32. */
export function lssPublicKey(key: Uint8Array): { pkSeed: Uint8Array; pkRoot: Uint8Array } {
  const w = ready();
  const [p, l] = pass(w, key);
  const pk = takeBytes(w, w.public_key(p, l));
  return { pkSeed: pk.slice(0, 32), pkRoot: pk.slice(32, 64) };
}

/** Deterministic 4,164-byte signature over a 32-byte message (the signer verifies it before returning). */
export function lssSign(key: Uint8Array, msg32: Uint8Array): Uint8Array {
  need32(msg32, "message");
  const w = ready();
  const [kp, kl] = pass(w, key);
  const [mp, ml] = pass(w, msg32);
  return takeBytes(w, w.sign(kp, kl, mp, ml));
}

/** Off-chain verify, same semantics as the on-chain verify(bytes32,bytes32,bytes32,bytes). */
export function lssVerify(pkSeed: Uint8Array, pkRoot: Uint8Array, msg32: Uint8Array, sig: Uint8Array): boolean {
  const w = ready();
  const [a, al] = pass(w, pkSeed);
  const [b, bl] = pass(w, pkRoot);
  const [c, cl] = pass(w, msg32);
  const [d, dl] = pass(w, sig);
  const ret = w.verify(a, al, b, bl, c, cl, d, dl);
  if (ret[2]) throw takeError(w, ret[1]);
  return ret[0] !== 0;
}
