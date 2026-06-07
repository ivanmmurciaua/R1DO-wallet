import { keccak256, toHex, concat, hexToBytes, getAddress } from "viem";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";

// ERC-6538 Stealth Meta-Address Registry (same address on all chains)
export const STEALTH_REGISTRY_ADDRESS =
  "0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538" as const;

export const STEALTH_SCHEME_ID = 4n; // PQ hybrid: secp256k1 + ML-KEM-768

export const STEALTH_REGISTRY_ABI = [
  {
    name: "registerKeys",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "schemeId",           type: "uint256" },
      { name: "stealthMetaAddress", type: "bytes"   },
    ],
    outputs: [],
  },
  {
    name: "stealthMetaAddressOf",
    type: "function",
    stateMutability: "view",
    inputs: [
      { name: "registrant", type: "address" },
      { name: "schemeId",   type: "uint256" },
    ],
    outputs: [{ name: "", type: "bytes" }],
  },
] as const;

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

// ── ERC-6538 registration check ──────────────────────────────────────────────

// ── ERC-5564 Announcer ────────────────────────────────────────────────────────

export const ANNOUNCER_ADDRESS =
  "0x55649E01B5Df198D18D95b5cc5051630cfD45564" as const;

export const ANNOUNCER_ABI = [
  {
    name: "announce",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "schemeId",       type: "uint256" },
      { name: "stealthAddress", type: "address" },
      { name: "ephemeralPubKey",type: "bytes"   },
      { name: "metadata",       type: "bytes"   },
    ],
    outputs: [],
  },
  {
    name: "Announcement",
    type: "event",
    inputs: [
      { name: "schemeId",       type: "uint256",  indexed: true  },
      { name: "stealthAddress", type: "address",  indexed: true  },
      { name: "caller",         type: "address",  indexed: true  },
      { name: "ephemeralPubKey",type: "bytes",    indexed: false },
      { name: "metadata",       type: "bytes",    indexed: false },
    ],
  },
] as const;

// ── ERC-6538 registration check ──────────────────────────────────────────────

export async function isStealthRegistered(safeAddress: string): Promise<boolean> {
  const { createPublicClient, http } = await import("viem");
  const { sepolia } = await import("viem/chains");

  const publicClient = createPublicClient({ chain: sepolia, transport: http("https://sepolia.drpc.org") });
  const result = await publicClient.readContract({
    address: STEALTH_REGISTRY_ADDRESS,
    abi: STEALTH_REGISTRY_ABI,
    functionName: "stealthMetaAddressOf",
    args: [safeAddress as `0x${string}`, STEALTH_SCHEME_ID],
  });
  return (result as `0x${string}`).length > 2; // "0x" = not registered
}

export async function getStealthMetaAddress(safeAddress: string): Promise<`0x${string}` | null> {
  const { createPublicClient, http } = await import("viem");
  const { sepolia } = await import("viem/chains");

  const publicClient = createPublicClient({ chain: sepolia, transport: http("https://sepolia.drpc.org") });
  const result = await publicClient.readContract({
    address: STEALTH_REGISTRY_ADDRESS,
    abi: STEALTH_REGISTRY_ABI,
    functionName: "stealthMetaAddressOf",
    args: [safeAddress as `0x${string}`, STEALTH_SCHEME_ID],
  }) as `0x${string}`;
  return result.length > 2 ? result : null;
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
  stealthAddress: `0x${string}`;
  ephemeralPubkey: `0x${string}`; // 33 bytes compressed
  kemCiphertext:   `0x${string}`; // 1088 bytes
  viewTag:         number;
  metadata:        `0x${string}`; // 0x01 || viewTag(1) || kemCiphertext(1088)
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

  // metadata = 0x01 || viewTag(1 byte) || kemCiphertext(1088 bytes)
  const metadata = toHex(
    concat([new Uint8Array([0x01, viewTag]), kemCiphertext])
  ) as `0x${string}`;

  console.log(`[generateStealthPayment] stealthOwner (EOA): ${stealthOwner}`);
  console.log(`[generateStealthPayment] stealthAddress (Safe): ${stealthAddress}`);
  console.log(`[generateStealthPayment] viewTag: 0x${viewTag.toString(16).padStart(2, "0")}`);

  return {
    stealthAddress,
    ephemeralPubkey: toHex(ephemeralPubKey) as `0x${string}`,
    kemCiphertext:   toHex(kemCiphertext)   as `0x${string}`,
    viewTag,
    metadata,
  };
}

// ── Announcement scanning ────────────────────────────────────────────────────

// ~3 days back on Sepolia (12s block time → ~7200 blocks/day)
export const STEALTH_SCAN_DEFAULT_BLOCKS = 21600n;

