# Δ1 Stealth Payments — Interop Spec

> How a third party (any individual or app), given only a Δ1 **meta-address**,
> can derive a fresh stealth address, pay it, and have the recipient's R1DO
> wallet discover the resulting UTXO — **without importing any R1DO code**.

This is a self-contained restatement of the scheme as implemented in
`src/lib/stealth.ts`. Everything here is reproducible with off-the-shelf
crypto libraries (secp256k1, ML-KEM-768, keccak256) plus the Safe SDK for the
one Safe-address step. Wire formats and domain choices are normative.

---

## 0. Primitives & conventions

| Primitive | Used for | Reference impl. |
|---|---|---|
| **secp256k1** | ephemeral key, ECDH, point add | `@noble/secp256k1` |
| **ML-KEM-768** | PQ KEM (FIPS 203) | `@noble/post-quantum/ml-kem` |
| **keccak256** | tag + scalar derivation | `viem` / any Keccak-256 |

- All byte strings are big-endian; hex is lowercase, no `0x` inside payloads.
- **Compressed** secp256k1 points are 33 bytes (`0x02`/`0x03` prefix).
  **Uncompressed** are 65 bytes (`0x04` prefix).
- `n` = secp256k1 group order
  `0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141`.
- The sender needs only: secp256k1 (keygen, ECDH, scalar·G, point add),
  ML-KEM-768 **encapsulate**, and keccak256. **No HKDF, no PRF** — those are
  recipient-only (key generation).

---

## 1. The meta-address

A Δ1 meta-address is **1251 bytes**, distributed off-chain (QR, profile, DM):

```
0x00 ‖ pk_spend(33) ‖ pk_view(33) ‖ ek(1184)
└┬─┘   └────┬────┘   └────┬───┘   └──┬──┘
 │          │             │          └ ML-KEM-768 encapsulation (public) key
 │          │             └ viewing pubkey   (compressed secp256k1)
 │          └ spending pubkey  (compressed secp256k1)
 └ version/type byte (0x00)
```

Hex form: `0x00` followed by exactly **2500 hex chars** (`/^0x00[0-9a-fA-F]{2500}$/`).

Parse:
```
bytes      = decode_hex(meta)
pk_spend   = bytes[1  : 34]    # 33 bytes
pk_view    = bytes[34 : 67]    # 33 bytes
ek         = bytes[67 : 1251]  # 1184 bytes
```

---

## 2. Sender algorithm (derive a fresh stealth address)

Given `pk_spend`, `pk_view`, `ek`:

1. **Ephemeral keypair** — fresh per payment:
   ```
   r  = random secp256k1 scalar      # CSPRNG; never reuse
   R  = compressed(r · G)            # 33 bytes  → goes in the blob
   ```

2. **ECDH** with the viewing key, take the X coordinate:
   ```
   S        = r · pk_view            # secp256k1 point
   sharedX  = X(S)                   # 32 bytes (compressed(S)[1:33])
   ```

3. **ML-KEM-768 encapsulate** against `ek`:
   ```
   (ctKEM, kemShared) = ML_KEM_768.encapsulate(ek)
   # ctKEM = 1088 bytes  → goes in the blob
   # kemShared = 32 bytes (secret, discarded after step 4)
   ```

4. **Combine** both shared secrets into the master scalar `h`:
   ```
   h = keccak256( sharedX ‖ kemShared )     # 64 bytes in → 32 bytes out
   ```
   This hybrid is the PQ argument: an attacker must break **both** ECDH and
   ML-KEM to link or steal. Classical-only breaks ECDH → still stuck on KEM.

5. **View tag** (1-byte fast-reject filter for the scanner):
   ```
   viewTag = h[0]                    # most-significant byte of h
   ```

6. **Stealth owner** (the EOA that will control the funds):
   ```
   hScalar      = int(h) mod n
   P_stealth    = pk_spend + hScalar · G          # secp256k1 point add
   stealthOwner = keccak256( uncompressed(P_stealth)[1:65] )[12:32]   # 20-byte address (EIP-55 checksummed)
   ```

7. **Stealth address = a counterfactual Safe** owned by `stealthOwner`
   (see §3). The salt is the full 256-bit `h` as a decimal string:
   ```
   saltNonce      = decimal_string( int(h) )
   stealthAddress = predictSafe(owner = stealthOwner, saltNonce = saltNonce)
   ```
   `stealthAddress` is the payment destination. **Pay the Safe, not the EOA.**

> Why a Safe and not the raw `stealthOwner` EOA? So the recipient can spend
> ERC-20s with no native gas: the Safe is deployed lazily and a paymaster
> sponsors deploy + first tx. The EOA is only the Safe's owner key.

