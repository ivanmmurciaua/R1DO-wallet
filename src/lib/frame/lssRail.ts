// Hegota rail, leanSphincs-s path (hash-based post-quantum signatures, gas paid by a keyless paymaster).
//
// Keys: every key is a leanSphincs-s (b = 13, Light tier) key from a 32-byte seed derived from the
// passkey PRF root with the rail's seedFor primitive and a tag that pins b:
//   transparent account   "r1do/hegota/lss/b13/v1"
//   stealth key secret    "r1do/hegota/lss/stealth-key/b13/v1"
//   ML-KEM meta keys      "r1do/hegota/mlkem768/v1" (railCore mlkemMeta: same tag as the ML-DSA-44 rail,
//                         so the user has ONE meta-address whatever the scheme)
// A stealth account's seed is shake256(utf8("r1do/hegota/lss/stealth/b13/v1/ss") || secret || ss, 32),
// with ss the ML-KEM shared secret of its ticket.
// ONE SEED = ONE b: never change b for these tags (a new b needs a new tag and gives new addresses).
// The secret key (it contains the seed) never leaves this module's caller, the Web Worker; only
// public material (address, pk words) and signed txs come out.
//
// Account: SphincsFrameAccountS at a deterministic CREATE2 address (keys in storage, so the whole
// class shares one runtime codehash). A spend is up to two frame-txs, with NO EOA in the flow:
//   TX1 (only if not yet deployed) sender = open sponsor, which pays; a DEFAULT frame deploys the
//       account through the factory. Needed before TX2: EXTCODEHASH of an empty account never
//       matches the paymaster's gate.
//   TX2 sponsored spend: [VERIFY account 0x2 (approve execution, leanSphincs-s witness #0)]
//       [VERIFY paymaster 0x1 (keyless: approve payment iff EXTCODEHASH(sender) == class hash)]
//       [SENDER to value]. The account pays ZERO gas, so "send all" moves the whole balance.
//   Fallback: self-pay [VERIFY account 0x3][SENDER] when the paymaster is missing (no code), does
//       not gate this account class, or is underfunded (balance below the sponsored gas bound). The
//       account then pays its own gas. railCore's railModeFor() decides this (with this class's
//       paymaster, class hash and gas bound), for railStatus() and the spend alike.
//
// Stealth: each payment gets a FRESH one-time account from an ML-KEM ticket. The wallet encapsulates
// to its own encapsulation key (random r inside ML-KEM), keeps the ticket {ct, viewTag} off-chain and
// derives the account from the shared secret ss. Spending decapsulates the ticket again. The ticket is
// the ONLY record of which ss (hence which account) was used: without it the passkey cannot find the
// account, so the store must keep it (and the user should back it up).
//
// Bundle isolation: this is the only importer of engine/leansphincs.ts, and only pq.worker.ts (and a
// headless test) imports this module, so the base64 wasm stays in the worker chunk.
import { concat, hexToBytes, pad, toFunctionSelector, toHex, type Hex } from "viem";
import { shake256 } from "@noble/hashes/sha3";
import { lssKeygen, lssPublicKey, lssSign, LSS_SIG_BYTES, LSS_SIGNATURE_BUDGET } from "./engine/leansphincs";
import { deriveLssAccount } from "./engine/account";
import { dksap } from "./engine/index";
import { LSS_ACCOUNT_S_BIN } from "./engine/bin";
import {
  MODE_VERIFY, MODE_SENDER, FLAG_APPROVE_EXECUTION, FLAG_APPROVE_PAYMENT, FLAG_APPROVE_EXECUTION_AND_PAYMENT,
  FLAG_NONE, SCHEME_ARBITRARY, sigHash, type FrameTx,
} from "./engine/frametx";
import { type Fees } from "./engine/submit";
import { HEGOTA } from "./network";
import {
  S, publicClient, hasCode, nonceOf, fmtEth, seedFor, describeFrameTx, sendAndWait, ensureDeployed, codehashOf,
  railModeFor, fallbackWhy, payerRoleOf, mlkemMeta, DEPLOY_GAS_LSS, signaturesUsedOf,
  type PqAccountStatus, type PqSpendResult, type PqAccount, type PqStealthMeta, type PqStealthPayment,
  type PqRailStatus, type RailMode, type PqSendEventCb,
} from "./railCore";

