# R1DO Wallet Δ — Tech Stack & Cryptographic Design

A primitive-by-primitive breakdown of how Δ is built, **weighted heavily toward
the cryptography**. App-framework and infra choices are summarized at the end;
the bulk of this document is about keys, hashes, KDFs, AEADs, the post-quantum
hybrid, and the zero-knowledge layer.

> Scope: Ethereum **Sepolia** testnet. Contract addresses, the Pimlico key and
> deployment specifics live in `.env` / `src/app/constants.tsx`, not here.

---

## 0. One secret to rule them all: the passkey PRF

Everything cryptographic in Δ descends from a single root secret: the **32-byte
output of the WebAuthn PRF extension** (`prf`), unlocked by a biometric gesture
on the device's secure element. The passkey itself **never signs transactions**
— it only gates the deterministic re-derivation of every key below. No key is
ever persisted: each session re-derives what it needs from the PRF and zeroizes
it.

```
                 ┌──────────────────────────────┐
   passkey  ───► │  WebAuthn PRF  → 32-byte seed │  (biometric gate, never stored)
                 └───────────────┬──────────────┘
                                 │  HKDF-SHA256, domain-separated `info`
        ┌────────────────┬───────┴────────┬─────────────────┬──────────────┐
        ▼                ▼                ▼                 ▼              ▼
   Safe owner      stealth keys     ML-KEM keys      Railgun 0zk     relay / enc
   (secp256k1)   (secp256k1 ×2)    (ML-KEM-768)     (BIP39 seed)     keys
```

The KDF is **HKDF-SHA256** (RFC 5869, extract-and-expand) with a distinct
`info` string per branch — domain separation guarantees that two branches can
never collide or leak into each other. These `info` strings are **cryptographic
domain separators** and are treated as a stable, versioned ABI (see §8).

---

## 1. Account control — secp256k1 / ECDSA

| | |
|---|---|
| **Primitive** | secp256k1, ECDSA (verified on-chain via `ecrecover`) |
| **Used for** | Owner key of every Safe smart account (main + stealth + ephemeral relay) |
| **Derivation** | `ownerSeed = HKDF-SHA256(prf, info="r1do/wallet/owner/v2", 32)` → used directly as the secp256k1 private key |
| **PQ status** | Classical (broken by Shor); migration path designed — see §7 |

The main account is a **Safe** smart account whose sole owner is this
PRF-derived secp256k1 key. There are **no P-256 / WebAuthn coordinates anywhere
on-chain** — the legacy `PasskeyRegistry` (plaintext P-256 points keyed by
`keccak(username)`) was removed. The passkey biometrically gates the derivation;
the resulting key signs Safe operations with ordinary `ecrecover`.

> Because the owner is "just an HKDF branch", a post-quantum owner (Falcon /
> ML-DSA) is **one new branch + one `swapOwner`** away once EVM gets a verifier
> precompile. The wallet's custody model is forward-compatible by construction.

---

## 2. Stealth payments (Δ1) — a post-quantum **hybrid** scheme

This is the heart of Δ's privacy and the most interesting cryptography in the
project. It is an **announcer-less, PQ-hybrid stealth-address scheme**.

### 2.1 Keys (recipient side)

Three keypairs, all HKDF-SHA256 branches of the PRF:

| Key | Primitive | HKDF `info` | Size |
|---|---|---|---|
| Spending key | secp256k1 | `r1do-stealth-spend-v1` | 32 B priv |
| Viewing key | secp256k1 | `r1do-stealth-view-v1` | 32 B priv |
| KEM keypair | **ML-KEM-768** (FIPS 203) | `r1do-stealth-kem1-v1` ‖ `r1do-stealth-kem2-v1` (64 B seed) | 1184 B encaps / 2400 B decaps |

The public **meta-address** (shared off-chain — QR, profile, DM) is:

```
0x00 ‖ pk_spend(33) ‖ pk_view(33) ‖ mlkemEncapsKey(1184)   = 1251 bytes
```

