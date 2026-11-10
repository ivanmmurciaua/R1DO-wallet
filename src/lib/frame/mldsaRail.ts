// Hegota rail, ML-DSA-44 path (lattice post-quantum signatures, gas paid by a keyless paymaster).
//
// The user picks this scheme or leanSphincs-s (lssRail.ts) per account; this module mirrors
// lssRail's API so the worker can route by scheme.
//
// Keys: one ML-DSA-44 (FIPS-204, SHAKE) key from a 32-byte seed derived from the passkey PRF root:
//   transparent / stealth base key   "r1do/hegota/mldsa-s/v1" (never reuse the retired
//                                    "r1do/hegota/mldsa" tag of the pre-migration rail)
//   ML-KEM meta keys                 railCore mlkemMeta ("r1do/hegota/mlkem"), the SAME meta-address
//                                    as the leanSphincs-s rail: one meta-address per user
// ML-DSA is stateless: no signature budget. Secret keys never leave the Web Worker.
//
// Account: AccountMldsaS at a deterministic CREATE2 address:
//   pkEnc = abi.encode(uint256[][][] aHat, bytes tr, uint256[][] t1)  (expanded pk, 22,272 B; aHat
//           and t1 in the NTT domain, the layout of the ZKNOX packed verifier, network.ts `verifier`)
//   commit = salt = keccak256(pkEnc); initcode = creation || commit || pad32(verifier)
// commit and verifier live in storage, so the whole class shares one runtime codehash. The address
// depends on the verifier: accounts placed on the retired verifier are not derived any more.
// The ML-DSA verify costs ~1.25M gas and the VERIFY prefix is capped at 500K on 8141, so it cannot
// run in VERIFY. The account's VERIFY only checks the frame LAYOUT (next frame is DEFAULT -> itself and
// every frame from there to the last one is ATOMIC_BATCH) and approves; the DEFAULT batch head then
// runs the ML-DSA verify on signatures[0] and reverts on a bad signature, so the node skips the rest
// of the batch (the value-moving SENDER). Spend = up to two frame-txs, with NO EOA in the flow:
//   TX1 (only if not yet deployed) sender = open sponsor, which pays; a DEFAULT frame deploys the
//       account through the factory (the paymaster gates on EXTCODEHASH, empty code never matches).
//   TX2 sponsored: [VERIFY self 0x2 (layout gate)][VERIFY ML-DSA paymaster 0x1 (EXTCODEHASH gate)]
//       [DEFAULT self ATOMIC_BATCH (ML-DSA verify)][SENDER to value]. The account pays ZERO gas.
//   Fallback: self-pay [VERIFY self 0x3][DEFAULT self ATOMIC_BATCH][SENDER] when the ML-DSA
//       paymaster is missing, does not gate AccountMldsaS or is underfunded (railCore railModeFor).
// Witness: ONE entry {ARBITRARY, signer null, msg empty, signature pkEnc || sig (24,692 B)}. Empty msg
// means its bytes are elided from the canonical sig_hash (8-field envelope, keccak(0x06 || rlp)),
// which the account reads with TXPARAM(0x08). The ML-DSA message is the 32 raw sig_hash bytes.
//
// Stealth (construction A): a ticket {ct, viewTag} from ML-KEM encapsulation to
// our own meta-address gives ss; the one-time public key is stealth44.senderStealthPk(rho, t, ss) of
// the base key above and the matching blinded signing key is stealth44.recipientBlindedKey(base, ss).
// The one-time account is an ordinary AccountMldsaS of that blinded key. The ticket is the ONLY
// record of which ss was used: the store must keep it (and the user should back it up).
//
// Bundle isolation: only pq.worker.ts (and a headless test) imports this module.
import { concat, encodeAbiParameters, hexToBytes, keccak256, toHex, type Hex } from "viem";
import { dilithium44, mldsa44, stealth44, dksap } from "./engine/index";
import { deriveAccount as deriveCreate2 } from "./engine/account";
import { ACCOUNT_MLDSA_S_BIN } from "./engine/bin";
import {
  MODE_VERIFY, MODE_DEFAULT, MODE_SENDER, FLAG_APPROVE_EXECUTION, FLAG_APPROVE_PAYMENT,
  FLAG_APPROVE_EXECUTION_AND_PAYMENT, FLAG_ATOMIC_BATCH, FLAG_NONE, SCHEME_ARBITRARY, sigHash, type FrameTx,
} from "./engine/frametx";
import { type Fees } from "./engine/submit";
import { HEGOTA } from "./network";
import {
  S, publicClient, hasCode, nonceOf, fmtEth, seedFor, describeFrameTx, sendAndWait, ensureDeployed, codehashOf,
  railModeFor, fallbackWhy, payerRoleOf, mlkemMeta, signaturesUsedOf, DEPLOY_GAS_MLDSA_S,
  type PqAccount, type PqAccountStatus, type PqSpendResult, type PqStealthMeta, type PqStealthPayment,
  type PqRailStatus, type RailMode, type PqSendEventCb,
} from "./railCore";