---

## 3. Stealth Safe address derivation (the one reproduction caveat)

The destination is a **Safe smart account address**, computed deterministically
via the Safe proxy factory's CREATE2. To land on the *same* address R1DO will
re-derive, you **must** use identical deployment parameters:

| Parameter | Value (Sepolia) |
|---|---|
| Safe contracts version | **1.4.1** |
| Safe 4337 module version | **0.3.0** |
| Safe 4337 module address | `0x75cf11467937ce3F2f357CE24ffc3DBF8fD5c226` |
| EntryPoint (v0.7) | `0x0000000071727De22E5E9d8BAf0edAc6f37da032` |
| owners | `[stealthOwner]` |
| threshold | `1` |
| saltNonce | decimal string of `int(h)` |

Easiest correct path: use the Safe SDK exactly as R1DO does
(`@safe-global/relay-kit` → `Safe4337Pack.init({...}).protocolKit.getAddress()`),
feeding the parameters above. Reimplementing the Safe proxy CREATE2 by hand is
possible but error-prone — the initializer must enable the 4337 module, or the
address diverges and the payment becomes undiscoverable.

> This is the only step that isn't "pure crypto." Everything in §2 is portable;
> §3 couples to Safe's deterministic deployment. If you derive a different Safe
> address than R1DO, the funds are real but **invisible** to the recipient.

---

## 4. On-chain delivery (so R1DO's scanner finds it)

R1DO has **no announcer and no registry**. The note-delivery blob travels
**fused with the payment**, as the calldata of the value transfer to the
(code-less) stealth Safe.

### 4.1 The blob — **1126 bytes**

```
blob = MAGIC(4) ‖ viewTag(1) ‖ R(33) ‖ ctKEM(1088)
       └──┬──┘                └┬┘    └──┬──┘
          │                    │        └ ML-KEM ciphertext from §2.3
          │                    └ ephemeral pubkey R from §2.1 (compressed)
          └ ASCII "spe1" = 0x73706531
```

The scanner extracts the `viewTag` from the blob and trial-decrypts; it does
**not** read it from anywhere else. (`stealthAddress` is *not* in the blob — the
recipient re-derives it.)

### 4.2 The discovery channel — **ERC-4337 only (today)**

R1DO's scanner (`scanStealthPayments`) discovers payments like this:

1. Query **EntryPoint v0.7** `UserOperationEvent` logs as a free index (every
   4337 tx emits one; it carries no scheme fingerprint).
2. Fetch each candidate transaction once.
3. Pattern-match the `0x73706531` magic anywhere in `tx.input`, slice out the
   following 1126 bytes, sanity-check `R` starts with `02`/`03`.
4. Trial-decrypt (§5). On success, the derived Safe address is a UTXO.

**Therefore, to be discoverable, the payment MUST:**

- be submitted as an **ERC-4337 UserOperation through the canonical EntryPoint
  v0.7** (`0x0000000071727De22E5E9d8BAf0edAc6f37da032`), **and**
- carry the **1126-byte blob verbatim in the calldata**.

R1DO's own pattern: one UserOp whose inner call is a value transfer to
`stealthAddress` with the blob as that call's calldata. The Safe has no code at
payment time, so the calldata is inert — it exists only as bytes inside the
UserOp, exactly where the scanner looks. ABI encoding keeps the blob's bytes
contiguous inside the outer `handleOps()` calldata, so a raw byte scan finds it.

> **Limitation, stated honestly.** A plain **EOA** transaction that puts the
> blob in `tx.input` and sends ETH to the Safe will **NOT** be found by the
> current scanner — it only fetches txs that emitted an EntryPoint event. A
> sender that cannot speak 4337 needs R1DO to add block-level calldata
> scanning (a documented future option), or to route through any 4337 account
> (their own smart wallet, or a relayer). The cryptography in §2 is fully
> portable; this delivery requirement is the coupling point.

---

## 5. Recipient side (informative — what R1DO does)

For completeness; a sender does not run this. The recipient holds
`sk_spend`, `sk_view` (secp256k1) and the ML-KEM **decapsulation** key `dk`
(all re-derived from the passkey PRF, never stored). For each blob found:

```
sharedX   = X( sk_view · R )                 # ECDH, mirror of §2.2
kemShared = ML_KEM_768.decapsulate(ctKEM, dk)
h         = keccak256( sharedX ‖ kemShared )
if h[0] != blob.viewTag: reject              # cheap filter
hScalar   = int(h) mod n
stealthOwner = address( pk_spend + hScalar·G )
stealthAddress = predictSafe(stealthOwner, decimal(int(h)))   # §3
```

