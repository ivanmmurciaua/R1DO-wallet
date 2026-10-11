// Hegota rail PQ worker. The ML-DSA keygen/sign is CPU-heavy, so it runs off the main
// thread (same Comlink pattern as pool/railgun.worker.ts). The passkey-PRF root arrives as
// 32 bytes; the worker derives the account's ML-DSA key with its own domain tag, independent
// of delta1's existing keys. The secret key NEVER leaves the worker.
//
// FASE 1.2 (path A): the account has a deterministic CREATE2 address. A spend is two frame
// txs chained here, with NO EOA and NO faucet in the flow:
//   TX1 (only if not yet deployed) sponsored deploy: sender = the open on-chain paymaster,
//       which pays; a DEFAULT frame CREATE2-deploys the account via the factory.
//   TX2 self-pay spend: sender = the account; it APPROVEs paying its own gas from its
//       received balance, verifies its ML-DSA signature (atomic-batch gate), and the SENDER
//       frame moves `value` to `to`. The user signs with the passkey (ML-DSA); funds nothing.
import * as Comlink from "comlink";
import {
  createPublicClient, defineChain, http, encodeAbiParameters, keccak256, toHex, concat, hexToBytes,
  type Hex, type PublicClient,
} from "viem";
import { shake256 } from "@noble/hashes/sha3";
import { dilithium44, mldsa44, stealth44, dksap } from "./engine/index";
import { deriveAccount as deriveCreate2, factoryDeployCalldata } from "./engine/account";
import { ACCOUNT_PQ_BIN } from "./engine/bin";
import {
  MODE_VERIFY, MODE_DEFAULT, MODE_SENDER, FLAG_APPROVE_EXECUTION_AND_PAYMENT, FLAG_ATOMIC_BATCH,
  FLAG_NONE, SCHEME_ARBITRARY, sigHash, encode, type FrameTx,
} from "./engine/frametx";
import { rpc, sendFrameTx, waitReceipt, networkFees } from "./engine/submit";
import {
  RECENT_ROOT, storageKey, entryHash, resolveCalldata,
} from "./engine/directory";
import { HEGOTA } from "./network";
import { lookupNick, DIRECTORY_SRC, DIRECTORY_ROOT } from "./directory";

const MLDSA_DOMAIN = new TextEncoder().encode("r1do/hegota/mldsa");
const MLKEM_DOMAIN = new TextEncoder().encode("r1do/hegota/mlkem");

// Gas the self-pay spend (TX2) must be able to pre-pay. The account is charged UP FRONT at the
// declared frame-gas limit (VERIFY 95k + ATOMIC_BATCH verify 16.2M + SENDER 500k = 16.795M) plus
// the inline ML-DSA signature calldata (~24 KB -> ~0.5M) plus intrinsic. We reserve 18M with
// headroom so a SWEEP leaves the SENDER frame enough to actually move the value (unused gas is
// refunded, so the only cost of over-reserving is a slightly larger dust remainder).
const SELF_PAY_GAS_RESERVE = 18_000_000n;

// Domain-separated 32-byte seed from the PRF root. Each key layer (ML-DSA signing, ML-KEM
// discovery) gets its own tag so the derivations are independent.
function seedFor(domain: Uint8Array, prf: Uint8Array): Uint8Array {
  const buf = new Uint8Array(domain.length + prf.length);
  buf.set(domain, 0);
  buf.set(prf, domain.length);
  return shake256(buf, { dkLen: 32 });
}
const mldsaSeed = (prf: Uint8Array): Uint8Array => seedFor(MLDSA_DOMAIN, prf);

const RPC = HEGOTA.rpcUrls[0];
const verifier = HEGOTA.singletons?.verifier;
const factory = HEGOTA.singletons?.accountFactory;
const openSponsor = HEGOTA.singletons?.openSponsor;
const directoryResolver = HEGOTA.singletons?.directory;
const chain = defineChain({
  id: HEGOTA.chainId,
  name: HEGOTA.name,
  nativeCurrency: { name: HEGOTA.symbol, symbol: HEGOTA.symbol, decimals: 18 },
  rpcUrls: { default: { http: [...HEGOTA.rpcUrls] } },
});

let pub: PublicClient | undefined;
function publicClient(): PublicClient {
  if (!pub) pub = createPublicClient({ chain, transport: http(RPC) });
  return pub;
}