// ---------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------

export const MLDSA_S_TAG = "r1do/hegota/mldsa-s/v1";

const PK_BYTES = 1312;
const SIG_BYTES = 2420;
// Expanded public key (22,272 B) + signature: what the account checks (SIGPARAM(0x03, 0)).
const WITNESS_BYTES = 24_692;

// Frame gas (execution, state). Measured per-frame receipts on the packed verifier (5 spends:
// transparent, blinded stealth, self-pay; e.g. 0xd5ed53d2..., 0xb0a686dc..., 0xe46a02a3...): VERIFY
// account 416, paymaster 3,151, DEFAULT ML-DSA verify 1,248,191 to 1,251,840, SENDER 3,000 (+ up to
// 120 * 1530 state gas when the recipient is a new account). G_DEFAULT_VERIFY = 1.6M is a ~28%
// margin over the highest measured verify: if it ran out of gas the batch would be skipped (nothing
// moves) but the gas would still be paid. Prefix (VERIFY frames) total: 120K sponsored / 60K
// self-pay (declared limits; ~3.6K actually used), within this devnet's 500K prefix cap. The EIP-8141
// spec floor is 100K execution gas (EIPs PR #12301 would make it a shared floor nodes may raise).
const G_VERIFY_ACCOUNT = { executionGas: 60_000, stateGas: 0 };
const G_VERIFY_PAYMASTER = { executionGas: 60_000, stateGas: 50_000 };
const G_DEFAULT_VERIFY = { executionGas: 1_600_000, stateGas: 0 };
const G_SENDER = { executionGas: 30_000, stateGas: 183_600 };
// The 24.7 KB witness makes the calldata floor bind: every measured spend used exactly 1,600,480 gas
// (sponsored) / 1,600,005 (self-pay), above frame use (~1.26M) plus the ~317K intrinsic estimated
// below (~1.57M). The upfront charge is bounded by the declared frame gas (1,983,600 sponsored)
// plus the intrinsic bound, so 2.5M is the paymaster balance check bound (~56% over the 1.6M used).
const SPONSORED_GAS_BOUND = 2_500_000n;
// Self-pay reserve. The account is charged maxFeePerGas * (intrinsic + every frame's declared
// execution + state gas) UP FRONT, before SENDER moves the value, and refunded the unused part after,
// so a "send all" must hold back exactly that. Frame part: summed from the constants the self-pay tx
// is built with (1,873,600). Intrinsic part, from the self-pay receipt 0xcf04495f... on the retired
// verifier (same 24.7 KB witness): gasUsed 15,168,857 minus frame use (416 + 14,665,296 + 3,000 +
// 183,600 state) = 316,545. 450K is a ~40% margin. The total (2,323,600) is above the calldata
// floor (1,600,005 measured), so it also covers a floor-bound charge.
const SELF_PAY_INTRINSIC_BOUND = 450_000n;
const SELF_PAY_FRAME_GAS = BigInt(
  G_VERIFY_ACCOUNT.executionGas + G_VERIFY_ACCOUNT.stateGas + G_DEFAULT_VERIFY.executionGas + G_DEFAULT_VERIFY.stateGas
    + G_SENDER.executionGas + G_SENDER.stateGas,
); // 1,873,600
const SELF_PAY_GAS_BOUND = SELF_PAY_FRAME_GAS + SELF_PAY_INTRINSIC_BOUND; // 2,323,600

