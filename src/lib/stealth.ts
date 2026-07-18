import { keccak256, toHex, concat, hexToBytes, getAddress } from "viem";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";

// ── Δ: announcer-less delivery ──────────────────────────────────────────────
// The ERC-5564 announcer and the ERC-6538 registry are gone. The note-delivery
// blob travels fused with the payment itself, as calldata of the value transfer
// to the (counterfactual) stealth Safe:
//
//   blob = MAGIC(4) ‖ viewTag(1) ‖ ephemeralPubKey(33) ‖ kemCiphertext(1088)
//
// The stealth Safe has no code at payment time, so the calldata is inert — it
// exists only as bytes inside the UserOp, where the receiver's scanner finds it
// (EntryPoint UserOperationEvent → tx → calldata pattern match → trial-decrypt).
// Meta-addresses are distributed off-chain (QR, profile, direct message).

export const STEALTH_MAGIC = "0x73706531" as const; // "spe1"
export const STEALTH_BLOB_LENGTH = 4 + 1 + 33 + 1088; // 1126 bytes

// EntryPoint v0.7 — the scanner's index source (canonical AA infra, not a
// privacy-specific contract: every 4337 tx emits these events).
export const ENTRYPOINT_ADDRESS = "0x0000000071727De22E5E9d8BAf0edAc6f37da032" as const;

// v2: the main Safe owner is a secp256k1 key derived from the PRF — a
// sibling of the stealth keys under HKDF. The passkey stops signing
// transactions and becomes the biometric gate of this derivation: no
// P-256 coordinates need to exist anywhere, and a Falcon/ML-DSA owner is
// one more HKDF branch away when EVM signature migration lands.
export function deriveOwnerKey(prfOutput: Uint8Array): `0x${string}` {
  const ownerSeed = hkdf(sha256, prfOutput, undefined, "r1do/wallet/owner/v2", 32);
  return toHex(ownerSeed) as `0x${string}`;
}

export interface PQStealthKeys {
  spendingPrivateKey: `0x${string}`;
  spendingPublicKey:  `0x${string}`;
  viewingPrivateKey:  `0x${string}`;
  viewingPublicKey:   `0x${string}`;
  mlkemEncapsKey:     Uint8Array; // 1184 bytes — public
  mlkemDecapsKey:     Uint8Array; // 2400 bytes — private (re-derived from PRF, never stored)
  pqMetaAddress:      `0x${string}`; // 1251 bytes: 0x00 + pk_spend(33) + pk_view(33) + ek(1184)
}

// Derives all PQ stealth keys from a 32-byte PRF output.
// All keys are deterministic — re-derive on every session, never store private keys.
export async function derivePQKeysFromPRF(prfOutput: Uint8Array): Promise<PQStealthKeys> {
  console.log("[derivePQKeysFromPRF] Starting key derivation from PRF output...");
  const { getPublicKey } = await import("@noble/secp256k1");
  const { ml_kem768 } = await import("@noble/post-quantum/ml-kem.js");

  const spendSeed = hkdf(sha256, prfOutput, undefined, "r1do-stealth-spend-v1", 32);
  const viewSeed  = hkdf(sha256, prfOutput, undefined, "r1do-stealth-view-v1",  32);
  const kemSeed1  = hkdf(sha256, prfOutput, undefined, "r1do-stealth-kem1-v1",  32);
  const kemSeed2  = hkdf(sha256, prfOutput, undefined, "r1do-stealth-kem2-v1",  32);
  const kemSeed   = concat([kemSeed1, kemSeed2]); // 64 bytes for ml_kem768.keygen
  console.log("[derivePQKeysFromPRF] HKDF seeds derived (spend, view, kem1, kem2)");

  const spendingPubKeyBytes = getPublicKey(spendSeed, true);
  const viewingPubKeyBytes  = getPublicKey(viewSeed,  true);
  console.log(`[derivePQKeysFromPRF] secp256k1 spending pubkey: ${toHex(spendingPubKeyBytes)}`);
  console.log(`[derivePQKeysFromPRF] secp256k1 viewing  pubkey: ${toHex(viewingPubKeyBytes)}`);

  const { publicKey: mlkemEncapsKey, secretKey: mlkemDecapsKey } = ml_kem768.keygen(kemSeed);
  console.log(`[derivePQKeysFromPRF] ML-KEM-768 encaps key: ${toHex(mlkemEncapsKey).slice(0, 20)}... (${mlkemEncapsKey.length} bytes)`);
  console.log(`[derivePQKeysFromPRF] ML-KEM-768 decaps key: ${mlkemDecapsKey.length} bytes (never stored)`);

  const pqMetaAddress = toHex(
    concat([new Uint8Array([0x00]), spendingPubKeyBytes, viewingPubKeyBytes, mlkemEncapsKey]),
  ) as `0x${string}`;
  console.log(`[derivePQKeysFromPRF] PQ meta-address (${(pqMetaAddress.length - 2) / 2} bytes): ${pqMetaAddress.slice(0, 20)}...`);

  return {
    spendingPrivateKey: toHex(spendSeed)          as `0x${string}`,
    spendingPublicKey:  toHex(spendingPubKeyBytes) as `0x${string}`,
    viewingPrivateKey:  toHex(viewSeed)            as `0x${string}`,
    viewingPublicKey:   toHex(viewingPubKeyBytes)  as `0x${string}`,
    mlkemEncapsKey,
    mlkemDecapsKey,
    pqMetaAddress,
  };
}