// ABI-encode a packed ML-DSA public key into the ZKNOX inline-verifier shape (same shape the
// on-chain verifier expects, byte-exact with the spike's pkEncOf).
function pkEncOf(pk: Uint8Array): Hex {
  const { aHat, tr, t1 } = mldsa44.expandPk(pk);
  return encodeAbiParameters(
    [{ type: "uint256[][][]" }, { type: "bytes" }, { type: "uint256[][]" }],
    [aHat, toHex(tr), t1],
  );
}

// Derive the ML-DSA material from the PRF. The SecretParts (sk) stays in this function's
// callers inside the worker and is never returned over Comlink.
function deriveKey(prf: Uint8Array) {
  if (prf.length !== 32) throw new Error("prf root must be 32 bytes");
  const { publicKey, sk } = dilithium44.keygen(mldsaSeed(prf));
  const pkEnc = pkEncOf(publicKey);
  return { publicKey, sk, pkEnc, commit: keccak256(pkEnc) as Hex };
}

// Derive the base ML-DSA SecretParts (same seed/domain as deriveKey) plus the ML-KEM-512
// discovery meta (its own domain). Both come from the one PRF root; nothing leaves the worker.
function deriveStealth(prf: Uint8Array) {
  if (prf.length !== 32) throw new Error("prf root must be 32 bytes");
  const base = dilithium44.keygen(mldsaSeed(prf)).sk;
  const meta = dksap.genMeta(seedFor(MLKEM_DOMAIN, prf));
  return { base, meta };
}

// Deterministic placement of the account for a given key commitment (pure; no network).
function placementFor(commit: Hex): { address: Hex; initcode: Hex; salt: Hex } {
  if (!factory || !verifier) throw new Error("rail singletons (factory/verifier) not set");
  return deriveCreate2({ factory, commit, verifier, accountBin: ACCOUNT_PQ_BIN });
}

export interface PqAccount {
  level: "ML-DSA-44";
  publicKeyBytes: number; // 1312
  signatureBytes: number; // 2420
  commit: Hex;
  address: Hex; // deterministic CREATE2 address of the AccountPQ
}

export interface PqAccountStatus {
  deployed: boolean;
  balanceWei: string; // stringified bigint (Comlink-safe)
}

export interface PqSpendResult {
  address: Hex;
  deployTxHash?: Hex; // present only if the account had to be deployed (first spend)
  spendTxHash: Hex;
  decoded: { deploy?: FrameTxDesc; spend: FrameTxDesc }; // human-readable frame anatomy (teaching)
}

// The displayable stealth meta-address. For now this is just the ML-KEM encapsulation key
// (the "viewing" half) as hex; the full external meta-address format is a later phase.
export interface PqStealthMeta {
  metaAddress: Hex;
}

// Result of resolving @nick against the pay-by-nick directory (EIP-8272 recent roots).
// `ok`: the DirectoryResolver authenticated the directory's recent root at 0x8272 and the
// merkle membership of this nick, storage-free. `reason` explains a miss.
export interface PqNickResolution {
  ok: boolean;
  name: string;
  meta?: Hex;      // the directory's meta-address for the nick
  address?: Hex;   // display/payout address derived from meta (last 20 bytes)
  slot?: number;   // the slot the current root was published at (freshness proof)
  reason?: "unknown-nick" | "no-resolver" | "stale-root" | "rejected";
}

// A one-time stealth payment to self: the derived stealth address plus the OFF-CHAIN ticket
// (ML-KEM ciphertext + view tag) the recipient needs to recover and spend it.
export interface PqStealthPayment {
  stealthAddress: Hex;
  ct: Hex;
  viewTag: Hex;
}

// A serialisable, human-readable decode of an EIP-8141 frame-tx, so the UI can SHOW what a
// self-pay spend actually is (its frames and the inline ML-DSA signature) vs a 4337 UserOp.
export interface FrameDesc {
  index: number; mode: string; flags: string; target: string;
  executionGas: number; stateGas: number; valueWei: string; note: string;
}
export interface FrameTxDesc {
  label: string; type: string; sender: Hex; nonce: string; chainId: number;
  frames: FrameDesc[]; signature: string;
}

