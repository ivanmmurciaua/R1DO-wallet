// Hegota rail shared core: network client, seed derivation primitive, the types and the sponsored
// vs self-pay mode rule both account classes share, frame-tx decode for the UI, tx submission (with
// the dropped-tx re-broadcast) and the sponsored-deploy (TX1) builder. Used by the leanSphincs-s
// path (lssRail.ts) and the ML-DSA-44 path (mldsaRail.ts). Pure TS with no Comlink and no DOM, so
// the same code runs in the Web Worker (pq.worker.ts) and in a headless Node test.
//
// Removable with the rail: nothing outside src/lib/frame and the Frame*.tsx components imports it.
import { createPublicClient, defineChain, http, keccak256, type Hex, type PublicClient } from "viem";
import { shake256 } from "@noble/hashes/sha3";
import { factoryDeployCalldata } from "./engine/account";
import * as dksap from "./engine/dksap";
import {
  MODE_VERIFY, MODE_DEFAULT, MODE_SENDER, FLAG_APPROVE_EXECUTION_AND_PAYMENT, FLAG_APPROVE_EXECUTION,
  FLAG_APPROVE_PAYMENT, FLAG_ATOMIC_BATCH, FLAG_NONE, SCHEME_ARBITRARY, encode, type FrameTx,
} from "./engine/frametx";
import { rpc, sendFrameTx, networkFees, RpcTimeoutError, RPC_TIMEOUT_MS, type Fees, type FrameReceipt } from "./engine/submit";
import { HEGOTA } from "./network";

export const RPC = HEGOTA.rpcUrls[0]!;
export const S = HEGOTA.singletons ?? {};

const chain = defineChain({
  id: HEGOTA.chainId,
  name: HEGOTA.name,
  nativeCurrency: { name: HEGOTA.symbol, symbol: HEGOTA.symbol, decimals: 18 },
  rpcUrls: { default: { http: [...HEGOTA.rpcUrls] } },
});

let pub: PublicClient | undefined;
export function publicClient(): PublicClient {
  if (!pub) pub = createPublicClient({ chain, transport: http(RPC) });
  return pub;
}

export const hasCode = (code: Hex | undefined): boolean => !!code && code !== "0x";

/** The account nonce at `tag`: "latest" = mined state (the default), "pending" = also counts txs
    the node holds in its pool. */
export async function nonceOf(address: Hex, tag: "latest" | "pending" = "latest"): Promise<bigint> {
  return BigInt(await rpc<Hex>(RPC, "eth_getTransactionCount", [address, tag]));
}

export const fmtEth = (wei: bigint): string => `${(Number(wei) / 1e18).toFixed(6)} ${HEGOTA.symbol}`;

// Domain-separated 32-byte seed from the 32-byte PRF root: shake256(utf8(tag) || prf, 32). This is
// the rail's ONE derivation primitive (ML-DSA, ML-KEM and leanSphincs-s seeds all use it with their
// own tags), so every key layer is independent of the others and of the base wallet's HKDF tags.
export function seedFor(tag: string, prf: Uint8Array): Uint8Array {
  if (prf.length !== 32) throw new Error("prf root must be 32 bytes");
  const domain = new TextEncoder().encode(tag);
  const buf = new Uint8Array(domain.length + prf.length);
  buf.set(domain, 0);
  buf.set(prf, domain.length);
  return shake256(buf, { dkLen: 32 });
}

/** The ML-KEM stealth meta keys. ONE tag for every scheme, so the user has a
    single meta-address; only the spending key behind each ticket depends on the scheme. */
export const MLKEM_TAG = "r1do/hegota/mlkem";
export const mlkemMeta = (prf: Uint8Array) => dksap.genMeta(seedFor(MLKEM_TAG, prf));

// ---------------------------------------------------------------------------------------------
// Types shared with the UI (re-exported by pq.worker.ts / pqClient.ts).
// ---------------------------------------------------------------------------------------------

/** The post-quantum signature scheme of an account. The user picks one per device user; each gives
    a different account class, key and address. leanSphincs-s is the default. */
export type PqScheme = "leanSphincs-s" | "ML-DSA-44";