// The shared rail types live in railCore (both account classes use them); re-exported for callers
// that import them from here.
export type { PqAccount, PqStealthMeta, PqStealthPayment, PqRailStatus, PqFallbackReason } from "./railCore";

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

export const LSS_TAG = "r1do/hegota/lss/b13/v1";
export const LSS_STEALTH_KEY_TAG = "r1do/hegota/lss/stealth-key/b13/v1";
const LSS_STEALTH_SS_TAG = "r1do/hegota/lss/stealth/b13/v1/ss";

/** Signature budget of a b=13 (Light) key; the account's on-chain nonce counts signatures used. */
export const SIGNATURE_BUDGET = LSS_SIGNATURE_BUDGET;
export const BUDGET_WARN = Math.floor(SIGNATURE_BUDGET * 0.8);
export const BUDGET_BLOCK = Math.floor(SIGNATURE_BUDGET * 0.95);

// verifyFrameAndApprove(uint256 sigIndex): the account's VERIFY entry point; the APPROVE scope
// comes from the frame flags (0x2 exec, 0x3 exec+payment).
const SEL_VERIFY_IDX = toFunctionSelector("verifyFrameAndApprove(uint256)");
const VERIFY_DATA = concat([SEL_VERIFY_IDX, pad("0x00", { size: 32 })]);
// A fresh recipient costs new-account state gas (120 * 1530 on 8141); unused gas is refunded.
const NEW_ACCOUNT_STATE_GAS = 183_600;

// Frame gas, from the green on-chain runs (VERIFY account ~55K used, paymaster ~3K, SENDER 3K).
const G_VERIFY_ACCOUNT = { executionGas: 300_000, stateGas: 0 };
const G_VERIFY_PAYMASTER = { executionGas: 100_000, stateGas: 50_000 };
const G_SENDER = { executionGas: 30_000, stateGas: NEW_ACCOUNT_STATE_GAS };
// Upper bound used only for the paymaster balance check (frame gas + intrinsic + ~4.2 KB calldata).
const SPONSORED_GAS_BOUND = 1_000_000n;
// Self-pay reserve. The account is charged maxFeePerGas * (intrinsic + every frame's declared
// execution + state gas) UP FRONT, before SENDER moves the value, and refunded the unused part after.
// So a "send all" must hold back exactly that, at the same maxFeePerGas the tx carries. The frame
// part is summed from the constants the self-pay tx is built with (it cannot drift from them); the
// intrinsic part is bounded from mined self-pay receipts: gasUsed 471,642 minus frame use (55,103 +
// 3,000 + 183,600 state) = 229,939 (txs 0xba6ebe37... and 0xa6590bab..., both 471,642: the ~4.2 KB
// witness hits the calldata floor, so it does not vary with the signature). 300K is a ~30% margin.
const SELF_PAY_INTRINSIC_BOUND = 300_000n;
const SELF_PAY_FRAME_GAS = BigInt(
  G_VERIFY_ACCOUNT.executionGas + G_VERIFY_ACCOUNT.stateGas + G_SENDER.executionGas + G_SENDER.stateGas,
); // 513,600
const SELF_PAY_GAS_BOUND = SELF_PAY_FRAME_GAS + SELF_PAY_INTRINSIC_BOUND; // 813,600

// ---------------------------------------------------------------------------------------------
// Key material
// ---------------------------------------------------------------------------------------------

interface LssPublic { address: Hex; initcode: Hex; salt: Hex; pkSeed: Hex; pkRoot: Hex }
interface LssMaterial extends LssPublic { key: Uint8Array }

function singletons() {
  const { accountFactory, lssVerifier, lssFrameModule } = S;
  if (!accountFactory || !lssVerifier || !lssFrameModule) throw new Error("rail singletons (factory / leanSphincs verifier / frame module) not set");
  return { accountFactory, lssVerifier, lssFrameModule };
}

// PUBLIC material cache (address + pk words), keyed by a hash of the seed. Keygen is ~1 s on
// desktop (2-4x on a phone), so re-deriving an address we already know is skipped. The SECRET key
// is never cached: every signing action re-derives it from a fresh passkey tap.
const pubCache = new Map<string, LssPublic>();
const seedId = (seed: Uint8Array): string => toHex(seedFor("r1do/hegota/lss/cache-id", seed));