const MODE_NAME: Record<number, string> = { [MODE_DEFAULT]: "DEFAULT", [MODE_VERIFY]: "VERIFY", [MODE_SENDER]: "SENDER" };
function flagName(f: number): string {
  if (f === FLAG_ATOMIC_BATCH) return "ATOMIC_BATCH";
  if (f === FLAG_APPROVE_EXECUTION_AND_PAYMENT) return "APPROVE exec+payment";
  if (f === FLAG_NONE) return "none";
  return `0x${f.toString(16)}`;
}
function frameNote(mode: number, flags: number, hasData: boolean, sponsored: boolean): string {
  if (mode === MODE_VERIFY) return sponsored ? "sponsor approves execution + pays this tx's gas" : "the account approves execution + pays its own gas";
  if (mode === MODE_DEFAULT && hasData) return "calls the CREATE2 factory to deploy the account";
  if (mode === MODE_DEFAULT && flags === FLAG_ATOMIC_BATCH) return "verifies the ML-DSA signature (atomic batch: a bad sig skips the spend)";
  if (mode === MODE_SENDER) return "the account itself moves the value to the recipient";
  return "";
}
function describeFrameTx(tx: FrameTx, label: string): FrameTxDesc {
  const sponsored = label.toLowerCase().includes("deploy");
  const sig = tx.signatures[0]?.signature;
  return {
    label,
    type: "0x06 (frame-tx)",
    sender: tx.sender as Hex,
    nonce: tx.nonce.toString(),
    chainId: Number(tx.chainId),
    frames: tx.frames.map((f, i) => ({
      index: i,
      mode: MODE_NAME[f.mode] ?? String(f.mode),
      flags: flagName(f.flags),
      target: f.target ?? "self (the sender)",
      executionGas: Number(f.executionGas),
      stateGas: Number(f.stateGas),
      valueWei: (f.value ?? 0).toString(),
      note: frameNote(f.mode, f.flags, !!f.data && f.data !== "0x", sponsored),
    })),
    signature: sig && sig !== "0x"
      ? "ARBITRARY: ML-DSA-44 — public key (1312 B) + signature (2420 B), inline in calldata"
      : "ARBITRARY: empty — the open on-chain sponsor approves, no signature needed",
  };
}