// Validates the off-chain-distributed meta-address format:
// 0x00 + pk_spend(33) + pk_view(33) + mlkemEncapsKey(1184) = 1251 bytes.
export function isPQMetaAddress(input: string): input is `0x${string}` {
  return /^0x00[0-9a-fA-F]{2500}$/.test(input.trim());
}

// ── Stealth Safe address prediction ──────────────────────────────────────────
// The stealth address is a predicted Safe (not an EOA): lets the receiver spend
// ERC-20s with no native ETH, since the paymaster sponsors deploy + first tx.
// Sender and receiver derive the same saltNonce from h, so they predict the
// same address without any coordination.
async function predictStealthSafeAddress(
  ownerAddress: `0x${string}`,
  saltNonce: bigint,
): Promise<`0x${string}`> {
  // Sender side: predict from the owner ADDRESS alone (no key). The view-only
  // predictor derives the same Safe the receiver later builds from the key —
  // verified offline (view == real). Lazy import keeps permissionless out of
  // bundles that never transact.
  const { predictSafeAddress } = await import("./aa-client");
  return (await predictSafeAddress(ownerAddress, saltNonce)) as `0x${string}`;
}

// ── Stealth payment generation (sender side) ──────────────────────────────────

export interface StealthPayment {
  stealthAddress:  `0x${string}`;
  ephemeralPubkey: `0x${string}`; // 33 bytes compressed
  kemCiphertext:   `0x${string}`; // 1088 bytes
  viewTag:         number;
  calldataBlob:    `0x${string}`; // MAGIC(4) ‖ viewTag(1) ‖ R(33) ‖ ctKEM(1088) — rides on the payment tx
}