// ---------------------------------------------------------------------------------------------
// Key material
// ---------------------------------------------------------------------------------------------

type SecretKey = dilithium44.SecretParts;
interface MldsaPublic { address: Hex; initcode: Hex; salt: Hex; pkEnc: Hex }
interface MldsaKey extends MldsaPublic { sk: SecretKey; blind?: { signK: Uint8Array } }

function singletons() {
  const { accountFactory, verifier } = S;
  if (!accountFactory || !verifier) throw new Error("rail singletons (factory / ML-DSA verifier) not set");
  return { accountFactory, verifier };
}

/** ABI-encoded SHAKE PubKey (aHat, tr, t1 in the NTT domain), 22,272 B: the account's commit is its keccak. */
function pkEncOf(pk: Uint8Array): Hex {
  const { aHat, tr, t1 } = mldsa44.expandPk(pk);
  return encodeAbiParameters(
    [{ type: "uint256[][][]" }, { type: "bytes" }, { type: "uint256[][]" }],
    [aHat, toHex(tr), t1],
  );
}

function place(pkEnc: Hex): MldsaPublic {
  const { accountFactory, verifier } = singletons();
  const commit = keccak256(pkEnc);
  const p = deriveCreate2({ factory: accountFactory, commit, verifier, accountBin: ACCOUNT_MLDSA_S_BIN });
  return { ...p, pkEnc };
}

const baseKey = (prf: Uint8Array) => dilithium44.keygen(seedFor(MLDSA_S_TAG, prf));

// PUBLIC material cache (address + pkEnc), keyed by a hash of the seed / ticket secret, so a known
// address is not re-derived. Secret keys are never cached: each signing action re-derives them.
const pubCache = new Map<string, MldsaPublic>();
const CACHE_DOMAIN = toHex(new TextEncoder().encode("r1do/hegota/mldsa-s/cache-id"));
const cacheId = (...parts: Uint8Array[]): string => keccak256(concat([CACHE_DOMAIN, ...parts.map((p) => toHex(p))]));

function transparentPublic(prf: Uint8Array): MldsaPublic {
  const id = cacheId(prf);
  const hit = pubCache.get(id);
  if (hit) return hit;
  const p = place(pkEncOf(baseKey(prf).publicKey));
  pubCache.set(id, p);
  return p;
}

function transparentKey(prf: Uint8Array): MldsaKey {
  const { publicKey, sk } = baseKey(prf);
  const p = place(pkEncOf(publicKey));
  pubCache.set(cacheId(prf), p);
  return { ...p, sk };
}

/** One-time stealth public material for ticket secret `ss` (what a sender could derive from the
    base public key (rho, t) and ss). */
function stealthPublic(prf: Uint8Array, ss: Uint8Array): MldsaPublic {
  const id = cacheId(prf, ss);
  const hit = pubCache.get(id);
  if (hit) return hit;
  const { sk } = baseKey(prf);
  const p = place(pkEncOf(stealth44.senderStealthPk(sk.rho, sk.t, ss)));
  pubCache.set(id, p);
  return p;
}

/** The blinded signing key for ticket secret `ss`, placed at the same address as stealthPublic. */
function stealthKey(prf: Uint8Array, ss: Uint8Array): MldsaKey {
  const { sk: base } = baseKey(prf);
  const { sk, signK } = stealth44.recipientBlindedKey(base, ss);
  const p = place(pkEncOf(stealth44.senderStealthPk(base.rho, base.t, ss)));
  return { ...p, sk, blind: { signK } };
}

// ---------------------------------------------------------------------------------------------
// Tx builders
// ---------------------------------------------------------------------------------------------

const witnessSlot = () => [{ scheme: SCHEME_ARBITRARY, signer: null, msg: "0x" as Hex, signature: "0x" as Hex }];