const api = {
  // Derive the rail account's PQ identity (and its deterministic address) from the PRF root.
  deriveAccount(prf: Uint8Array): PqAccount {
    const { publicKey, commit } = deriveKey(prf);
    const { address } = placementFor(commit);
    return { level: "ML-DSA-44", publicKeyBytes: publicKey.length, signatureBytes: 2420, commit, address };
  },

  // On-chain status read from the PUBLIC address (no PRF needed on the main thread).
  async readStatus(address: Hex): Promise<PqAccountStatus> {
    const client = publicClient();
    const [code, balance] = await Promise.all([client.getCode({ address }), client.getBalance({ address })]);
    return { deployed: !!code && code !== "0x", balanceWei: balance.toString() };
  },

  // FASE 2.3 pay-by-nick: resolve @nick -> meta-address, OFF-CHAIN, gated by EIP-8272 recent
  // roots. No PRF, no gas, no storage read: the directory's merkle root is authenticated by a
  // recent-root reference at 0x8272. We first FIND the slot the current root was published at
  // (scan a short recent window of 0x8272 storage, so nothing hardcodes an ephemeral slot),
  // then let the DirectoryResolver (view call) re-validate freshness + prove merkle membership.
  async resolveNick(name: string, scanDepth = 400): Promise<PqNickResolution> {
    const hit = lookupNick(name);
    if (!hit) return { ok: false, name, reason: "unknown-nick" };
    if (!directoryResolver) return { ok: false, name: hit.name, reason: "no-resolver" };
    const client = publicClient();

    // Locate the publish slot: entry_hash(src, slot, root) must be stored at storage_key(src, slot).
    // The ring is mod RING but entry_hash binds the FULL slot, so a wrapped old entry never matches.
    const current = Number(BigInt(
      (await rpc<{ slotNumber: Hex }>(RPC, "eth_getBlockByNumber", ["latest", false])).slotNumber,
    ));
    const lowest = Math.max(0, current - scanDepth);
    let slot = -1;
    // Newest-first, batched so a recently published root resolves in one round-trip.
    for (let top = current - 1; top >= lowest && slot < 0; top -= 50) {
      const slots: number[] = [];
      for (let s = top; s > top - 50 && s >= lowest; s--) slots.push(s);
      const stored = await Promise.all(slots.map((s) =>
        rpc<Hex>(RPC, "eth_getStorageAt", [RECENT_ROOT, storageKey(DIRECTORY_SRC, s), "latest"])));
      for (let i = 0; i < slots.length; i++) {
        if (BigInt(stored[i]!) === BigInt(entryHash(DIRECTORY_SRC, slots[i]!, DIRECTORY_ROOT))) { slot = slots[i]!; break; }
      }
    }
    if (slot < 0) return { ok: false, name: hit.name, reason: "stale-root" };

    // Authenticate on-chain: resolve() STATICCALLs 0x8272 (recency) + checks the merkle proof.
    const data = resolveCalldata(DIRECTORY_SRC, slot, DIRECTORY_ROOT, hit.nick, hit.meta, hit.proof);
    try {
      await client.call({ to: directoryResolver, data });
    } catch {
      return { ok: false, name: hit.name, reason: "rejected" };
    }
    return { ok: true, name: hit.name, meta: hit.meta, address: hit.address, slot };
  },

  // FASE 1.2 path A: deploy-if-needed (sponsored) + self-pay ML-DSA spend of `valueWei` to
  // `to`. The user funds nothing; the sponsor pays the one-time deploy, the account pays its
  // own spend from its received balance.
  async spend(prf: Uint8Array, to: Hex, valueWei: string): Promise<PqSpendResult> {
    if (!openSponsor) throw new Error("no open sponsor configured for this network");
    if (!verifier) throw new Error("no verifier configured for this network");
    const client = publicClient();
    // The verifier is an assumed singleton: error (never auto-deploy) if a reset wiped it.
    if (!(await client.getCode({ address: verifier }))) throw new Error(`verifier ${verifier} not deployed (devnet reset? re-anchor)`);

    const { sk, pkEnc, commit } = deriveKey(prf);
    const { address, initcode, salt } = placementFor(commit);
    const fees = await networkFees(RPC);

    // The account self-pays the spend gas (pre-paid at the declared frame limit) plus the value.
    // SWEEP (valueWei === "max"): send the whole balance minus that gas reserve, so the account
    // tends to 0 (at most the unused gas reserve is left as dust; it can never go negative/fail).
    const reserve = SELF_PAY_GAS_RESERVE * fees.maxFeePerGas;
    const balance = await client.getBalance({ address });
    const value = valueWei === "max" ? balance - reserve : BigInt(valueWei);
    if (valueWei === "max" && value <= 0n) {
      throw new Error(
        `account ${address} balance ${(Number(balance) / 1e18).toFixed(4)} ${HEGOTA.symbol} ` +
          `is below the ~${(Number(reserve) / 1e18).toFixed(4)} gas reserve; nothing to sweep`,
      );
    }
    if (balance < value + reserve) {
      throw new Error(
        `account ${address} needs ~${(Number(value + reserve) / 1e18).toFixed(4)} ${HEGOTA.symbol} ` +
          `(has ${(Number(balance) / 1e18).toFixed(4)}); receive funds first`,
      );
    }

    // TX1: sponsored deploy, only if the account has no code yet.
    let deployTxHash: Hex | undefined;
    let deployDesc: FrameTxDesc | undefined;
    if (!(await client.getCode({ address }))) {
      const nonce = BigInt(await rpc<Hex>(RPC, "eth_getTransactionCount", [openSponsor, "latest"]));
      const tx1: FrameTx = {
        chainId: HEGOTA.chainId, nonce, sender: openSponsor,
        frames: [
          { mode: MODE_VERIFY, flags: FLAG_APPROVE_EXECUTION_AND_PAYMENT, target: null, executionGas: 80_000, stateGas: 50_000, value: 0 },
          { mode: MODE_DEFAULT, flags: FLAG_NONE, target: factory!, executionGas: 1_000_000, stateGas: 1_000_000, value: 0, data: factoryDeployCalldata(salt, initcode) },
        ],
        signatures: [{ scheme: SCHEME_ARBITRARY, signer: null, msg: "0x", signature: "0x" }],
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas, maxFeePerGas: fees.maxFeePerGas, maxFeePerBlobGas: 0,
        feeNested: true, omitRecentRoots: true,
      };
      deployDesc = describeFrameTx(tx1, "sponsored deploy");
      deployTxHash = await sendFrameTx(RPC, encode(tx1));
      const drc = await waitReceipt(RPC, deployTxHash);
      if (drc.status !== "0x1") throw new Error("sponsored deploy (TX1) failed");
    }

    // TX2: self-pay spend. The account approves paying its own gas, verifies ML-DSA, and the
    // SENDER frame moves `value` to `to` (skipped if the verify fails, via the atomic batch).
    const nonce2 = BigInt(await rpc<Hex>(RPC, "eth_getTransactionCount", [address, "latest"]));
    const tx2: FrameTx = {
      chainId: HEGOTA.chainId, nonce: nonce2, sender: address,
      frames: [
        { mode: MODE_VERIFY, flags: FLAG_APPROVE_EXECUTION_AND_PAYMENT, target: null, executionGas: 50_000, stateGas: 45_000, value: 0 },
        { mode: MODE_DEFAULT, flags: FLAG_ATOMIC_BATCH, target: null, executionGas: 15_800_000, stateGas: 400_000, value: 0 },
        { mode: MODE_SENDER, flags: FLAG_NONE, target: to, executionGas: 300_000, stateGas: 200_000, value },
      ],
      signatures: [{ scheme: SCHEME_ARBITRARY, signer: null, msg: "0x", signature: "0x" }],
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas, maxFeePerGas: fees.maxFeePerGas, maxFeePerBlobGas: 0,
      feeNested: true, omitRecentRoots: true,
    };
    const sig = dilithium44.sign(sk, hexToBytes(sigHash(tx2)));
    tx2.signatures[0]!.signature = concat([pkEnc, toHex(sig)]);
    const spendDesc = describeFrameTx(tx2, "self-pay spend");
    const spendTxHash = await sendFrameTx(RPC, encode(tx2));
    const src = await waitReceipt(RPC, spendTxHash);
    if (src.status !== "0x1") throw new Error("self-pay spend (TX2) failed");

    return { address, deployTxHash, spendTxHash, decoded: { deploy: deployDesc, spend: spendDesc } };
  },

  // STEALTH (privacy=true). Displayable meta-address: the ML-KEM encapsulation key (hex) the
  // UI shows/shortens. The full external meta-address format is a later phase.
  stealthMeta(prf: Uint8Array): PqStealthMeta {
    const { meta } = deriveStealth(prf);
    return { metaAddress: toHex(meta.encapsulationKey) };
  },

  // STEALTH sender-to-self: derive a fresh one-time stealth address for an incoming payment,
  // plus the off-chain ticket {ct, viewTag} the recipient side needs to recover + spend it.
  stealthNewPayment(prf: Uint8Array): PqStealthPayment {
    const { base, meta } = deriveStealth(prf);
    const ann = dksap.senderDerive(meta.encapsulationKey);
    const stealthPk = stealth44.senderStealthPk(base.rho, base.t, ann.sharedSecret);
    const commit = keccak256(pkEncOf(stealthPk)) as Hex;
    const { address } = placementFor(commit);
    return { stealthAddress: address, ct: toHex(ann.cipherText), viewTag: toHex(ann.viewTag) };
  },

  // STEALTH recipient side (mirrors the spike's TX1+TX2): recover the ML-KEM shared secret
  // from the ticket, form the BLINDED ML-DSA signing key + the SAME stealth address, then
  // deploy-if-needed (sponsored) and self-pay with a BLINDED signature (inline blinded pk).
  async stealthSpend(prf: Uint8Array, ct: Hex, viewTag: Hex, to: Hex, valueWei: string): Promise<PqSpendResult> {
    if (!openSponsor) throw new Error("no open sponsor configured for this network");
    if (!verifier) throw new Error("no verifier configured for this network");
    const client = publicClient();
    if (!(await client.getCode({ address: verifier }))) throw new Error(`verifier ${verifier} not deployed (devnet reset? re-anchor)`);

    const { base, meta } = deriveStealth(prf);
    const ss = dksap.recipientRecover(meta.decapsulationKey, hexToBytes(ct), hexToBytes(viewTag));
    if (ss === null) throw new Error("ticket does not belong to this account (viewTag/ct mismatch)");

    const { sk: blinded, signK } = stealth44.recipientBlindedKey(base, ss);
    const stealthPk = stealth44.senderStealthPk(base.rho, base.t, ss);
    const pkEnc = pkEncOf(stealthPk);
    const commit = keccak256(pkEnc) as Hex;
    const { address, initcode, salt } = placementFor(commit);
    const fees = await networkFees(RPC);

    // The account self-pays the spend gas (pre-paid at the declared frame limit) plus the value.
    // SWEEP (valueWei === "max"): send the whole balance minus that gas reserve, so the stealth
    // address tends to 0 (at most the unused gas reserve is left as dust; never negative/fails).
    const reserve = SELF_PAY_GAS_RESERVE * fees.maxFeePerGas;
    const balance = await client.getBalance({ address });
    const value = valueWei === "max" ? balance - reserve : BigInt(valueWei);
    if (valueWei === "max" && value <= 0n) {
      throw new Error(
        `stealth account ${address} balance ${(Number(balance) / 1e18).toFixed(4)} ${HEGOTA.symbol} ` +
          `is below the ~${(Number(reserve) / 1e18).toFixed(4)} gas reserve; nothing to sweep`,
      );
    }
    if (balance < value + reserve) {
      throw new Error(
        `stealth account ${address} needs ~${(Number(value + reserve) / 1e18).toFixed(4)} ${HEGOTA.symbol} ` +
          `(has ${(Number(balance) / 1e18).toFixed(4)}); receive funds first`,
      );
    }

    // TX1: sponsored deploy, only if the stealth account has no code yet (same frames as spend()).
    let deployTxHash: Hex | undefined;
    let deployDesc: FrameTxDesc | undefined;
    if (!(await client.getCode({ address }))) {
      const nonce = BigInt(await rpc<Hex>(RPC, "eth_getTransactionCount", [openSponsor, "latest"]));
      const tx1: FrameTx = {
        chainId: HEGOTA.chainId, nonce, sender: openSponsor,
        frames: [
          { mode: MODE_VERIFY, flags: FLAG_APPROVE_EXECUTION_AND_PAYMENT, target: null, executionGas: 80_000, stateGas: 50_000, value: 0 },
          { mode: MODE_DEFAULT, flags: FLAG_NONE, target: factory!, executionGas: 1_000_000, stateGas: 1_000_000, value: 0, data: factoryDeployCalldata(salt, initcode) },
        ],
        signatures: [{ scheme: SCHEME_ARBITRARY, signer: null, msg: "0x", signature: "0x" }],
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas, maxFeePerGas: fees.maxFeePerGas, maxFeePerBlobGas: 0,
        feeNested: true, omitRecentRoots: true,
      };
      deployDesc = describeFrameTx(tx1, "sponsored deploy");
      deployTxHash = await sendFrameTx(RPC, encode(tx1));
      const drc = await waitReceipt(RPC, deployTxHash);
      if (drc.status !== "0x1") throw new Error("sponsored deploy (TX1) failed");
    }

    // TX2: self-pay spend, signed with the BLINDED key (same 3 frames as spend(); inline blinded pk).
    const nonce2 = BigInt(await rpc<Hex>(RPC, "eth_getTransactionCount", [address, "latest"]));
    const tx2: FrameTx = {
      chainId: HEGOTA.chainId, nonce: nonce2, sender: address,
      frames: [
        { mode: MODE_VERIFY, flags: FLAG_APPROVE_EXECUTION_AND_PAYMENT, target: null, executionGas: 50_000, stateGas: 45_000, value: 0 },
        { mode: MODE_DEFAULT, flags: FLAG_ATOMIC_BATCH, target: null, executionGas: 15_800_000, stateGas: 400_000, value: 0 },
        { mode: MODE_SENDER, flags: FLAG_NONE, target: to, executionGas: 300_000, stateGas: 200_000, value },
      ],
      signatures: [{ scheme: SCHEME_ARBITRARY, signer: null, msg: "0x", signature: "0x" }],
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas, maxFeePerGas: fees.maxFeePerGas, maxFeePerBlobGas: 0,
      feeNested: true, omitRecentRoots: true,
    };
    const sig = dilithium44.sign(blinded, hexToBytes(sigHash(tx2)), new Uint8Array(0), new Uint8Array(32), stealth44.BETA_BLINDED, signK);
    tx2.signatures[0]!.signature = concat([pkEnc, toHex(sig)]);
    const spendDesc = describeFrameTx(tx2, "self-pay spend");
    const spendTxHash = await sendFrameTx(RPC, encode(tx2));
    const src = await waitReceipt(RPC, spendTxHash);
    if (src.status !== "0x1") throw new Error("blinded self-pay spend (TX2) failed");

    return { address, deployTxHash, spendTxHash, decoded: { deploy: deployDesc, spend: spendDesc } };
  },
};

export type PqWorkerApi = typeof api;
Comlink.expose(api);