export async function generateStealthPayment(metaAddressHex: `0x${string}`): Promise<StealthPayment> {
  const { getPublicKey, getSharedSecret, Point, utils } = await import("@noble/secp256k1");
  const { ml_kem768 } = await import("@noble/post-quantum/ml-kem.js");

  const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

  // Parse meta-address: 0x00 + pk_spend(33) + pk_view(33) + mlkemEncapsKey(1184)
  const bytes = hexToBytes(metaAddressHex);
  const pkSpendBytes    = bytes.slice(1, 34);
  const pkViewBytes     = bytes.slice(34, 67);
  const mlkemEncapsKey  = bytes.slice(67);       // 1184 bytes

  // Ephemeral secp256k1 keypair
  const ephemeralPriv   = utils.randomPrivateKey();
  const ephemeralPubKey = getPublicKey(ephemeralPriv, true); // 33 bytes compressed

  // ECDH with recipient's viewing key → shared X
  const sharedCompressed = getSharedSecret(ephemeralPriv, pkViewBytes, true);
  const sharedX          = sharedCompressed.slice(1); // 32 bytes

  // ML-KEM encapsulate → ciphertext (1088 bytes) + shared secret (32 bytes)
  const { cipherText: kemCiphertext, sharedSecret: kemSharedSecret } = ml_kem768.encapsulate(mlkemEncapsKey);

  // h = keccak256(sharedX || kemSharedSecret)
  const h       = keccak256(toHex(concat([sharedX, kemSharedSecret])));
  const viewTag = parseInt(h.slice(2, 4), 16);
  const hScalar = BigInt(h) % SECP256K1_N;

  // Stealth owner key: pk_spend + hScalar*G → keccak256(uncompressed[1:])[12:]
  const stealthPoint    = Point.fromHex(pkSpendBytes).add(Point.BASE.multiply(hScalar));
  const uncompressed    = stealthPoint.toRawBytes(false); // 65 bytes
  const addrHash        = keccak256(toHex(uncompressed.slice(1)));
  const stealthOwner    = getAddress(`0x${addrHash.slice(-40)}`) as `0x${string}`;

  // The actual stealth address is a predicted Safe owned by stealthOwner —
  // lets the receiver spend ERC-20s with no native ETH (paymaster sponsors gas).
  const saltNonce      = BigInt(h);
  const stealthAddress = await predictStealthSafeAddress(stealthOwner, saltNonce);

  // Δ: the blob is the tx calldata itself — no announcer call.
  const calldataBlob = toHex(
    concat([hexToBytes(STEALTH_MAGIC), new Uint8Array([viewTag]), ephemeralPubKey, kemCiphertext])
  ) as `0x${string}`;

  console.log(`[generateStealthPayment] stealthOwner (EOA): ${stealthOwner}`);
  console.log(`[generateStealthPayment] stealthAddress (Safe): ${stealthAddress}`);
  console.log(`[generateStealthPayment] viewTag: 0x${viewTag.toString(16).padStart(2, "0")}`);
  console.log(`[generateStealthPayment] calldataBlob: ${(calldataBlob.length - 2) / 2} bytes (no announcer)`);

  return {
    stealthAddress,
    ephemeralPubkey: toHex(ephemeralPubKey) as `0x${string}`,
    kemCiphertext:   toHex(kemCiphertext)   as `0x${string}`,
    viewTag,
    calldataBlob,
  };
}

// Rebuilds the shareable ticket (= the calldataBlob) for a stored UTXO, so the
// UI can re-show it after creation. Needs `viewTag` (only present on UTXOs we
// minted/imported under the Courier flow); returns null otherwise.
export function buildStealthTicket(utxo: StealthUTXO): `0x${string}` | null {
  if (typeof utxo.viewTag !== "number") return null;
  return toHex(
    concat([hexToBytes(STEALTH_MAGIC), new Uint8Array([utxo.viewTag]), hexToBytes(utxo.ephemeralPubkey), hexToBytes(utxo.kemCiphertext)]),
  ) as `0x${string}`;
}

// ── Calldata blob extraction ─────────────────────────────────────────────────

export interface StealthBlob {
  viewTag:         number;
  ephemeralPubkey: `0x${string}`;
  kemCiphertext:   `0x${string}`;
}

// Finds every well-formed stealth blob inside arbitrary calldata. The blob is
// nested verbatim in the outer handleOps() calldata (ABI encoding keeps the
// raw bytes contiguous), so a pattern scan over the tx input is enough.
export function extractStealthBlobs(input: `0x${string}`): StealthBlob[] {
  const hex = input.toLowerCase();
  const magic = STEALTH_MAGIC.slice(2);
  const blobs: StealthBlob[] = [];

  let at = hex.indexOf(magic, 2);
  while (at !== -1) {
    // Hex offsets within the match: magic(8) ‖ viewTag(2) ‖ R(66) ‖ ct(2176)
    const end = at + STEALTH_BLOB_LENGTH * 2;
    if (end <= hex.length) {
      const viewTag = parseInt(hex.slice(at + 8, at + 10), 16);
      const rHex    = hex.slice(at + 10, at + 76);
      // Compressed secp256k1 point starts with 02/03 — cheap sanity filter
      if (rHex.startsWith("02") || rHex.startsWith("03")) {
        blobs.push({
          viewTag,
          ephemeralPubkey: `0x${rHex}` as `0x${string}`,
          kemCiphertext:   `0x${hex.slice(at + 76, end)}` as `0x${string}`,
        });
      }
    }
    at = hex.indexOf(magic, at + 8);
  }
  return blobs;
}

// ── Payment check (receiver side) ────────────────────────────────────────────

