# Third-party notice: leanSphincs-s WASM signer

`lss-wasm-bytes.ts` embeds (base64) a WebAssembly binary compiled from third-party MIT-licensed Rust code.
`leansphincs.ts` contains glue code ported from wasm-bindgen generated output.

## Components

| Component | Source | License |
|---|---|---|
| leansphincs-s-keccak (the signer) | nconsigny/SPHINCS-, `signers/leansphincs-s-keccak`, commit 0b3e363. Copyright (c) 2026 Nicolas Consigny | MIT |
| upstream of the above | TomWambsgans/leanXMSS-leanSPHINCS-candidates (Copyright (c) 2026 Tom Wambsgans) and leanEthereum/leanVM | MIT (leanVM: MIT OR Apache-2.0) |
| tiny-keccak 2.0.2 (Keccak-256) | crates.io | CC0-1.0 |
| crunchy 0.2.4 (tiny-keccak dependency) | crates.io | MIT |
| wasm-bindgen 0.2.100 (runtime + glue pattern) | rustwasm/wasm-bindgen | MIT OR Apache-2.0 |
| lss-wasm wrapper (`keygen`, `public_key`, `sign`, `verify` exports) | R1DO, written for this integration | MIT |

## Modifications (wasm32 single-thread patch)

The upstream crate parallelizes tree hashing with `std::thread::scope`, which does not exist on
`wasm32-unknown-unknown`. The build patches `src/hash.rs` under `#[cfg(target_arch = "wasm32")]` only:

- `available_threads()` returns 1;
- `par_map_on(threads, n, f)` runs `(0..n).map(f).collect()` on the calling thread (same order, same results, same
  work counts).

Native builds are unchanged. No cryptographic logic was modified. Determinism was checked: the wasm build reproduces
the native signer's output, and its signatures verify on-chain against the leanSphincs-s verifier
(0xae3bA3e1DC1bD3866608ECA1498D3e9263B3481a, ethrex privacy-8141).

Binary: 92,468 bytes, sha256 `c759cd170d21ff3ed30cbfb101d7e81444d073a59db741a3b85d53ae11747068`
(wasm-bindgen 0.2.100, `--target web`, Rust release profile: opt-level 3, lto, codegen-units 1, panic abort).

Status: the upstream code is research-grade and UNAUDITED.

## MIT License (nconsigny/SPHINCS-)

```
MIT License

Copyright (c) 2026 Nicolas Consigny <nicolas@ethereum.org>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## MIT License (leanXMSS-leanSPHINCS-candidates, upstream of leansphincs-s-keccak)

```
MIT License

Copyright (c) 2026 Tom Wambsgans

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
