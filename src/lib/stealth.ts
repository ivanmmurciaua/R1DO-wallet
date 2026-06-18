import { keccak256, toHex, concat, hexToBytes, getAddress } from "viem";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";

// ── Δ1: announcer-less delivery ──────────────────────────────────────────────
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
  saltNonce: string,
): Promise<`0x${string}`> {
  const { Safe4337Pack } = await import("@safe-global/relay-kit");
  const {
    RPC_URL, BUNDLER_URL, PAYMASTER_URL,
    ENTRYPOINT_ADDRESS, SAFE_MODULES_ADDRESS, SAFE_MODULES_VERSION, SAFE_SW_VERSION,
  } = await import("@/app/constants");

  const pack = await Safe4337Pack.init({
    provider: RPC_URL,
    bundlerUrl: BUNDLER_URL,
    safeModulesVersion: SAFE_MODULES_VERSION,
    customContracts: {
      entryPointAddress: ENTRYPOINT_ADDRESS,
      safe4337ModuleAddress: SAFE_MODULES_ADDRESS,
    },
    paymasterOptions: { isSponsored: true, paymasterUrl: PAYMASTER_URL },
    options: {
      owners: [ownerAddress],
      threshold: 1,
      safeVersion: SAFE_SW_VERSION,
      saltNonce,
    },
  });

  return (await pack.protocolKit.getAddress()) as `0x${string}`;
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
  const saltNonce      = BigInt(h).toString();
  const stealthAddress = await predictStealthSafeAddress(stealthOwner, saltNonce);

  // Δ1: the blob is the tx calldata itself — no announcer call.
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
  // Set when WE pre-mint a receive address (Δ1 off-chain "Courier" flow) instead
  // of discovering it by scan. Lets the UI list/label pending receive addresses.
  createdAt?:      number;        // epoch ms at mint time
  memo?:           string;        // optional human label ("rent from Bob")
  viewTag?:        number;        // h[0] — lets us rebuild the ticket for re-check
  receivedAt?:     number;        // epoch ms first seen funded (status + safe-hide)
  hidden?:         boolean;       // user hid it from the list (data KEPT — never deleted)
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
  const saltNonce = BigInt(h).toString();
  return await predictStealthSafeAddress(stealthOwner, saltNonce);
}

// ── Payment scanning ─────────────────────────────────────────────────────────

// ~3 days back on Sepolia (12s block time → ~7200 blocks/day)
export const STEALTH_SCAN_DEFAULT_BLOCKS = 21600n;

// How many candidate txs to fetch concurrently
const TX_FETCH_BATCH = 20;

// Scans for incoming stealth payments without any announcer: uses the
// EntryPoint's UserOperationEvent as a free index (every 4337 tx emits it,
// stealth or not — it carries no scheme fingerprint), fetches each candidate
// tx once, pattern-matches the calldata for the magic prefix and
// trial-decrypts whatever it finds. Direct EOA payments carrying the blob in
// tx.input would need block-level scanning — out of scope here, since Δ1
// always pays through the EntryPoint.
export async function scanStealthPayments(
  spendingPrivateKey: `0x${string}`,
  viewingPrivateKey:  `0x${string}`,
  mlkemDecapsKey:     Uint8Array,
  fromBlock:          bigint,
): Promise<{ utxos: StealthUTXO[]; latestBlock: bigint }> {
  const { createPublicClient, http, fallback, parseAbiItem } = await import("viem");
  const { sepolia } = await import("viem/chains");
  const { RPC_URLS } = await import("@/app/constants");

  const publicClient = createPublicClient({ chain: sepolia, transport: fallback(RPC_URLS.map((u) => http(u))) });
  const latestBlock = await publicClient.getBlockNumber();

  const totalBlocks = latestBlock - fromBlock;
  console.log(`[scanStealthPayments] Scanning blocks ${fromBlock} → ${latestBlock} (${totalBlocks} blocks, batches of 1000)`);

  const CHUNK = 1000n;
  const userOpEvent = parseAbiItem(
    "event UserOperationEvent(bytes32 indexed userOpHash, address indexed sender, address indexed paymaster, uint256 nonce, bool success, uint256 actualGasCost, uint256 actualGasUsed)",
  );

  // Collect candidate txs (deduped — one handleOps tx bundles many UserOps)
  const txBlocks = new Map<`0x${string}`, bigint>();
  let batchCount = 0;
  for (let from = fromBlock; from <= latestBlock; from += CHUNK) {
    const to = from + CHUNK - 1n < latestBlock ? from + CHUNK - 1n : latestBlock;
    const chunk = await publicClient.getLogs({
      address: ENTRYPOINT_ADDRESS,
      event: userOpEvent,
      fromBlock: from,
      toBlock: to,
    });
    for (const log of chunk) {
      if (log.transactionHash) txBlocks.set(log.transactionHash, log.blockNumber ?? 0n);
    }
    batchCount++;
    if (chunk.length > 0) console.log(`[scanStealthPayments] batch ${batchCount}: blocks ${from}–${to} → ${chunk.length} userOps`);
  }

  console.log(`[scanStealthPayments] ${txBlocks.size} candidate txs found in ${batchCount} batches`);

  const utxos: StealthUTXO[] = [];
  const txEntries = Array.from(txBlocks.entries());

  for (let i = 0; i < txEntries.length; i += TX_FETCH_BATCH) {
    const slice = txEntries.slice(i, i + TX_FETCH_BATCH);
    const results = await Promise.all(
      slice.map(async ([hash, blockNumber]) => {
        try {
          const tx = await publicClient.getTransaction({ hash });
          return { input: tx.input as `0x${string}`, blockNumber };
        } catch {
          return null;
        }
      }),
    );

    for (const result of results) {
      if (!result) continue;
      const blobs = extractStealthBlobs(result.input);
      for (const blob of blobs) {
        const match = await checkPQPayment(spendingPrivateKey, viewingPrivateKey, mlkemDecapsKey, blob);
        if (match) {
          console.log(`[scanStealthPayments] ✓ UTXO detected: ${match} (block ${result.blockNumber})`);
          utxos.push({
            stealthAddress:  match,
            ephemeralPubkey: blob.ephemeralPubkey,
            kemCiphertext:   blob.kemCiphertext,
            blockNumber:     Number(result.blockNumber),
          });
        }
      }
    }
  }

  console.log(`[scanStealthPayments] Done — ${utxos.length} UTXOs found`);
  return { utxos, latestBlock };
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