export interface StealthUTXO {
  stealthAddress:  `0x${string}`;
  ephemeralPubkey: `0x${string}`; // 33 bytes
  kemCiphertext:   `0x${string}`; // 1088 bytes
  blockNumber:     number;
  // Set when WE pre-mint a receive address (Δ off-chain "Courier" flow) instead
  // of discovering it by scan. Lets the UI list/label pending receive addresses.
  createdAt?:      number;        // epoch ms at mint time
  memo?:           string;        // optional human label ("rent from Bob")
  viewTag?:        number;        // h[0] — lets us rebuild the ticket for re-check
  receivedAt?:     number;        // epoch ms first seen funded (status + safe-hide)
  spentAt?:        number;        // epoch ms first seen drained to 0 AFTER funding —
  //   the tombstone. Its presence means "spent": the UTXO drops out of every
  //   balance multicall and spend planner (one-time addresses never refund), so
  //   dead addresses stop costing RPC. Data KEPT (history); purge is opt-in and
  //   only ever touches re-derivable notes (see localOnly).
  localOnly?:      boolean;       // true = the local note is the ONLY copy of the
  //   spending key (ghost-mode unshield / off-chain Courier import — no on-chain
  //   blob to re-derive from). NEVER hard-purged, even in purge mode: deleting it
  //   = funds unspendable forever. Absent/false = re-derivable by chain re-scan.
  hidden?:         boolean;       // user hid it from the list (data KEPT — never deleted)
  // Asset held at this stealth address, TAGGED ONCE on first discovery (the blob
  // carries no asset). undefined = native ETH; an ERC20 contract address = that
  // token. One-time addresses ⇒ exactly one asset per UTXO, so this never needs
  // re-probing: refresh/spend read only this one token, not the whole curated set.
  asset?:          `0x${string}`;
}

// Trial-decrypts one blob. Returns the derived stealth Safe address if the
// blob is ours, null otherwise. Unlike the announcer flow there is no announced
// address to compare against: the derived address IS the payment destination
// (the caller can confirm with a balance check).
export async function checkPQPayment(
  spendingPrivateKey: `0x${string}`,
  viewingPrivateKey:  `0x${string}`,
  mlkemDecapsKey:     Uint8Array,
  blob:               StealthBlob,
): Promise<`0x${string}` | null> {
  const { getPublicKey, getSharedSecret, Point } = await import("@noble/secp256k1");
  const { ml_kem768 } = await import("@noble/post-quantum/ml-kem.js");

  const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

  const skViewBytes  = hexToBytes(viewingPrivateKey);
  const skSpendBytes = hexToBytes(spendingPrivateKey);
  const pkSpendBytes = getPublicKey(skSpendBytes, true);
  const R            = hexToBytes(blob.ephemeralPubkey);
  const ct           = hexToBytes(blob.kemCiphertext);

  let sharedX: Uint8Array;
  let sharedKem: Uint8Array;
  try {
    sharedX   = getSharedSecret(skViewBytes, R, true).slice(1);
    sharedKem = ml_kem768.decapsulate(ct, mlkemDecapsKey);
  } catch {
    return null; // malformed point/ciphertext — false positive of the pattern scan
  }

  const h       = keccak256(toHex(concat([sharedX, sharedKem])));
  const viewTag = parseInt(h.slice(2, 4), 16);

  if (viewTag !== blob.viewTag) return null;

  const hScalar = BigInt(h) % SECP256K1_N;

  const stealthPoint = Point.fromHex(pkSpendBytes).add(Point.BASE.multiply(hScalar));
  const uncompressed = stealthPoint.toRawBytes(false);
  const addrHash     = keccak256(toHex(uncompressed.slice(1)));
  const stealthOwner = getAddress(`0x${addrHash.slice(-40)}`) as `0x${string}`;

  // Re-derive the predicted Safe address — same saltNonce the sender computed.
  const saltNonce = BigInt(h);
  return await predictStealthSafeAddress(stealthOwner, saltNonce);
}

// ── Payment scanning ─────────────────────────────────────────────────────────

// RESERVED for the future opt-in "check for earlier payments" deep-scan. NOT used
// by the default login scan anymore: login/register with no cursor start at "now"
// (see runStealthScan). This block-fixed value was Sepolia-calibrated (~3 days at
// 12s/block) and under-covers fast chains, so the deep-scan should move to a
// per-network time-based lookback rather than reuse this raw count as-is.
export const STEALTH_SCAN_DEFAULT_BLOCKS = 21600n;