export async function scanAnnouncements(
  spendingPrivateKey: `0x${string}`,
  viewingPrivateKey:  `0x${string}`,
  mlkemDecapsKey:     Uint8Array,
  fromBlock:          bigint,
): Promise<{ utxos: StealthUTXO[]; latestBlock: bigint }> {
  const { createPublicClient, http, parseAbiItem } = await import("viem");
  const { sepolia } = await import("viem/chains");

  const publicClient = createPublicClient({ chain: sepolia, transport: http("https://sepolia.drpc.org") });
  const latestBlock = await publicClient.getBlockNumber();

  const totalBlocks = latestBlock - fromBlock;
  console.log(`[scanAnnouncements] Scanning blocks ${fromBlock} → ${latestBlock} (${totalBlocks} blocks, batches of 1000)`);

  const CHUNK = 1000n;
  const announcementEvent = parseAbiItem(
    "event Announcement(uint256 indexed schemeId, address indexed stealthAddress, address indexed caller, bytes ephemeralPubKey, bytes metadata)",
  );

  const logs = [];
  let batchCount = 0;
  for (let from = fromBlock; from <= latestBlock; from += CHUNK) {
    const to = from + CHUNK - 1n < latestBlock ? from + CHUNK - 1n : latestBlock;
    const chunk = await publicClient.getLogs({
      address: ANNOUNCER_ADDRESS,
      event: announcementEvent,
      args: { schemeId: STEALTH_SCHEME_ID },
      fromBlock: from,
      toBlock: to,
    });
    logs.push(...chunk);
    batchCount++;
    if (chunk.length > 0) console.log(`[scanAnnouncements] batch ${batchCount}: blocks ${from}–${to} → ${chunk.length} events`);
  }

  console.log(`[scanAnnouncements] ${logs.length} scheme-4 announcements found in ${batchCount} batches`);

  const utxos: StealthUTXO[] = [];

  for (const log of logs) {
    const { stealthAddress, ephemeralPubKey, metadata } = log.args as {
      stealthAddress: `0x${string}`;
      ephemeralPubKey: `0x${string}`;
      metadata: `0x${string}`;
    };
    if (!stealthAddress || !ephemeralPubKey || !metadata) continue;

    // metadata = 0x01 || viewTag(1) || kemCiphertext(1088)
    const metaBytes = hexToBytes(metadata);
    if (metaBytes.length < 2 + 1088) continue;
    const announcedViewTag = metaBytes[1];
    const kemCiphertext    = toHex(metaBytes.slice(2)) as `0x${string}`;

    const match = await checkPQAnnouncement(
      spendingPrivateKey,
      viewingPrivateKey,
      mlkemDecapsKey,
      ephemeralPubKey,
      kemCiphertext,
      stealthAddress,
      announcedViewTag,
    );

    if (match) {
      console.log(`[scanAnnouncements] ✓ UTXO detected: ${stealthAddress} (block ${log.blockNumber})`);
      utxos.push({
        stealthAddress,
        ephemeralPubkey: ephemeralPubKey,
        kemCiphertext,
        blockNumber: Number(log.blockNumber),
      });
    }
  }

  console.log(`[scanAnnouncements] Done — ${utxos.length} UTXOs found`);
  return { utxos, latestBlock };
}

// ── Old announcement scanning interface (kept for reference) ──────────────────

export interface StealthUTXO {
  stealthAddress:  `0x${string}`;
  ephemeralPubkey: `0x${string}`; // 33 bytes
  kemCiphertext:   `0x${string}`; // 1088 bytes
  blockNumber:     number;
}

export async function checkPQAnnouncement(
  spendingPrivateKey: `0x${string}`,
  viewingPrivateKey:  `0x${string}`,
  mlkemDecapsKey:     Uint8Array,
  ephemeralPubkey:    `0x${string}`,
  kemCiphertext:      `0x${string}`,
  announcedAddress:   `0x${string}`,
  announcedViewTag:   number,
): Promise<`0x${string}` | null> {
  const { getPublicKey, getSharedSecret, Point } = await import("@noble/secp256k1");
  const { ml_kem768 } = await import("@noble/post-quantum/ml-kem.js");

  const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

  const skViewBytes  = hexToBytes(viewingPrivateKey);
  const skSpendBytes = hexToBytes(spendingPrivateKey);
  const pkSpendBytes = getPublicKey(skSpendBytes, true);
  const R            = hexToBytes(ephemeralPubkey);
  const ct           = hexToBytes(kemCiphertext);

  const sharedCompressed = getSharedSecret(skViewBytes, R, true);
  const sharedX          = sharedCompressed.slice(1);

  const sharedKem = ml_kem768.decapsulate(ct, mlkemDecapsKey);

  const h       = keccak256(toHex(concat([sharedX, sharedKem])));
  const viewTag = parseInt(h.slice(2, 4), 16);

  if (viewTag !== announcedViewTag) return null;

  const hScalar = BigInt(h) % SECP256K1_N;

  const stealthPoint = Point.fromHex(pkSpendBytes).add(Point.BASE.multiply(hScalar));
  const uncompressed = stealthPoint.toRawBytes(false);
  const addrHash     = keccak256(toHex(uncompressed.slice(1)));
  const stealthOwner = getAddress(`0x${addrHash.slice(-40)}`) as `0x${string}`;

  // Re-derive the predicted Safe address — same saltNonce as the sender computed.
  const saltNonce      = BigInt(h).toString();
  const stealthAddress = await predictStealthSafeAddress(stealthOwner, saltNonce);

  if (stealthAddress.toLowerCase() !== announcedAddress.toLowerCase()) return null;

  return stealthAddress;
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