export interface PqAccount {
  level: PqScheme;
  publicKeyBytes: number; // leanSphincs-s 64 (pkSeed || pkRoot); ML-DSA-44 1312 (packed pk)
  signatureBytes: number; // leanSphincs-s 4164; ML-DSA-44 2420
  commit: Hex; // CREATE2 salt (field name kept for page.tsx compat)
  address: Hex; // deterministic CREATE2 address of the account
}

/** The ML-KEM meta-address (hex of the encapsulation key): the half a sender encrypts a payment to.
    It is the SAME for both schemes (one meta-address per user); `scheme` is the selection it was
    read under. page.tsx derives it at login and passes it to FrameStealthHome. */
export interface PqStealthMeta { scheme: PqScheme; metaAddress: Hex }

/** A fresh one-time stealth account plus the off-chain ticket {ct, viewTag} that spends it later.
    `scheme` is the account class the ticket's address was derived for: store it with the ticket. */
export interface PqStealthPayment { scheme: PqScheme; stealthAddress: Hex; ct: Hex; viewTag: Hex }

/** Why the rail is in self-pay: the paymaster has no code ("missing"), its code does not gate this
    account class ("not-gated"), or its balance is below the sponsored gas bound ("underfunded"). */
export type PqFallbackReason = "missing" | "not-gated" | "underfunded";

export interface PqRailStatus {
  scheme: PqScheme;
  paymaster: Hex | null;
  paymasterBalanceWei: string;
  mode: "sponsored" | "self-pay";
  fallbackReason?: PqFallbackReason;
  /** Signature budget of a leanSphincs-s key (few-time scheme); null for ML-DSA-44 (stateless, no budget). */
  signatureBudget: number | null;
  budgetWarn: number | null;
  budgetBlock: number | null;
}

export interface PqAccountStatus {
  deployed: boolean;
  balanceWei: string; // stringified bigint (Comlink-safe)
  /** Raw on-chain nonce. A CREATE2-deployed account starts at 1 (EIP-161), not 0. */
  nonce: number;
  /** Signatures this account has landed on-chain (= nonce - 1 once deployed): the budget counter. */
  signaturesUsed: number;
}

/** Signatures landed by an account: its nonce minus the 1 it got at deployment (EIP-161). */
export const signaturesUsedOf = (nonce: bigint, deployed: boolean): bigint =>
  deployed && nonce > 0n ? nonce - 1n : nonce;

export interface PqSpendResult {
  address: Hex;
  deployTxHash?: Hex; // present only if the account had to be deployed (first spend)
  spendTxHash: Hex;
  /** Who paid TX2's gas, per the receipt: "paymaster" | "self". */
  mode: "sponsored" | "self-pay";
  decoded: { deploy?: FrameTxDesc; spend: FrameTxDesc }; // human-readable frame anatomy (teaching)
}

// A serialisable, human-readable decode of an EIP-8141 frame-tx, so the UI can SHOW what a spend
// actually is (its frames and its witnesses) vs a 4337 UserOp.
export interface FrameDesc {
  index: number; mode: string; flags: string; target: string;
  executionGas: number; stateGas: number; valueWei: string; note: string;
}
export interface FrameTxDesc {
  label: string; type: string; sender: Hex; nonce: string; chainId: number;
  frames: FrameDesc[]; signature: string;
  // Filled in AFTER the tx is mined: the real on-chain trace of this exact tx. `payer` is the
  // receipt's payer address (who actually paid the gas); `payerRole` explains it in words.
  onchain?: { txHash: Hex; payer: string; payerRole?: string };
}

/** Which signature scheme a decoded tx carries (drives the plain-language notes). "mldsa-s" and
    "mldsa-s-blinded" are the AccountMldsaS class. */
export type DescScheme = "deploy" | "lss" | "mldsa-s" | "mldsa-s-blinded";