// viem coalesces same-tick requests to the SAME url into one POST per this many.
// The scheduler is global and keyed by url (viem's createBatchScheduler), so it
// still batches even though a client is built per rotation below.
const RPC_BATCH_SIZE = 17;
// One slice = one tick = exactly ONE POST. Keeping these equal is what lets the
// pacer below count POSTs instead of guessing at them.
const TX_SLICE_PER_RPC = RPC_BATCH_SIZE;
// Sustained POSTs per second, PER rpc, for the fan-out.
//
// This brake used to exist by accident: a 10k window held ~190 candidates, and
// WINDOW_DELAY_MS paused between windows, so the request rate was a side effect of
// the window size. Widening the window to 200k removed the brake without replacing
// it — 4900 candidates went out back to back and the public nodes answered with a
// wall of 429s (tenderly) and 500s (pocket). So: the brake is explicit now, and it
// is per NODE and independent of the window, because those are different concerns.
//
// 2/s is close to what the old serial-wave code aimed at its single primary (~12
// POSTs across a ~6.6s window) and was never rate-limited for, so it is a rate this
// fleet is known to tolerate rather than one that seemed fine in a benchmark. Node
// CANNOT measure the real ceiling here — no CORS, no Origin, no preflight, and it
// has already reported "0 errors" for a fleet that was half on fire in the browser.
// Raise it only against numbers taken from the app's own console.
const FANOUT_POSTS_PER_SEC = 2;
const WINDOW_DELAY_MS = 200;
// Backoff between retries of a single failed candidate. Linear, so five attempts
// span ~6s — a 429 wants seconds, not the ~100ms that a transport hiccup wants.
const RETRY_DELAY_MS = 400;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Per-url pacer for the fan-out. Hands out monotonically spaced departure slots, so
// however many shards, windows or concurrent scans are in flight, two POSTs to the
// same node can never leave closer than 1/FANOUT_POSTS_PER_SEC apart. Module-level
// on purpose: overlapping scans (login + a manual refresh) share one node's budget
// rather than each helping themselves to a full one.
const pacers = new Map<string, () => Promise<void>>();
const pacer = (url: string) => {
  let p = pacers.get(url);
  if (!p) {
    let next = 0;
    const gap = 1000 / FANOUT_POSTS_PER_SEC;
    p = async () => {
      const now = Date.now();
      const at = Math.max(now, next);
      next = at + gap;
      if (at > now) await sleep(at - now);
    };
    pacers.set(url, p);
  }
  return p;
};