### 2.2 Generating a payment (sender side)

For each payment the sender:

1. Generates an **ephemeral secp256k1** keypair `(r, R)`.
2. **ECDH**: `sharedX = ECDH(r, pk_view)` → 32-byte classical shared secret.
3. **ML-KEM encapsulate** against the recipient's `mlkemEncapsKey` →
   `ctKEM(1088 B)` + `kemShared(32 B)` (the post-quantum shared secret).
4. **Combine both worlds**: `h = keccak256(sharedX ‖ kemShared)`.
5. `viewTag = h[0]` (1 byte, fast scan filter); `hScalar = h mod n`.
6. **Stealth owner pubkey** = `pk_spend + hScalar·G`; its address is the owner
   of a **counterfactual Safe** with `saltNonce = h`. That Safe address is where
   the funds land — sender and receiver predict the *same* address with no
   coordination.

> **Why this is post-quantum.** The discovery/derivation secret `h` mixes a
> classical ECDH secret **and** an ML-KEM secret with `keccak256`. A quantum
> adversary can break the ECDH half (`sharedX`) but **not** the ML-KEM half
> (`kemShared`) — so it cannot reconstruct `h`, cannot recompute the stealth
> address, and **cannot link the payment to the recipient**. Recipient privacy
> survives Shor's algorithm. (Custody of the landed funds is the Safe owner key
> from §1 — classical today, migratable per §7.)

### 2.3 Announcer-less delivery (the "Δ1" part)

There is **no ERC-5564 announcer and no ERC-6538 registry**. The delivery blob
rides as the **calldata of the value transfer itself**:

```
MAGIC("spe1", 4) ‖ viewTag(1) ‖ R(33) ‖ ctKEM(1088)   = 1126 bytes
```

Sent to the (still code-less) stealth Safe, the blob is inert on-chain. The
receiver scans **without any privacy-specific index**: it uses the ERC-4337
**EntryPoint's `UserOperationEvent`** as a free, universal index (every 4337 tx
emits it), fetches candidate tx calldata, pattern-matches the `spe1` magic, and
**trial-decrypts** with view-tag pre-filtering: re-run ECDH + **ML-KEM
decapsulate** with the private decaps key → recompute `h` → check `viewTag` →
confirm the derived address. A match yields a spendable stealth UTXO.

### 2.4 Spending

`deriveStealthSpendingKey` re-derives the one-time private key
`= spendingPriv + hScalar (mod n)`; the resulting account owns the stealth Safe
and signs its spend. Nothing about the stealth key is ever stored — it is
recomputed from the PRF + the on-chain blob (announce mode) or a local note
(ghost mode).

---

## 3. Encrypted username directory — memory-hard + AEAD

Pay-by-username without a public phone book. On-chain the directory
(`R1DODirectory.sol`) stores only `fingerprint → opaque bytes`; everything
meaningful is encrypted client-side.

| Step | Primitive | Parameters |
|---|---|---|
| Username → key material | **Argon2id** (RFC 9106) | `m = 64 MiB`, `t = 3`, `p = 1` → 32 B |
| Record encryption | **XChaCha20-Poly1305** (AEAD) | 24-byte random nonce |

```
k        = Argon2id(username [‖ 0x00 ‖ pin], salt, 64MiB, t=3, p=1)   → 32 B
fp       = lookup key (on-chain slot)         ┐ both derived from k
encKey   = AEAD key                           ┘
on-chain = nonce(24) ‖ XChaCha20-Poly1305(encKey, payload)
```

- **Memory-hardness:** because the lookup fingerprint is gated by a 64 MiB / ~1 s
  Argon2id evaluation (not a free `keccak`), **mass enumeration of usernames
  costs ~1 s × 64 MiB per guess** — brute-forcing the directory is economically
  impractical.
- **Fixed-size records:** the plaintext payload is zero-padded to a constant
  `PAYLOAD_SIZE` (currently **1502 B**) so entry length leaks nothing. Layout
  (v3): `version ‖ rawId(64) ‖ safeAddress(20) ‖ [meta-address 1251] ‖ [0zk ≤160]`.