const MODE_NAME: Record<number, string> = { [MODE_DEFAULT]: "DEFAULT", [MODE_VERIFY]: "VERIFY", [MODE_SENDER]: "SENDER" };
function flagName(f: number): string {
  if (f === FLAG_ATOMIC_BATCH) return "ATOMIC_BATCH";
  if (f === FLAG_APPROVE_EXECUTION_AND_PAYMENT) return "APPROVE exec+payment";
  if (f === FLAG_APPROVE_EXECUTION) return "APPROVE exec";
  if (f === FLAG_APPROVE_PAYMENT) return "APPROVE payment";
  if (f === FLAG_NONE) return "none";
  return `0x${f.toString(16)}`;
}

const same = (a: string | null | undefined, b: string | null | undefined): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

function frameNote(tx: FrameTx, i: number, scheme: DescScheme): string {
  const f = tx.frames[i]!;
  const hasData = !!f.data && f.data !== "0x";
  const self = f.target === null || same(f.target, tx.sender);
  if (f.mode === MODE_VERIFY) {
    if (scheme === "deploy") return "sponsor approves execution + pays this tx's gas";
    if ((same(f.target, S.lssPaymaster) || same(f.target, S.mldsaPaymaster)) && f.flags === FLAG_APPROVE_PAYMENT)
      return "keyless paymaster: checks the account's code hash (EXTCODEHASH), then pays the gas";
    if ((scheme === "mldsa-s" || scheme === "mldsa-s-blinded") && self) {
      const pays = f.flags === FLAG_APPROVE_EXECUTION_AND_PAYMENT ? " and pays its own gas (self-pay fallback)" : "";
      return `the account checks the frame layout (its ML-DSA verify frame follows, atomically batched with the spend) and approves execution${pays}; no signature work here: the ML-DSA verify does not fit the VERIFY prefix gas cap`;
    }
    if (same(f.target, tx.sender) && f.flags === FLAG_APPROVE_EXECUTION)
      return "the account verifies its leanSphincs-s signature (hash-based) and approves execution";
    if (same(f.target, tx.sender) && f.flags === FLAG_APPROVE_EXECUTION_AND_PAYMENT)
      return "self-pay fallback: the account verifies its leanSphincs-s signature and pays its own gas";
    return "the account approves execution + pays its own gas";
  }
  if (f.mode === MODE_DEFAULT && hasData) return "calls the CREATE2 factory to deploy the account";
  if (f.mode === MODE_DEFAULT && f.flags === FLAG_ATOMIC_BATCH)
    return "verifies the ML-DSA signature (atomic batch: a bad sig skips the spend)";
  if (f.mode === MODE_SENDER) return "the account itself moves the value to the recipient";
  return "";
}

function signatureText(tx: FrameTx, scheme: DescScheme): string {
  switch (scheme) {
    case "deploy":
      return "ARBITRARY: empty, the open on-chain sponsor approves, no signature needed";
    case "lss": {
      const head = "[0] ARBITRARY leanSphincs-s, 4,164 B (hash-based; public key in account storage)";
      return tx.signatures.length > 1 ? `${head} · [1] empty (the keyless paymaster reads no witness)` : head;
    }
    case "mldsa-s":
      return "[0] ARBITRARY ML-DSA-44: expanded public key (22,272 B) + signature (2,420 B), checked by the account in the DEFAULT batch frame (ZKNOX verifier); the keyless paymaster reads no witness";
    case "mldsa-s-blinded":
      return "[0] ARBITRARY blinded ML-DSA-44 (DKSAP one-time key): expanded public key (22,272 B) + signature (2,420 B), checked in the DEFAULT batch frame";
  }
}

export function describeFrameTx(tx: FrameTx, label: string, scheme: DescScheme): FrameTxDesc {
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
      note: frameNote(tx, i, scheme),
    })),
    signature: signatureText(tx, scheme),
  };
}