The scanner records `stealthAddress` as a UTXO (a balance check confirms funds
actually landed). To **spend**, the recipient re-derives the owner private key:

```
sk_stealth = ( int(sk_spend) + hScalar ) mod n
```

which is exactly the private key for `stealthOwner`, i.e. the Safe's owner.

---

## 6. Compliance checklist for an external sender

- [ ] Parse meta-address as `0x00 ‖ 33 ‖ 33 ‖ 1184` (1251 bytes).
- [ ] Fresh ephemeral `r` from a CSPRNG, **never reused**.
- [ ] `sharedX` = X-coordinate (32 bytes) of `r·pk_view`, **not** the full point.
- [ ] `h = keccak256(sharedX ‖ kemShared)` over the **64-byte** concatenation.
- [ ] `saltNonce` = **decimal** string of the 256-bit `h` (not hex).
- [ ] Stealth Safe derived with the §3 parameters (version 1.4.1, module 0.3.0).
- [ ] Pay the **Safe** address, not the owner EOA.
- [ ] Blob = `"spe1" ‖ viewTag ‖ R(33) ‖ ctKEM(1088)` = **1126 bytes**, exact.
- [ ] Delivered as an **EntryPoint v0.7 UserOp** with the blob in calldata.

---

## 7. Variant: paying a **pre-computed address** (sender does no derivation)

Sometimes the R1DO user doesn't want to hand out a meta-address and make the
other side derive. Instead they run §2 **themselves** (against their own
meta-address) and hand the counterparty an **already-computed stealth
address**. The sender's job collapses to "send funds to this address" — no
secp256k1, no ML-KEM, no `h`. Simpler, exactly as you'd expect.

The only open question is then **how R1DO discovers the payment** — i.e. where
the delivery **note** lives. There are three answers, distinguished purely by
*where the note travels*:

- **Ghost** (7.A) — note stays **local** (device-bound).
- **Announce** (7.B) — note goes **on-chain** as the blob (public, scannable).
- **Off-chain Courier** (7.D) — note travels over a **secure off-chain channel**
  and is **imported** by hand (private, portable, any payer wallet).

The cryptography (§2/§5) is identical across all three; only the note's
transport changes.

### 7.A Ghost — no blob at all (simplest)

The R1DO user precomputes one stealth address via §2 and **keeps the note
locally** (`{ stealthAddress, R, ctKEM, viewTag }` — what `addStealthUTXO`
stores). They give the counterparty **only `stealthAddress`**.

- **Sender:** a plain transfer to `stealthAddress`. **Any** method works —
  a raw EOA `send`, an exchange withdrawal, a contract call. **No 4337, no
  blob, no EntryPoint.**
- **Discovery:** R1DO does **not** scan for this one. It already holds the
  local note, so it simply **watches that address's balance**. When funds
  arrive, it's a UTXO; spend key re-derived from the stored `R`/`ctKEM` (§5).