function placeFromKey(key: Uint8Array): LssPublic {
  const { accountFactory, lssVerifier, lssFrameModule } = singletons();
  const pk = lssPublicKey(key);
  const pkSeed = toHex(pk.pkSeed), pkRoot = toHex(pk.pkRoot);
  const placed = deriveLssAccount({
    factory: accountFactory, accountBin: LSS_ACCOUNT_S_BIN, pkSeed, pkRoot,
    verifier: lssVerifier, frameModule: lssFrameModule,
  });
  return { ...placed, pkSeed, pkRoot };
}

function publicFor(seed: Uint8Array): LssPublic {
  const id = seedId(seed);
  const hit = pubCache.get(id);
  if (hit) return hit;
  const pub = placeFromKey(lssKeygen(seed));
  pubCache.set(id, pub);
  return pub;
}

function materialFor(seed: Uint8Array): LssMaterial {
  const key = lssKeygen(seed);
  const pub = placeFromKey(key);
  pubCache.set(seedId(seed), pub);
  return { ...pub, key };
}

const transparentSeed = (prf: Uint8Array): Uint8Array => seedFor(LSS_TAG, prf);

/** Per-payment stealth seed from the ticket's ML-KEM shared secret. ONE SEED = ONE b still applies.
    The PRF-derived secret is included so knowing ss alone never yields the key. */
function stealthSeed(prf: Uint8Array, ss: Uint8Array): Uint8Array {
  if (ss.length !== 32) throw new Error("ML-KEM shared secret must be 32 bytes");
  const secret = seedFor(LSS_STEALTH_KEY_TAG, prf);
  const domain = new TextEncoder().encode(LSS_STEALTH_SS_TAG);
  const buf = new Uint8Array(domain.length + secret.length + ss.length);
  buf.set(domain, 0);
  buf.set(secret, domain.length);
  buf.set(ss, domain.length + secret.length);
  return shake256(buf, { dkLen: 32 });
}

// ---------------------------------------------------------------------------------------------
// Tx builders
// ---------------------------------------------------------------------------------------------

function buildSponsoredSpend(account: Hex, paymaster: Hex, nonce: bigint, to: Hex, value: bigint, fees: Fees): FrameTx {
  return {
    chainId: HEGOTA.chainId, nonce, sender: account,
    frames: [
      { mode: MODE_VERIFY, flags: FLAG_APPROVE_EXECUTION, target: account, ...G_VERIFY_ACCOUNT, value: 0, data: VERIFY_DATA },
      { mode: MODE_VERIFY, flags: FLAG_APPROVE_PAYMENT, target: paymaster, ...G_VERIFY_PAYMASTER, value: 0 },
      { mode: MODE_SENDER, flags: FLAG_NONE, target: to, ...G_SENDER, value },
    ],
    // Both witnesses keep an EMPTY msg so their bytes are elided from the canonical sig_hash.
    // [0] = leanSphincs-s signature (read by verifyFrameAndApprove(0)); [1] = empty (paymaster).
    signatures: [
      { scheme: SCHEME_ARBITRARY, signer: null, msg: "0x", signature: "0x" },
      { scheme: SCHEME_ARBITRARY, signer: null, msg: "0x", signature: "0x" },
    ],
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas, maxFeePerGas: fees.maxFeePerGas, maxFeePerBlobGas: 0,
    feeNested: true, omitRecentRoots: true,
  };
}

function buildSelfPaySpend(account: Hex, nonce: bigint, to: Hex, value: bigint, fees: Fees): FrameTx {
  return {
    chainId: HEGOTA.chainId, nonce, sender: account,
    frames: [
      { mode: MODE_VERIFY, flags: FLAG_APPROVE_EXECUTION_AND_PAYMENT, target: account, ...G_VERIFY_ACCOUNT, value: 0, data: VERIFY_DATA },
      { mode: MODE_SENDER, flags: FLAG_NONE, target: to, ...G_SENDER, value },
    ],
    signatures: [{ scheme: SCHEME_ARBITRARY, signer: null, msg: "0x", signature: "0x" }],
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas, maxFeePerGas: fees.maxFeePerGas, maxFeePerBlobGas: 0,
    feeNested: true, omitRecentRoots: true,
  };
}

/** Sign witness #0 over the canonical sig_hash. Deterministic: a retry of the same tx re-produces
    the same signature (no extra budget use). The hash must not move when the witness is inserted. */