// Dropped-tx re-broadcast. On 8141 a signed TX2 was seen ACCEPTED by eth_sendRawTransaction and
// then silently dropped from the node's pool without being mined, so a plain receipt poll would
// just time out. While waiting, the tx's pool presence is checked; if the node no longer knows it
// (eth_getTransactionByHash is null) and the sender's nonce has NOT advanced past tx.nonce (so the
// tx is still valid and nothing replaced it), the SAME raw bytes are sent again. Identical bytes
// mean the same hash and no new signature (a leanSphincs-s key spends nothing from its budget).
// After REBROADCAST_MAX re-sends that were dropped again, or if the nonce advanced without our
// receipt (another tx consumed it), it fails with a clear error instead of waiting forever. Each
// re-send is reported through the optional onEvent callback (the UI shows "resubmitting (n/3)").
// Every read in the wait is bounded by the engine's per-request timeout (RPC_TIMEOUT_MS): a read
// that times out is a transient miss (poll again), and the whole wait has a wall-clock cap too, so
// a hung node can never keep a send (or the deploy lock around it) from settling.
const RECEIPT_POLL_MS = 1_000;
const RECEIPT_MAX_POLLS = 300;
const RECEIPT_MAX_WAIT_MS = RECEIPT_MAX_POLLS * RECEIPT_POLL_MS + 2 * RPC_TIMEOUT_MS;
const POOL_CHECK_EVERY = 6; // polls between pool presence checks (a fresh tx needs a moment to show)
const REBROADCAST_MAX = 3;
// Once the sender's nonce has moved past ours, the receipt may simply lag the nonce (indexing on
// the node is not atomic with the state update). Re-read it this many more times, with a growing
// pause, before concluding another tx took the nonce.
const LATE_RECEIPT_CHECKS = 4;
const LATE_RECEIPT_BACKOFF_MS = 1_000; // pause before check n is n * this (1+2+3+4 = 10 s at most)

/** One receipt read for the wait loops: a single attempt (the loop is the retry) and any failure,
    a timeout included, is a miss (null) rather than an error. */
const readReceipt = (hash: Hex): Promise<FrameReceipt | null> =>
  rpc<FrameReceipt | null>(RPC, "eth_getTransactionReceipt", [hash], 1).catch(() => null);

/** Progress of a send the UI may want to show. `what` names the tx (e.g. "sponsored deploy (TX1)"). */
export type PqSendEvent = { kind: "rebroadcast"; what: string; attempt: number; max: number; hash: Hex };
export type PqSendEventCb = (e: PqSendEvent) => void;

/** Our signed tx lost its nonce to another tx: it was sent but can never be mined now. */
export class NonceTakenError extends Error {}

// "Already known" means the node holds these exact bytes: the tx IS sent and its hash is ours.
const ALREADY_KNOWN = /already known|already imported|known transaction/i;

/** Submit a fully signed frame-tx, wait for the receipt (re-broadcasting the identical raw tx if
    the node drops it, see above), fail loudly on a revert. */