// Scans for incoming stealth payments without any announcer: uses the
// EntryPoint's UserOperationEvent as a free index (every 4337 tx emits it,
// stealth or not — it carries no scheme fingerprint), fetches each candidate
// tx once, pattern-matches the calldata for the magic prefix and
// trial-decrypts whatever it finds. Direct EOA payments carrying the blob in
// tx.input would need block-level scanning — out of scope here, since Δ
// always pays through the EntryPoint.
export async function scanStealthPayments(
  spendingPrivateKey: `0x${string}`,
  viewingPrivateKey:  `0x${string}`,
  mlkemDecapsKey:     Uint8Array,
  fromBlock:          bigint,
  // Called after EACH window (1000-block chunk) with that window's NEW UTXOs and
  // the window's end block. The caller persists the UTXOs to idb AND advances the
  // cursor here; the scan AWAITS it before the next window, so the cursor can
  // never outrun the persisted UTXOs (resumable, no UTXO ever skipped).
  onWindow?: (windowUtxos: StealthUTXO[], windowEnd: bigint) => Promise<void>,
  // Called with (blocksCovered, totalBlocks) at the start (0/total) and after each
  // window, so the UI can draw a determinate bar. Block-based (not window count)
  // because windows are variable-width now (each RPC serves its own range).
  onProgress?: (done: number, total: number) => void,
  // Optional CEILING for the scan (default: the chain tip). Only the calendar
  // deep-scan passes it — a bounded window anywhere in the past, so a user who
  // was paid a month ago doesn't have to sweep the whole month to find it. Last
  // param on purpose: the forward scan always runs to the tip and must stay
  // untouched. Treated as a ceiling only, never a floor — a value past the tip
  // clamps back to it rather than scanning blocks that don't exist yet.
  toBlock?: bigint,
): Promise<{ utxos: StealthUTXO[]; latestBlock: bigint }> {
  const { createPublicClient, http, fallback, parseAbiItem } = await import("viem");
  const { activeChain, activeLogsRpcs, activeScanRpcUrls, scanPaymasters } =
    await import("@/lib/networks");
  const { RPC_URLS } = await import("@/app/constants");

  // JSON-RPC batching: the getTransaction fan-out fires many node calls in one tick
  // — coalesce them into one POST per RPC_BATCH_SIZE instead of N round-trips.
  // Conservative size so picky public RPCs accept it; if one rejects a batch, the
  // fallback transport rotates to the next.
  const batchHttp = (u: string) => http(u, { batch: { batchSize: RPC_BATCH_SIZE, wait: 16 } });
  // Round-robin the PRIMARY rpc. viem's fallback always hits transport[0] first on
  // every request → without rotation the primary eats ALL the fan-out and chokes
  // while the others idle (it's failover, not load spreading). Rotating the order
  // hands each shard a different primary while keeping full fallback inside it.
  // Memoised: a fresh client per candidate churned hundreds of objects per window
  // (harmless for batching — viem keys its scheduler by url, not by client — but
  // pure waste).
  const buildClient = (urls: readonly string[], rot: number) => {
    const r = ((rot % urls.length) + urls.length) % urls.length;
    const rotated = [...urls.slice(r), ...urls.slice(0, r)];
    return createPublicClient({ chain: activeChain(), transport: fallback(rotated.map(batchHttp)) });
  };
  const clientCache = new Map<number, ReturnType<typeof buildClient>>();
  const makeClient = (rot: number) => {
    const r = ((rot % RPC_URLS.length) + RPC_URLS.length) % RPC_URLS.length;
    let c = clientCache.get(r);
    if (!c) { c = buildClient(RPC_URLS, r); clientCache.set(r, c); }
    return c;
  };
  // Paymaster filter (indexed): only OUR sponsored UserOps, not the whole chain's
  // 4337 traffic. Complete by construction (every Δ payment is an EntryPoint op we
  // sponsor). undefined → no filter, scan all EntryPoint ops (Sepolia).
  const paymasters = scanPaymasters();
  const userOpEvent = parseAbiItem(
    "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
  );

  // getLogs endpoints, in order (widest/fastest first), EACH with its own max block
  // range (window). We rotate by hand instead of viem's fallback() because fallback()
  // hides which node answered — and the whole point is to ask each node ONLY what it
  // serves: tenderly a 500k window (a month in ~17s), lava/pocket 50k. A window bigger
  // than a node's cap fails, sometimes silently ([] with no error → a scan gap), so
  // never asking past a cap is the safety, not a nicety. One single-transport client
  // per url (no fallback, no batching — getLogs is one call).
  const logsRpcs = activeLogsRpcs().map((r) => ({
    url: r.url,
    window: BigInt(r.window),
    client: createPublicClient({ chain: activeChain(), transport: http(r.url) }),
  }));
  // tip: one call; a fallback across the same nodes is fine (no window concern here).
  const tipClient = createPublicClient({
    chain: activeChain(),
    transport: fallback(logsRpcs.map((r) => http(r.url))),
  });
  const tip = await tipClient.getBlockNumber();
  const latestBlock = toBlock !== undefined && toBlock < tip ? toBlock : tip;

  // Adaptive getLogs for the range starting at `from`: try each node at ITS window;
  // the first that answers sets how far this window reached (returned as `to`). If
  // ALL fail, THROW — the caller aborts before the cursor advances (resumable, no
  // silent gap). A node that throws for a transient reason just cedes this window to
  // the next (smaller-range) node; the next loop retries the wide node.
  const getLogsAdaptive = async (from: bigint) => {
    let lastErr: unknown;
    for (const rpc of logsRpcs) {
      const to = from + rpc.window - 1n < latestBlock ? from + rpc.window - 1n : latestBlock;
      try {
        const logs = await rpc.client.getLogs({
          address: ENTRYPOINT_ADDRESS,
          event: userOpEvent,
          ...(paymasters ? { args: { paymaster: [...paymasters] } } : {}),
          fromBlock: from,
          toBlock: to,
        });
        return { logs, to };
      } catch (e) {
        lastErr = e;
      }
    }
    throw new Error(
      `getLogs failed on all ${logsRpcs.length} logs RPCs at block ${from}: ${(lastErr as Error)?.message ?? lastErr}`,
    );
  };

  // Which rpcs the fan-out aims at first, as rotations into RPC_URLS. One shard each,
  // so the shard count is the number of HEALTHY nodes — sharding across the dead ones
  // too just routes their share onto the living via fallback, at the price of a failed
  // round trip each. Empty (a network with no curated list) → aim at all of them.
  const fanoutRots = activeScanRpcUrls()
    .map((u) => RPC_URLS.indexOf(u))
    .filter((i) => i >= 0);
  const primaries = fanoutRots.length > 0 ? fanoutRots : RPC_URLS.map((_, i) => i);

  console.log(
    `[scanStealthPayments] Scanning blocks ${fromBlock} → ${latestBlock} in per-RPC windows` +
      `${paymasters ? ` (paymaster-filtered ×${paymasters.length})` : ""} (checkpointed)`,
  );

  const allUtxos: StealthUTXO[] = [];
  let windowCount = 0;
  // Determinate progress by BLOCKS, not window count: windows are variable-width now
  // (each node serves its own range), so blocks-covered / total-blocks is the honest
  // fraction. The bar renders done/total as a ratio (showCount=false), so this drives
  // it unchanged.
  const totalBlocks = latestBlock >= fromBlock ? Number(latestBlock - fromBlock + 1n) : 0;
  onProgress?.(0, totalBlocks);

  // Window by window: getLogsAdaptive picks a node + a range it can serve → returns
  // the logs AND how far it reached (`to`) → getTransaction fan-out → trial-decrypt →
  // tag assets → hand the window's UTXOs to onWindow (which persists them + advances
  // the cursor) BEFORE moving on. The window WIDTH is variable now (whatever node
  // served it), so `to` drives the advance. The per-window cursor keeps a long backlog
  // resumable: if it stops mid-way it resumes from the last persisted window, never
  // re-scanning what's already in idb.
  for (let from = fromBlock; from <= latestBlock; ) {
    const { logs, to } = await getLogsAdaptive(from);
    windowCount++;

    // Rotated client for this window's non-getLogs work (asset tagging below).
    const client = makeClient(windowCount);

    const txBlocks = new Map<`0x${string}`, bigint>();
    for (const log of logs) {
      if (log.transactionHash) txBlocks.set(log.transactionHash, log.blockNumber ?? 0n);
    }

    const windowUtxos: StealthUTXO[] = [];
    const txEntries = Array.from(txBlocks.entries());

    // Fetch ONE candidate, retrying across ROTATED rpcs with linear backoff. A tx we
    // can't fetch must NEVER be silently skipped — it could carry a stealth payment.
    // If it still fails after retries, THROW: that aborts the window BEFORE the cursor
    // advances (onWindow), so a later scan re-covers this range (resumable) instead of
    // losing funds. Transient 429s recover within the retries.
    const fetchCandidate = async (hash: `0x${string}`, blockNumber: bigint, rot: number) => {
      let lastErr: unknown;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const tx = await makeClient(rot + attempt).getTransaction({ hash });
          return { input: tx.input as `0x${string}`, blockNumber };
        } catch (e) {
          lastErr = e;
          await sleep(RETRY_DELAY_MS * (attempt + 1));
        }
      }
      throw new Error(`getTransaction ${hash} failed after retries: ${(lastErr as Error)?.message ?? lastErr}`);
    };

    // Shard the window's candidates across the healthy primaries and fetch the shards
    // CONCURRENTLY, each paced to FANOUT_POSTS_PER_SEC. The old code sent a whole
    // window to ONE primary in serial waves while the others idled: same work, N× the
    // wall clock. Sharding buys that N× — but only if every shard has a live node to
    // land on, and only if something still caps the rate each node sees, which is why
    // the pacer exists.
    const shards: [`0x${string}`, bigint][][] = primaries.map(() => []);
    txEntries.forEach((entry, i) => shards[i % shards.length].push(entry));

    const results = (
      await Promise.all(
        shards.map(async (shard, s) => {
          const rot = primaries[s];
          const waitTurn = pacer(RPC_URLS[rot]);
          const out: { input: `0x${string}`; blockNumber: bigint }[] = [];
          for (let i = 0; i < shard.length; i += TX_SLICE_PER_RPC) {
            await waitTurn();
            // A slice goes out in ONE tick so viem's batcher coalesces it into a
            // single POST. Feeding it one request at a time would defeat batching:
            // each would wait out its 16ms window alone and go as its own request.
            const slice = shard.slice(i, i + TX_SLICE_PER_RPC);
            out.push(...(await Promise.all(slice.map(([hash, b]) => fetchCandidate(hash, b, rot)))));
          }
          return out;
        }),
      )
    ).flat();

    for (const result of results) {
      const blobs = extractStealthBlobs(result.input);
      for (const blob of blobs) {
        const match = await checkPQPayment(spendingPrivateKey, viewingPrivateKey, mlkemDecapsKey, blob);
        if (match) {
          console.log(`[scanStealthPayments] ✓ UTXO detected: ${match} (block ${result.blockNumber})`);
          windowUtxos.push({
            stealthAddress:  match,
            ephemeralPubkey: blob.ephemeralPubkey,
            kemCiphertext:   blob.kemCiphertext,
            blockNumber:     Number(result.blockNumber),
          });
        }
      }
    }

    // Tag each freshly-found UTXO with its asset ONCE (the blob carries none) —
    // one Multicall3 per curated token over THIS window's addresses.
    if (windowUtxos.length > 0) {
      try {
        const { activeTokens } = await import("@/lib/assets");
        const { getTokenBalances } = await import("@/lib/balances");
        const addrs = windowUtxos.map((u) => u.stealthAddress);
        for (const t of activeTokens()) {
          const bals = await getTokenBalances(client, t.address as `0x${string}`, addrs);
          bals.forEach((b, i) => {
            if (b > 0n && !windowUtxos[i].asset) windowUtxos[i].asset = t.address as `0x${string}`;
          });
        }
      } catch (e) {
        console.warn("[scanStealthPayments] asset tagging failed (UTXOs stay native):", e);
      }
    }

    if (logs.length > 0 || windowUtxos.length > 0) {
      console.log(`[scanStealthPayments] window ${windowCount} (${from}–${to}): ${logs.length} ops → ${windowUtxos.length} UTXOs`);
    }

    allUtxos.push(...windowUtxos);
    // Persist this window + advance the cursor BEFORE the next window. AWAITED so
    // the cursor never moves past UTXOs not yet in idb (resumable, nothing skipped).
    if (onWindow) await onWindow(windowUtxos, to);
    onProgress?.(Number(to - fromBlock + 1n), totalBlocks);

    if (to < latestBlock) await sleep(WINDOW_DELAY_MS); // breathe between windows
    from = to + 1n; // advance by what the serving node actually covered
  }

  console.log(`[scanStealthPayments] Done — ${allUtxos.length} UTXOs over ${windowCount} windows`);
  return { utxos: allUtxos, latestBlock };
}