function buildSponsoredSpend(account: Hex, paymaster: Hex, nonce: bigint, to: Hex, value: bigint, fees: Fees): FrameTx {
  return {
    chainId: HEGOTA.chainId, nonce, sender: account,
    frames: [
      { mode: MODE_VERIFY, flags: FLAG_APPROVE_EXECUTION, target: null, ...G_VERIFY_ACCOUNT, value: 0 },
      { mode: MODE_VERIFY, flags: FLAG_APPROVE_PAYMENT, target: paymaster, ...G_VERIFY_PAYMASTER, value: 0 },
      { mode: MODE_DEFAULT, flags: FLAG_ATOMIC_BATCH, target: null, ...G_DEFAULT_VERIFY, value: 0 },
      { mode: MODE_SENDER, flags: FLAG_NONE, target: to, ...G_SENDER, value },
    ],
    // ONE witness: the keyless paymaster reads none.
    signatures: witnessSlot(),
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas, maxFeePerGas: fees.maxFeePerGas, maxFeePerBlobGas: 0,
    feeNested: true, omitRecentRoots: true,
  };
}

function buildSelfPaySpend(account: Hex, nonce: bigint, to: Hex, value: bigint, fees: Fees): FrameTx {
  return {
    chainId: HEGOTA.chainId, nonce, sender: account,
    frames: [
      { mode: MODE_VERIFY, flags: FLAG_APPROVE_EXECUTION_AND_PAYMENT, target: null, ...G_VERIFY_ACCOUNT, value: 0 },
      { mode: MODE_DEFAULT, flags: FLAG_ATOMIC_BATCH, target: null, ...G_DEFAULT_VERIFY, value: 0 },
      { mode: MODE_SENDER, flags: FLAG_NONE, target: to, ...G_SENDER, value },
    ],
    signatures: witnessSlot(),
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas, maxFeePerGas: fees.maxFeePerGas, maxFeePerBlobGas: 0,
    feeNested: true, omitRecentRoots: true,
  };
}

/** Sign the canonical sig_hash; witness #0 = pkEnc || sig. A blinded (stealth) key signs with the
    widened rejection bound and its ss-derived signing seed (rnd = zero, deterministic). */
function signWitness0(tx: FrameTx, k: MldsaKey): void {
  const h = sigHash(tx);
  const sig = k.blind
    ? dilithium44.sign(k.sk, hexToBytes(h), new Uint8Array(0), new Uint8Array(32), stealth44.BETA_BLINDED, k.blind.signK)
    : dilithium44.sign(k.sk, hexToBytes(h));
  if (sig.length !== SIG_BYTES) throw new Error("unexpected ML-DSA-44 signature size");
  const witness = concat([k.pkEnc, toHex(sig)]);
  if ((witness.length - 2) / 2 !== WITNESS_BYTES) throw new Error("unexpected ML-DSA witness size");
  tx.signatures[0]!.signature = witness;
  if (sigHash(tx) !== h) throw new Error("sig_hash moved after inserting the witness (codec bug)");
}

// ---------------------------------------------------------------------------------------------
// Paymaster / rail status
// ---------------------------------------------------------------------------------------------

/** This class's mode: the ML-DSA paymaster, AccountMldsaS class hash and bound, shared rule. */
const railMode = (): Promise<RailMode> => railModeFor(S.mldsaPaymaster, S.mldsaAccountCodehash, SPONSORED_GAS_BOUND);