export async function sendAndWait(
  tx: FrameTx, what: string, onEvent?: PqSendEventCb,
): Promise<{ hash: Hex; receipt: FrameReceipt; payer?: Hex }> {
  const raw = encode(tx);
  let hash: Hex;
  try {
    hash = await sendFrameTx(RPC, raw);
  } catch (e) {
    // The identical bytes are already in the pool (another tab sent the same tx): a typed tx's
    // hash is keccak256 of its raw encoding, so wait for that one instead of failing.
    // A timed-out send is ambiguous (the node may have taken it): wait on the same hash too. If the
    // node never got it, the pool check below sees it missing and re-sends the identical bytes.
    if (!(e instanceof RpcTimeoutError) && !(e instanceof Error && ALREADY_KNOWN.test(e.message))) throw e;
    hash = keccak256(raw);
  }
  const sender = tx.sender as Hex;
  const txNonce = BigInt(tx.nonce);
  let rebroadcasts = 0;
  const deadline = Date.now() + RECEIPT_MAX_WAIT_MS;
  for (let i = 1; i <= RECEIPT_MAX_POLLS && Date.now() < deadline; i++) {
    await new Promise((res) => setTimeout(res, RECEIPT_POLL_MS));
    const receipt = await readReceipt(hash);
    if (receipt) {
      if (receipt.status !== "0x1") throw new Error(`${what} failed (tx ${hash})`);
      const payer = typeof receipt.payer === "string" ? (receipt.payer as Hex) : undefined;
      return { hash, receipt, payer };
    }
    if (i % POOL_CHECK_EVERY !== 0) continue;
    // Read errors (timeouts included) are not evidence of a drop: skip this round instead of
    // re-sending. The nonce is read at "latest" on purpose: "advanced" must mean a MINED tx used it.
    let known: unknown;
    let nonce: bigint;
    try {
      [known, nonce] = await Promise.all([rpc<unknown>(RPC, "eth_getTransactionByHash", [hash]), nonceOf(sender, "latest")]);
    } catch {
      continue;
    }
    if (known) continue; // still pending (or mined and the receipt lags): keep polling
    if (nonce > txNonce) {
      // The nonce moved on: either ours was just mined (receipt not indexed yet) or another tx took
      // the slot. Re-read our receipt a few times with a growing pause (see LATE_RECEIPT_CHECKS);
      // only if it never shows up can our tx never land.
      for (let k = 0; k <= LATE_RECEIPT_CHECKS; k++) {
        if (k > 0) await new Promise((res) => setTimeout(res, LATE_RECEIPT_BACKOFF_MS * k));
        const late = await readReceipt(hash);
        if (late) {
          if (late.status !== "0x1") throw new Error(`${what} failed (tx ${hash})`);
          return { hash, receipt: late, payer: typeof late.payer === "string" ? (late.payer as Hex) : undefined };
        }
      }
      throw new NonceTakenError(`${what}: tx ${hash} was sent but dropped, and ${sender}'s nonce ${txNonce} was then used by another tx, so this one can never be mined; check the explorer for ${hash} and the account balance before retrying`);
    }
    if (rebroadcasts >= REBROADCAST_MAX) {
      throw new Error(`${what}: tx ${hash} was not mined after ${REBROADCAST_MAX} rebroadcasts (the node kept dropping it, nonce ${txNonce} still unused); it may still land, check the explorer for ${hash} before retrying`);
    }
    rebroadcasts++;
    console.info(`[hegota rail] ${what}: tx ${hash} dropped by the node, rebroadcasting the same bytes (${rebroadcasts}/${REBROADCAST_MAX})`);
    // A UI callback must never break the send (over Comlink it is async: swallow its rejection too).
    try {
      const r: unknown = onEvent?.({ kind: "rebroadcast", what, attempt: rebroadcasts, max: REBROADCAST_MAX, hash });
      if (r instanceof Promise) r.catch(() => {});
    } catch {
      /* ignored */
    }
    try {
      await sendFrameTx(RPC, raw);
    } catch {
      // "already known" / transient errors: the next pool check decides again.
    }
  }
  throw new Error(`${what}: no receipt for tx ${hash} after ${(RECEIPT_MAX_POLLS * RECEIPT_POLL_MS) / 1000}s; it may still land, check the explorer for ${hash} before retrying`);
}

/** TX1 gas, per account class: the leanSphincs-s account's code deposit + 5 storage slots are state
    gas on 8141 (measured 2.14M used); AccountMldsaS (measured 589K pre-funded / 773K empty) fits in
    1M/1M. */
export interface DeployGas { executionGas: number; stateGas: number }
export const DEPLOY_GAS_LSS: DeployGas = { executionGas: 8_000_000, stateGas: 6_000_000 };
export const DEPLOY_GAS_MLDSA_S: DeployGas = { executionGas: 1_000_000, stateGas: 1_000_000 };
const SPONSOR_VERIFY = { executionGas: 80_000, stateGas: 50_000 };