// Re-derives the spending key for a specific stealth UTXO (call when spending, never store).
export async function deriveStealthSpendingKey(
  spendingPrivateKey: `0x${string}`,
  viewingPrivateKey:  `0x${string}`,
  mlkemDecapsKey:     Uint8Array,
  ephemeralPubkey:    `0x${string}`,
  kemCiphertext:      `0x${string}`,
): Promise<`0x${string}`> {
  const { getSharedSecret } = await import("@noble/secp256k1");
  const { ml_kem768 }       = await import("@noble/post-quantum/ml-kem.js");

  const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

  const skViewBytes = hexToBytes(viewingPrivateKey);
  const R           = hexToBytes(ephemeralPubkey);
  const ct          = hexToBytes(kemCiphertext);

  const sharedCompressed = getSharedSecret(skViewBytes, R, true);
  const sharedX          = sharedCompressed.slice(1);
  const sharedKem        = ml_kem768.decapsulate(ct, mlkemDecapsKey);

  const h       = keccak256(toHex(concat([sharedX, sharedKem])));
  const hScalar = BigInt(h) % SECP256K1_N;

  const skStealthScalar = (BigInt(spendingPrivateKey) + hScalar) % SECP256K1_N;
  return `0x${skStealthScalar.toString(16).padStart(64, "0")}` as `0x${string}`;
}

// Re-derives h = keccak256(sharedX || kemSharedSecret) for a UTXO — the same
// value used to compute saltNonce when predicting its stealth Safe address.
export async function deriveStealthH(
  viewingPrivateKey: `0x${string}`,
  mlkemDecapsKey:    Uint8Array,
  ephemeralPubkey:   `0x${string}`,
  kemCiphertext:     `0x${string}`,
): Promise<`0x${string}`> {
  const { getSharedSecret } = await import("@noble/secp256k1");
  const { ml_kem768 }       = await import("@noble/post-quantum/ml-kem.js");

  const sharedCompressed = getSharedSecret(hexToBytes(viewingPrivateKey), hexToBytes(ephemeralPubkey), true);
  const sharedX          = sharedCompressed.slice(1);
  const sharedKem        = ml_kem768.decapsulate(hexToBytes(kemCiphertext), mlkemDecapsKey);

  return keccak256(toHex(concat([sharedX, sharedKem])));
}