Trade-offs — this is **Ghost**, with Ghost's properties:
- ✅ Maximum simplicity for the payer; maximum privacy (nothing extra on-chain).
- ⚠️ **Device-bound.** Spendability lives in the local note. Lose that storage
  with no backup and the funds are stranded (the `R` is gone, so `h` — and the
  owner key — can't be re-derived). Back up the note to move it across devices.
- ⚠️ It's **one pre-shared address**, fixed in advance — not a fresh address
  per payment. Reusing it across payers re-links them on-chain. Hand out a
  fresh one per counterparty to preserve unlinkability.

### 7.B Announce — pre-computed address **+ blob emitted on-chain**

If you want the "discoverable anywhere, no local note" property but still spare
the sender the crypto: the R1DO user precomputes the address **and** the
1126-byte blob (§4.1), then hands the counterparty **both**, asking them to put
the blob in the payment's calldata.

- **Sender:** still does no crypto — they just relay opaque bytes. But the
  payment must now be an **EntryPoint v0.7 UserOp carrying the blob** (§4.2),
  same delivery constraint as the meta-address flow.
- **Discovery:** the normal scanner (`scanStealthPayments`) finds it on **any
  device** — no local note required. This is **Announce**.

Trade-off: you regain scan-discovery and device-portability, but you pay the
4337-delivery requirement back, and the sender must be willing/able to attach
the blob.

### 7.D Off-chain Courier — note delivered out-of-band, **imported** by hand

The note doesn't have to live locally (Ghost) or on-chain (Announce). It can
simply be **handed over a secure channel** (Signal, QR in person, encrypted
email) and **imported** into R1DO. This is the most powerful mode: it combines
the privacy of Ghost with the portability of Announce, and lets **any wallet**
pay.

**Who runs §2.** Whoever has the meta-address derives `(stealthAddress, note)`:

- the **payer**, via a tiny standalone tool that implements §2 (no R1DO
  dependency — literally a one-page web/QR or CLI). They get the address to pay
  and the note to send back; **or**
- the **recipient** pre-derives and hands the payer the address as a "pay here"
  invoice, keeping the note to import later / on another device.

**The note ("ALGO" over the channel).** It is exactly the §4.1 blob payload
minus the magic — `R(33) ‖ ctKEM(1088) ‖ viewTag(1)` — ~1126 bytes. Ship it as
hex, base64, or a QR. `stealthAddress` is derivable from it (§5) so it need not
be sent, though including it lets the importer pre-fill a balance check.

**Flow:**
1. Payer pays `stealthAddress` with **any** wallet — a plain ETH/ERC-20 transfer.
   **No 4337, no blob on-chain, no EntryPoint.** On-chain it is an ordinary
   transfer to a fresh address, indistinguishable from any other.
2. The note is delivered over the secure channel.
3. In R1DO (privacy-enabled), from the light side: **"Import payment"** →
   paste/scan the note. R1DO **trial-decrypts** it (`checkPQPayment`): if the
   keys match, it derives `stealthAddress`, confirms the on-chain balance, and
   records the UTXO (`addStealthUTXO`). If it doesn't decrypt to this wallet, the
   import is rejected — you can't import someone else's payment or garbage.

**Why it's the best of the three:**
- ✅ **Any payer wallet** (MetaMask, hardware, exchange) — the 4337 requirement
  is gone, because discovery is by import, not by on-chain scan.
- ✅ **Nothing extra on-chain** — *more* private than Announce; there is no
  `spe1` footprint at all, just a normal-looking transfer.
- ✅ **Portable** — the note travels by definition, so it fixes Ghost's
  device-binding.

**Security of the courier note:** it is **not a custody bearer**. An interceptor
learns the address (a privacy leak — they can link payer↔address and watch it)
but **cannot spend**: spending needs the recipient's `sk_spend`, which is not
derivable from the address or the note. The note is only useful to the owner of
the meta-address it was derived against. So leaking it costs privacy, never
funds — which is what makes hand-off over a "good enough" channel acceptable.

UI: this is the **"Import payment" / "Import ghost payment"** action. The same
import path also serves **note backup/portability** for 7.A Ghost (export the
local note, re-import elsewhere).

### 7.E Which to use

| | derive? | on-chain blob | payer wallet | discovery | portable? | extra on-chain footprint |
|---|---|---|---|---|---|---|
| **Meta-address** (§2–4) | payer | yes | 4337 only | scan | yes | blob (scannable) |
| **Ghost** (7.A) | recipient | **no** | **any** | watch address | no (local note) | none |
| **Announce** (7.B) | recipient | yes | 4337 only | scan | yes | blob (scannable) |
| **Off-chain Courier** (7.D) | either | **no** | **any** | **import note** | **yes** | **none** |

Rule of thumb:
- **Off-chain Courier (7.D)** — the default when you can hand the note over a
  secure channel: any wallet pays, nothing extra on-chain, portable.
- **Ghost (7.A)** — when the payer is external and you don't need portability;
  accept a device-bound note (or back it up via the Courier import path).
- **Announce (7.B)** — when discovery must be automatic/scannable on any device
  and you accept an on-chain footprint.
- **Meta-address (§2–4)** — when the counterparty should mint a fresh address
  per payment with zero coordination (and can speak 4337).

The cryptography (§2) is identical in all four — only *who* runs it and *where
the note travels* change.

> Security note: handing out a pre-computed `stealthAddress` (and even the blob)
> never leaks the spending key. The owner key depends on `sk_spend`, which is
> never derivable from the public address or the blob. A pre-shared address is
> safe to publish; it only costs **privacy** if reused, never **custody**.

---

## 8. Versioning

The leading `0x00` of the meta-address and the `"spe1"` magic are the version
anchors. Any change to the combine function (`keccak256(sharedX ‖ kemShared)`),
the salt encoding, the Safe parameters, or the blob layout is a **breaking**
change and must bump these. Current scheme: **Δ1 / spe1**.
```
References (R1DO impl., for cross-checking only):
  src/lib/stealth.ts   — generateStealthPayment / extractStealthBlobs / scanStealthPayments / checkPQPayment
  src/app/constants.tsx — Safe / module / EntryPoint addresses & versions
```