// Open-sponsor nonce discipline. Every TX1 has the SAME sender (the open sponsor), so two deploys
// that read its nonce at the same time would sign the same nonce and one would be rejected. Within
// this worker (or headless process) ensureDeployed calls are serialized by a promise-chain lock, so
// each reads the nonce only after the previous TX1 is mined. Other tabs, devices or users share
// the sponsor too and are NOT covered by the lock: a cross-process collision shows up as a "nonce
// too low" / "replacement underpriced" RPC error (or as our TX1 losing its nonce while pooled),
// and is handled only by re-reading the nonce and re-sending, at most DEPLOY_NONCE_RETRIES times.
// The lock is always released: deployOnce settles because every RPC it makes is bounded (engine
// rpc() per-request timeout, viem's own HTTP timeout, sendAndWait's wall-clock cap).
//
// Which nonce: the FIRST attempt reads "latest" (mined state). Our own previous TX1 is mined by
// then (the lock), and a "pending" read could count another tab's TX1 the node later drops,
// leaving our tx stuck behind a nonce gap. A RETRY reads "pending": the clash was against a tx the
// node holds (e.g. "replacement underpriced" vs another tab's pooled TX1), which "latest" does not
// count yet, so "latest" would hand us the same contested nonce again.
let deployLock: Promise<unknown> = Promise.resolve();
function serializeDeploy<T>(fn: () => Promise<T>): Promise<T> {
  const run = deployLock.then(fn, fn);
  deployLock = run.catch(() => {}); // a failed deploy must not wedge the queue
  return run;
}
const DEPLOY_NONCE_RETRIES = 3;
// A rejection of OUR submit (engine rpc() prefixes the method) that names the nonce or a replacement.
const isNonceClash = (e: unknown): boolean =>
  e instanceof NonceTakenError ||
  (e instanceof Error && e.message.startsWith("eth_sendRawTransaction:") && /nonce|replacement|underpriced/i.test(e.message));

/** TX1: sponsored CREATE2 deploy (only if `address` has no code). sender = the open sponsor, which
    approves and pays; a DEFAULT frame calls the factory with salt || initcode. No EOA involved.
    Serialized per worker (see above); retried on a sponsor-nonce clash. */
export function ensureDeployed(
  address: Hex, salt: Hex, initcode: Hex, fees: Fees, gas: DeployGas, onEvent?: PqSendEventCb,
): Promise<{ hash?: Hex; desc?: FrameTxDesc }> {
  return serializeDeploy(() => deployOnce(address, salt, initcode, fees, gas, onEvent));
}

async function deployOnce(
  address: Hex, salt: Hex, initcode: Hex, fees: Fees, gas: DeployGas, onEvent?: PqSendEventCb,
): Promise<{ hash?: Hex; desc?: FrameTxDesc }> {
  const client = publicClient();
  // Checked inside the lock: a deploy of the same address queued ahead of us may have landed.
  if (hasCode(await client.getCode({ address }))) return {};
  const openSponsor = S.openSponsor;
  const factory = S.accountFactory;
  if (!openSponsor || !factory) throw new Error("no open sponsor / factory configured for this network");
  if (!hasCode(await client.getCode({ address: openSponsor }))) throw new Error(`open sponsor ${openSponsor} not deployed (devnet reset?)`);
  const need = BigInt(SPONSOR_VERIFY.executionGas + SPONSOR_VERIFY.stateGas + gas.executionGas + gas.stateGas + 200_000) * fees.maxFeePerGas;
  const have = await client.getBalance({ address: openSponsor });
  if (have < need) throw new Error(`open sponsor is out of funds for the deploy (has ${fmtEth(have)}, needs ~${fmtEth(need)})`);

  for (let attempt = 0; ; attempt++) {
    const tx1: FrameTx = {
      chainId: HEGOTA.chainId, nonce: await nonceOf(openSponsor, attempt === 0 ? "latest" : "pending"), sender: openSponsor,
      frames: [
        { mode: MODE_VERIFY, flags: FLAG_APPROVE_EXECUTION_AND_PAYMENT, target: null, ...SPONSOR_VERIFY, value: 0 },
        { mode: MODE_DEFAULT, flags: FLAG_NONE, target: factory, ...gas, value: 0, data: factoryDeployCalldata(salt, initcode) },
      ],
      signatures: [{ scheme: SCHEME_ARBITRARY, signer: null, msg: "0x", signature: "0x" }],
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas, maxFeePerGas: fees.maxFeePerGas, maxFeePerBlobGas: 0,
      feeNested: true, omitRecentRoots: true,
    };
    const desc = describeFrameTx(tx1, "sponsored deploy", "deploy");
    let sent: Awaited<ReturnType<typeof sendAndWait>>;
    try {
      sent = await sendAndWait(tx1, "sponsored deploy (TX1)", onEvent);
    } catch (e) {
      if (!isNonceClash(e) || attempt >= DEPLOY_NONCE_RETRIES) throw e;
      console.info(`[hegota rail] sponsored deploy (TX1): open-sponsor nonce clash (${e instanceof Error ? e.message : e}); re-reading the nonce, retry ${attempt + 1}/${DEPLOY_NONCE_RETRIES}`);
      await new Promise((res) => setTimeout(res, 1_500 * (attempt + 1)));
      // The clashing tx may have been the same deploy (another tab): done if the code is there.
      if (hasCode(await client.getCode({ address }))) return {};
      continue;
    }
    const { hash, payer } = sent;
    if (!hasCode(await client.getCode({ address }))) throw new Error(`deploy mined (${hash}) but ${address} has no code`);
    desc.onchain = { txHash: hash, payer: payer ?? openSponsor, payerRole: "the open on-chain sponsor" };
    return { hash, desc };
  }
}