function signWitness0(tx: FrameTx, key: Uint8Array): void {
  const h = sigHash(tx);
  const sig = lssSign(key, hexToBytes(h));
  if (sig.length !== LSS_SIG_BYTES) throw new Error("unexpected leanSphincs-s signature size");
  tx.signatures[0]!.signature = toHex(sig);
  if (sigHash(tx) !== h) throw new Error("sig_hash moved after inserting the witness (codec bug)");
}

// ---------------------------------------------------------------------------------------------
// Paymaster / rail status
// ---------------------------------------------------------------------------------------------

/** This class's mode: its own paymaster, class hash and gas bound through the shared rule. */
const railMode = (): Promise<RailMode> => railModeFor(S.lssPaymaster, S.lssAccountCodehash, SPONSORED_GAS_BOUND);

export async function railStatus(): Promise<PqRailStatus> {
  const { paymaster, balance, sponsored, fallbackReason } = await railMode();
  return {
    scheme: "leanSphincs-s",
    paymaster,
    paymasterBalanceWei: balance.toString(),
    mode: sponsored ? "sponsored" : "self-pay",
    fallbackReason,
    signatureBudget: SIGNATURE_BUDGET,
    budgetWarn: BUDGET_WARN,
    budgetBlock: BUDGET_BLOCK,
  };
}

export async function readStatus(address: Hex): Promise<PqAccountStatus> {
  const client = publicClient();
  const [code, balance, nonce] = await Promise.all([client.getCode({ address }), client.getBalance({ address }), nonceOf(address)]);
  const deployed = hasCode(code);
  return { deployed, balanceWei: balance.toString(), nonce: Number(nonce), signaturesUsed: Number(signaturesUsedOf(nonce, deployed)) };
}

// ---------------------------------------------------------------------------------------------
// Spend (shared by transparent and stealth)
// ---------------------------------------------------------------------------------------------

async function spendWith(seed: Uint8Array, to: Hex, valueWei: string, who: string, onEvent?: PqSendEventCb): Promise<PqSpendResult> {
  const client = publicClient();
  const { lssVerifier, lssFrameModule } = singletons();
  // Assumed singletons: error (never auto-deploy) if a devnet reset wiped them.
  const [vCode, mCode] = await Promise.all([client.getCode({ address: lssVerifier }), client.getCode({ address: lssFrameModule })]);
  if (!hasCode(vCode)) throw new Error(`leanSphincs verifier ${lssVerifier} not deployed (devnet reset? re-anchor)`);
  if (!hasCode(mCode)) throw new Error(`frame module ${lssFrameModule} not deployed (devnet reset? re-anchor)`);

  // Mode: the same rule railStatus() shows (sponsored, or self-pay on missing / not-gated / underfunded).
  const pm = await railMode();
  const { fees, sponsored, fallbackReason } = pm;

  const k = materialFor(seed);
  const address = k.address;
  const [balance, nonce, code0] = await Promise.all([client.getBalance({ address }), nonceOf(address), client.getCode({ address })]);

  const used = signaturesUsedOf(nonce, hasCode(code0));
  if (used >= BigInt(BUDGET_BLOCK)) {
    throw new Error(`${who} has used ${used} of ~${SIGNATURE_BUDGET} leanSphincs-s signatures; move the funds to a new account`);
  }

  let value: bigint;
  if (sponsored) {
    // The account pays ZERO gas: a sweep moves the whole balance, no dust.
    value = valueWei === "max" ? balance : BigInt(valueWei);
    if (value <= 0n) throw new Error(`${who} ${address} has nothing to send (balance ${fmtEth(balance)})`);
    if (balance < value) throw new Error(`${who} ${address} has ${fmtEth(balance)}, needs ${fmtEth(value)}; receive funds first`);
  } else {
    const why = fallbackWhy(pm);
    const reserve = SELF_PAY_GAS_BOUND * fees.maxFeePerGas;
    value = valueWei === "max" ? balance - reserve : BigInt(valueWei);
    if (value <= 0n) throw new Error(`${who} ${address} balance ${fmtEth(balance)} is below the ~${fmtEth(reserve)} self-pay gas reserve (${why}, self-pay fallback)`);
    if (balance < value + reserve) throw new Error(`${who} ${address} needs ~${fmtEth(value + reserve)} (has ${fmtEth(balance)}, ${why}, self-pay fallback); receive funds first`);
  }

  // TX1: sponsored deploy, only if the account has no code yet.
  const dep = await ensureDeployed(address, k.salt, k.initcode, fees, DEPLOY_GAS_LSS, onEvent);

  // Sponsored only: the paymaster gates on the runtime codehash, so check it before signing and a
  // mismatch is a clear error instead of a raw validation-prefix rejection. Self-pay needs no gate.
  if (sponsored) {
    const ch = await codehashOf(address);
    if (!ch || ch.toLowerCase() !== S.lssAccountCodehash!.toLowerCase()) {
      throw new Error(`account ${address} code does not match the paymaster gate (codehash ${ch ?? "none"})`);
    }
  }

  // TX2: the spend. Re-read the nonce (unchanged by TX1, whose sender is the sponsor).
  const nonce2 = await nonceOf(address);
  const tx2 = sponsored
    ? buildSponsoredSpend(address, pm.paymaster!, nonce2, to, value, fees)
    : buildSelfPaySpend(address, nonce2, to, value, fees);
  signWitness0(tx2, k.key);
  const label = sponsored ? "sponsored spend (leanSphincs-s)" : `self-pay spend (leanSphincs-s, fallback: paymaster ${fallbackReason})`;
  const spendDesc = describeFrameTx(tx2, label, "lss");
  const { hash, payer } = await sendAndWait(tx2, `${label} (TX2)`, onEvent);
  const paidBy = payer ?? (sponsored ? pm.paymaster! : address);
  spendDesc.onchain = { txHash: hash, payer: paidBy, payerRole: payerRoleOf(paidBy, pm.paymaster, address) };

  return {
    address, deployTxHash: dep.hash, spendTxHash: hash, mode: sponsored ? "sponsored" : "self-pay",
    decoded: { deploy: dep.desc, spend: spendDesc },
  };
}