- **Not quantum-harvestable:** the directory uses **only symmetric** crypto
  (Argon2id + XChaCha20-Poly1305). There is no public-key material to harvest
  now and decrypt later — a "harvest-now, decrypt-later" quantum adversary gets
  nothing. A username's entry can carry the PQ **meta-address**, so *paying a
  username can be automatically private*.

---

## 4. The privacy pool — zero-knowledge (Railgun)

The private world is built on **Railgun** (`@railgun-community/wallet`), a
zk-SNARK shielded pool.

| | |
|---|---|
| **Proof system** | Groth16 zk-SNARKs |
| **Curve** | BN254 / alt-bn128 (pairing-friendly) |
| **Hash (in-circuit)** | Poseidon (Merkle tree of commitments / nullifiers) |
| **Prover** | snarkjs (Groth16) injected into the engine in-browser |
| **PQ status** | **Classical** (pairing-based + trusted setup) — not post-quantum |

### 4.1 The shielded identity (`0zk`), from the same PRF

The user's single Railgun address is derived from the PRF via four HKDF-SHA256
branches:

| Branch (`info`) | Output | Role |
|---|---|---|
| `r1do/pool/railgun/seed/v1` | 16 B entropy → **BIP39** mnemonic (`Mnemonic.fromEntropy`) | the 0zk wallet seed |
| `r1do/pool/railgun/enc/v1` | 32 B | at-rest encryption key for the engine's wallet DB |
| `r1do/pool/railgun/shield/v1` | 32 B | shield private key |
| `r1do/pool/railgun/relay/v1` | 32 B | owner key of the ephemeral relay Safe |

One 0zk identity per user (so the anonymity set stays pooled), deterministic and
re-derivable; private keys are never stored.

### 4.2 Operations & the privacy seams

- **Shield** (enter the pool): a plain call (no ZK proof needed); the protocol
  takes a fee (read live from the contract, e.g. 0.25%).
- **Private transfer / unshield**: a **Groth16 proof** (~9 s in-browser, ~50 MB
  one-time artifacts) proves the spend is valid without revealing inputs.
- **Proof-of-Innocence (POI):** spends require the inputs to carry a valid POI
  attestation, fetched/generated against an aggregator node.
- **Ephemeral relay Safe:** in private mode the proven tx is submitted by a
  *fresh, single-use* Safe (random `saltNonce`, sponsored, value 0) — a proven
  Railgun tx doesn't bind `msg.sender`, so this **unlinks the submitter** from
  your identity. Combined with a fresh stealth destination on unshield, both the
  *sender* and the *recipient* of an exit are unlinkable.

> **Honest PQ note:** the pool's privacy rests on Groth16/BN254, which is
> **classical** (and uses a trusted setup). Δ's *stealth layer* is post-quantum;
> the *pooled* layer is not. The two are independent — pool privacy is the same
> guarantee Railgun offers everyone.

---

## 5. Tools-suite crypto (shared origin)

