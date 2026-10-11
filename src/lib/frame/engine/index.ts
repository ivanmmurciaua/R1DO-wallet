// R1DO hegota rail engine (FASE 1 vendored subset).
//
// Faithful copies of the standalone EIP-8141 frame-tx engine modules, adapted to delta1's
// toolchain (extensionless relative imports, @noble/hashes subpath style). No delta1
// coupling: import the namespaces and drive the rail directly.
//
// Modules are exported as namespaces because the crypto layers intentionally share
// primitive names (Q, ntt, expandA, Poly). Import what you need, e.g.
//   import { dilithium44, frametx } from "@/lib/frame/engine";
//   const { publicKey, sk } = dilithium44.keygen(seed);
//   const raw = frametx.encode(tx);
//
// Layers:
//   dilithium44 - ML-DSA-44 (FIPS-204, SHAKE): keygen + sign, from scratch (blindable).
//   mldsa44     - public-key expansion for the on-chain ZKNOX inline verifier.
//   stealth44   - DKSAP blinded stealth key (derive on send, recover on receive).
//   dksap       - DKSAP discovery (ML-KEM-512 key agreement + view tag).
//   frametx     - EIP-8141 frame-tx codec (encode + sig_hash), envelope-config aware.
//   directory   - EIP-8272 recent roots + native pay-by-nick (merkle + resolve calldata).
//   submit      - secp256k1 frame signing + live submission (sendRaw / waitReceipt).
export * as dilithium44 from "./dilithium44";
export * as mldsa44 from "./mldsa44";
export * as stealth44 from "./stealth44";
export * as dksap from "./dksap";
export * as frametx from "./frametx";
export * as directory from "./directory";
export * as submit from "./submit";