// ---------------------------------------------------------------------------------------------
// Public API (the worker exposes these over Comlink)
// ---------------------------------------------------------------------------------------------

export function deriveAccount(prf: Uint8Array): PqAccount {
  const p = publicFor(transparentSeed(prf));
  return { level: "leanSphincs-s", publicKeyBytes: 64, signatureBytes: LSS_SIG_BYTES, salt: p.salt, address: p.address };
}

export function spend(prf: Uint8Array, to: Hex, valueWei: string, onEvent?: PqSendEventCb): Promise<PqSpendResult> {
  return spendWith(transparentSeed(prf), to, valueWei, "account", onEvent);
}

export function stealthMeta(prf: Uint8Array): PqStealthMeta {
  return { scheme: "leanSphincs-s", metaAddress: toHex(mlkemMeta(prf).encapsulationKey) };
}

/** Receive: encapsulate to our own encapsulation key (fresh random r inside ML-KEM), derive the
    one-time account from ss. The caller must store the returned ticket: it is the only way back. */
export function stealthNewPayment(prf: Uint8Array): PqStealthPayment {
  const ann = dksap.senderDerive(mlkemMeta(prf).encapsulationKey);
  const p = publicFor(stealthSeed(prf, ann.sharedSecret));
  return { scheme: "leanSphincs-s", stealthAddress: p.address, ct: toHex(ann.cipherText), viewTag: toHex(ann.viewTag) };
}

/** Spend from a ticket: decapsulate, re-derive the account and check it is `expectedAddress`
    BEFORE any tx, then the same TX1/TX2 as the transparent account. valueWei "max" = whole balance. */
export async function stealthSpend(
  prf: Uint8Array, ct: Hex, viewTag: Hex, expectedAddress: Hex, to: Hex, valueWei: string, onEvent?: PqSendEventCb,
): Promise<PqSpendResult> {
  const ss = dksap.recipientRecover(mlkemMeta(prf).decapsulationKey, hexToBytes(ct), hexToBytes(viewTag));
  if (ss === null) throw new Error("ticket does not belong to this account");
  const seed = stealthSeed(prf, ss);
  const address = publicFor(seed).address;
  if (address.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new Error(`ticket derives ${address}, not ${expectedAddress}; refusing to spend`);
  }
  return spendWith(seed, to, valueWei, "stealth account", onEvent);
}