Credentials are mirrored into IndexedDB `R1DOToolsDB`, shared with the R1DO
Tools suite (notes / tasks / chat) so one passkey works everywhere. That suite
uses the same PRF root with HKDF, **signed ECIES v2** (secp256k1) for encrypted
contacts/messages, and a unified suite salt `r1do-suite-v1`. (Detailed in the
suite's own `CRYPTO-MIGRATION-LEGACY-TO-V2.md`.)

---

## 6. Primitive inventory

| Primitive | Type | Where | PQ-secure? |
|---|---|---|---|
| **HKDF-SHA256** | KDF | every key derivation from the PRF | ✅ (symmetric) |
| **secp256k1 / ECDSA** | signature | Safe owner, `ecrecover` | ❌ (Shor) |
| **secp256k1 / ECDH** | key agreement | stealth (classical half) | ❌ (Shor) |
| **ML-KEM-768** | KEM (FIPS 203) | stealth (PQ half), meta-address | ✅ |
| **keccak256** | hash | address derivation, stealth `h`, fingerprints | ✅ (Grover-only) |
| **Argon2id** | memory-hard PWKDF | username directory | ✅ (symmetric) |
| **XChaCha20-Poly1305** | AEAD | directory records | ✅ (symmetric) |
| **Groth16 / BN254** | zk-SNARK | Railgun pool proofs | ❌ (pairing + setup) |
| **Poseidon** | ZK-friendly hash | Railgun Merkle tree | ✅ (symmetric) |
| **BIP39** | mnemonic encoding | 0zk seed encoding | n/a |
| **ECIES v2 (secp256k1)** | hybrid encryption | tools contacts/messages | ❌ (Shor) |

**Reading it:** symmetric primitives (hashes, AEAD, KDFs, Argon2id) are
post-quantum-safe. The PQ frontier is the **public-key** layer: stealth
*discovery* is already hybrid-PQ (ML-KEM); account custody (secp256k1) and pool
proofs (Groth16) remain classical and are the next migration targets.

---

## 7. Post-quantum posture (summary)

- **Recipient privacy of stealth payments: PQ-secure today.** The hybrid `h`
  needs the ML-KEM secret a quantum adversary can't get.
- **Directory: not harvestable.** Symmetric-only; nothing to decrypt-later.
- **Account custody: classical, migratable.** secp256k1 owner is one HKDF branch
  + `swapOwner` away from a Falcon/ML-DSA owner once an EVM verifier lands.
- **Pool privacy: classical** (Groth16/BN254), inherited from Railgun.
- **Caveat:** no production privacy pool is post-quantum yet; Δ's design isolates
  this behind a `PoolAdapter` so a future PQ pool can slot in without touching
  the stealth/identity layers.

---

## 8. Cryptographic domain separators (stable ABI)

Changing any of these strings rotates the corresponding keys for **every
existing user** → never edit without a migration.

| `info` / salt | Branch |
|---|---|
| `r1do/wallet/owner/v2` | Safe owner key |
| `r1do-stealth-spend-v1` | stealth spending key |
| `r1do-stealth-view-v1` | stealth viewing key |
| `r1do-stealth-kem1-v1` / `r1do-stealth-kem2-v1` | ML-KEM seed (concatenated) |
| `r1do/pool/railgun/seed/v1` | 0zk BIP39 entropy |
| `r1do/pool/railgun/enc/v1` | 0zk DB encryption key |
| `r1do/pool/railgun/shield/v1` | shield private key |
| `r1do/pool/railgun/relay/v1` | ephemeral relay owner key |
| `r1do-suite-v1` | tools-suite PRF salt |
| `spe1` (`0x73706531`) | stealth delivery blob magic |

---

## 9. Application & infrastructure stack

The non-cryptographic scaffolding, briefly:

- **Framework:** Next.js (App Router) + React, MUI for UI, **webpack** build
  (not Turbopack — the Railgun engine needs Node polyfills applied at build).
- **EVM client:** viem; ethers v6 inside the Railgun adapter.
- **Smart accounts:** Safe (`@safe-global/relay-kit`, Safe 4337 module) on
  **ERC-4337**; EntryPoint v0.7.
- **Bundler / paymaster:** Pimlico (gas sponsorship, so users need no ETH).
- **RPC:** PublicNode (Sepolia) primary, with a multi-RPC failover list.
- **Privacy engine:** `@railgun-community/wallet` — LevelDB→IndexedDB storage,
  artifacts in localforage, snarkjs Groth16 prover, lazily imported only when
  entering the private world (kept out of the login bundle).
- **POI:** Private Proof-of-Innocence aggregator (`ppoi.fdi.network`), a hard
  gate for pool operations.

---

*Δ is the experimental privacy fork of R1DO Wallet — Sepolia testnet only.*
*MIT License. © 2025–2026 Iván M.M*