/** keccak256 of the deployed runtime (EXTCODEHASH equivalent), or null if no code. */
export async function codehashOf(address: Hex): Promise<Hex | null> {
  const code = await publicClient().getCode({ address });
  return hasCode(code) ? keccak256(code!) : null;
}

// ---------------------------------------------------------------------------------------------
// Sponsored vs self-pay: THE mode rule, shared by both account classes
// ---------------------------------------------------------------------------------------------

/** Does `code` gate `classHash`? The keyless paymaster has no storage and no operator: its runtime
    embeds the one class codehash it approves as a PUSH32 immediate (0x7f || hash), compared against
    EXTCODEHASH(sender). So "the runtime contains PUSH32 classHash" is how this paymaster names its
    target. It is a heuristic (it does not prove the comparison logic around it), which is fine for
    choosing the mode: a false positive only means the sponsored tx is rejected at validation (no
    gas is spent, nothing moves), and anything that does not embed the hash falls back to self-pay. */
export function gatesClass(code: Hex, classHash: Hex): boolean {
  const body = code.slice(2).toLowerCase();
  const needle = "7f" + classHash.slice(2).toLowerCase();
  for (let i = body.indexOf(needle); i !== -1; i = body.indexOf(needle, i + 1)) {
    if (i % 2 === 0) return true; // byte-aligned
  }
  return false;
}

export interface RailMode {
  paymaster: Hex | null;
  balance: bigint;
  fees: Fees;
  sponsored: boolean;
  fallbackReason?: PqFallbackReason;
}

/** Sponsored iff `paymaster` has code, gates `classHash` and can cover `sponsoredGasBound` at
    current fees; otherwise self-pay with the first failing reason. Each rail calls it with ITS
    paymaster, class hash and bound (read from S at call time, so a test override is honoured), for
    railStatus() (what the UI shows) and the spend (what is sent) alike. Never throws on a paymaster
    problem: every one of them is a self-pay fallback. */
export async function railModeFor(paymaster: Hex | null | undefined, classHash: Hex | null | undefined, sponsoredGasBound: bigint): Promise<RailMode> {
  const client = publicClient();
  const fees = await networkFees(RPC);
  if (!paymaster) return { paymaster: null, balance: 0n, fees, sponsored: false, fallbackReason: "missing" };
  const [code, balance] = await Promise.all([client.getCode({ address: paymaster }), client.getBalance({ address: paymaster })]);
  const self = (fallbackReason: PqFallbackReason): RailMode => ({ paymaster, balance, fees, sponsored: false, fallbackReason });
  if (!hasCode(code)) return self("missing");
  if (!classHash || !gatesClass(code!, classHash)) return self("not-gated");
  if (balance < sponsoredGasBound * fees.maxFeePerGas) return self("underfunded");
  return { paymaster, balance, fees, sponsored: true };
}

/** The self-pay reason in words (for error messages). */
export function fallbackWhy(m: RailMode): string {
  return m.fallbackReason === "underfunded" ? `paymaster ${m.paymaster} is out of funds`
    : m.fallbackReason === "not-gated" ? `paymaster ${m.paymaster} does not gate this account class`
    : "no paymaster deployed";
}

/** Who paid, in words, from the receipt payer. */
export function payerRoleOf(paidBy: Hex, paymaster: Hex | null, account: Hex): string {
  return same(paidBy, paymaster) ? "the keyless paymaster (your account paid 0 gas)"
    : same(paidBy, account) ? "this account (self-pay)" : "a third party";
}