export async function railStatus(): Promise<PqRailStatus> {
  const { paymaster, balance, sponsored, fallbackReason } = await railMode();
  return {
    scheme: "ML-DSA-44",
    paymaster,
    paymasterBalanceWei: balance.toString(),
    mode: sponsored ? "sponsored" : "self-pay",
    fallbackReason,
    signatureBudget: null,
    budgetWarn: null,
    budgetBlock: null,
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

async function spendWith(k: MldsaKey, to: Hex, valueWei: string, who: string, onEvent?: PqSendEventCb): Promise<PqSpendResult> {
  const client = publicClient();
  const { verifier } = singletons();
  // Assumed singleton: error (never auto-deploy) if a devnet reset wiped it; it is in every address.
  if (!hasCode(await client.getCode({ address: verifier }))) throw new Error(`ML-DSA verifier ${verifier} not deployed (devnet reset? re-anchor)`);

  const pm = await railMode();
  const { fees, sponsored, fallbackReason } = pm;
  const address = k.address;
  const balance = await client.getBalance({ address });

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
  const dep = await ensureDeployed(address, k.salt, k.initcode, fees, DEPLOY_GAS_MLDSA_S, onEvent);

  // Sponsored only: check the runtime codehash against the paymaster gate before signing, so a
  // mismatch is a clear error instead of a raw validation-prefix rejection.
  if (sponsored) {
    const ch = await codehashOf(address);
    if (!ch || ch.toLowerCase() !== S.mldsaAccountCodehash!.toLowerCase()) {
      throw new Error(`account ${address} code does not match the ML-DSA paymaster gate (codehash ${ch ?? "none"})`);
    }
  }

  // TX2: the spend. The nonce is read now (TX1's sender is the sponsor, it does not move ours).
  const nonce = await nonceOf(address);
  const tx2 = sponsored
    ? buildSponsoredSpend(address, pm.paymaster!, nonce, to, value, fees)
    : buildSelfPaySpend(address, nonce, to, value, fees);
  signWitness0(tx2, k);
  const label = sponsored ? "sponsored spend (ML-DSA-44)" : `self-pay spend (ML-DSA-44, fallback: paymaster ${fallbackReason})`;
  const spendDesc = describeFrameTx(tx2, label, k.blind ? "mldsa-s-blinded" : "mldsa-s");
  const { hash, payer } = await sendAndWait(tx2, `${label} (TX2)`, onEvent);
  const paidBy = payer ?? (sponsored ? pm.paymaster! : address);
  spendDesc.onchain = { txHash: hash, payer: paidBy, payerRole: payerRoleOf(paidBy, pm.paymaster, address) };

  return {
    address, deployTxHash: dep.hash, spendTxHash: hash, mode: sponsored ? "sponsored" : "self-pay",
    decoded: { deploy: dep.desc, spend: spendDesc },
  };
}

// ---------------------------------------------------------------------------------------------
// Public API (the worker exposes these over Comlink, routed by scheme)
// ---------------------------------------------------------------------------------------------

export function deriveAccount(prf: Uint8Array): PqAccount {
  const p = transparentPublic(prf);
  return { level: "ML-DSA-44", publicKeyBytes: PK_BYTES, signatureBytes: SIG_BYTES, commit: p.salt, address: p.address };
}

export function spend(prf: Uint8Array, to: Hex, valueWei: string, onEvent?: PqSendEventCb): Promise<PqSpendResult> {
  return spendWith(transparentKey(prf), to, valueWei, "account", onEvent);
}

/** The same ML-KEM meta-address as the leanSphincs-s rail. */
export function stealthMeta(prf: Uint8Array): PqStealthMeta {
  return { scheme: "ML-DSA-44", metaAddress: toHex(mlkemMeta(prf).encapsulationKey) };
}

/** Receive: encapsulate to our own meta-address (fresh randomness inside ML-KEM) and derive the
    one-time blinded ML-DSA account from ss. The caller must store the returned ticket. */
export function stealthNewPayment(prf: Uint8Array): PqStealthPayment {
  const ann = dksap.senderDerive(mlkemMeta(prf).encapsulationKey);
  const p = stealthPublic(prf, ann.sharedSecret);
  return { scheme: "ML-DSA-44", stealthAddress: p.address, ct: toHex(ann.cipherText), viewTag: toHex(ann.viewTag) };
}

/** Spend from a ticket: decapsulate, re-derive the blinded account and check it is
    `expectedAddress` BEFORE any tx, then TX1/TX2 as the transparent account. "max" = whole balance. */
export async function stealthSpend(
  prf: Uint8Array, ct: Hex, viewTag: Hex, expectedAddress: Hex, to: Hex, valueWei: string, onEvent?: PqSendEventCb,
): Promise<PqSpendResult> {
  const ss = dksap.recipientRecover(mlkemMeta(prf).decapsulationKey, hexToBytes(ct), hexToBytes(viewTag));
  if (ss === null) throw new Error("ticket does not belong to this account");
  const k = stealthKey(prf, ss);
  if (k.address.toLowerCase() !== expectedAddress.toLowerCase()) {
    throw new Error(`ticket derives ${k.address}, not ${expectedAddress}; refusing to spend`);
  }
  return spendWith(k, to, valueWei, "stealth account", onEvent);
}
