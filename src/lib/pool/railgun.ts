/* R1DO × Railgun — PoolAdapter (lazy).

   This module is dynamically imported only when the user enters the private
   world, so the heavy Railgun SDK (and its graphql-mesh chain) stays OUT of
   the login bundle.

   STEP 1a — engine boot only: PPOI health-check + startRailgunEngine +
   provider + Groth16 prover. No 0zk wallet, no balances, no watcher yet
   (those are 1b / 1c).

   Traces everything to the console with the `[pool]` prefix (mirrors the
   spike's `[wallet]` log) so the boot sequence is followable. Filter the
   console by `[pool]` to read just the pool flow.

   Verify with `next build` + preview — NEVER `next dev` (the SDK + Node
   polyfills behave differently under Turbopack). */

import {
  startRailgunEngine,
  loadProvider,
  getProver,
  ArtifactStore,
  createRailgunWallet,
  refreshBalances,
  rescanFullUTXOMerkletreesAndWallets,
  setOnBalanceUpdateCallback,
  refreshReceivePOIsForWallet,
  generatePOIsForWallet,
  getChainTxidsStillPendingSpentPOIs,
  setOnWalletPOIProofProgressCallback,
  populateShieldBaseToken,
  populateShield,
  gasEstimateForUnprovenTransfer,
  generateTransferProof,
  populateProvedTransfer,
  gasEstimateForUnprovenUnshieldBaseToken,
  generateUnshieldBaseTokenProof,
  populateProvedUnshieldBaseToken,
  gasEstimateForUnprovenUnshield,
  generateUnshieldProof,
  populateProvedUnshield,
} from "@railgun-community/wallet";
import * as RailgunSDK from "@railgun-community/wallet";
import {
  NetworkName,
  NETWORK_CONFIG,
  TXIDVersion,
  EVMGasType,
} from "@railgun-community/shared-models";
import LevelDB from "level-js";
import localforage from "localforage";
import * as snarkjs from "snarkjs";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import { JsonRpcProvider } from "ethers";
import { poolMnemonicFromPRF } from "./seed";
import { encodeFunctionData } from "viem";
import { RPC_URLS } from "@/app/constants";
import { activeNetwork, type NetworkId } from "@/lib/networks";

// Map the active network (registry) → Railgun's NetworkName. Railgun support is
// a property of the protocol, not the wallet: a chain can live in the registry
// without (yet) a Railgun deployment, so this is a partial map that throws
// loudly if the private side is entered on an unsupported chain.
const RAILGUN_NETWORK: Partial<Record<NetworkId, NetworkName>> = {
  sepolia: NetworkName.EthereumSepolia,
};

export const POOL_NETWORK = (() => {
  const id = activeNetwork().id;
  const name = RAILGUN_NETWORK[id];
  if (!name)
    throw new Error(`[pool] RAILGUN has no deployment for network "${id}"`);
  return name;
})();
const TXID = TXIDVersion.V2_PoseidonMerkle;
const {
  chain: CHAIN,
  baseToken,
  proxyContract: POOL_PROXY,
} = NETWORK_CONFIG[POOL_NETWORK];
const WETH = baseToken.wrappedAddress;
// Primary RPC (PublicNode) for the light ethers reads (block number, feeData);
// Railgun's heavy batched scans get the full failover list via loadProvider.
const RPC = RPC_URLS[0];
// Live POI aggregator (the docs' horsewithsixlegs node is dead).
const POI_NODES = ["https://ppoi.fdi.network"];

// syncRailgunTransactionsV2 is exported by the SDK but missing from its .d.ts
// (it syncs the txid merkletree from the subsquid — needed for POI of outputs).
const syncRailgunTransactionsV2: (n: NetworkName) => Promise<unknown> =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (RailgunSDK as any).syncRailgunTransactionsV2;

// Shared read-only provider (block number, feeData). ethers v6.
let _provider: JsonRpcProvider | null = null;
const provider = (): JsonRpcProvider =>
  (_provider ??= new JsonRpcProvider(RPC));

// EIP-1559 (Type2) gas details from a gasEstimate — mirrors the spike.
async function gasDetails(gasEstimate: bigint) {
  const fd = await provider().getFeeData();
  return {
    evmGasType: EVMGasType.Type2 as const,
    gasEstimate,
    maxFeePerGas: fd.maxFeePerGas ?? 2_000_000_000n,
    maxPriorityFeePerGas: fd.maxPriorityFeePerGas ?? 1_000_000_000n,
  };
}
const dummyGas = () => gasDetails(0n);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, rej) =>
      setTimeout(() => rej(new Error(`timeout ${label} (${ms}ms)`)), ms),
    ),
  ]);

let engineBooted = false;
let booting: Promise<void> | null = null;

// Artifact store over localforage (IndexedDB) — same as the validated spike.
function makeArtifactStore() {
  return new ArtifactStore(
    async (path: string) => localforage.getItem(path),
    async (_dir: string, path: string, item: string | Uint8Array) => {
      await localforage.setItem(path, item);
    },
    async (path: string) => (await localforage.getItem(path)) != null,
  );
}

// PPOI health-check (RULE: verify a node is alive before ANYTHING).
// HARD GATE: without a live POI node Railgun is dead — balances can't validate,
// POIs can't be generated, spends fail. So if none responds, bootEngine throws
// → the UI must NOT go green nor allow unlock/register/operate.
async function poiHealthy(): Promise<string | null> {
  for (const url of POI_NODES) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          method: "ppoi_health",
          params: {},
          id: 1,
        }),
      });
      const j = await r.json();
      if (j.result === "OK") return url;
    } catch {
      /* try next node */
    }
  }
  return null;
}

/** Boot the Railgun engine once per session (idempotent). */
export async function bootEngine(): Promise<void> {
  if (engineBooted) {
    console.log("[pool] engine already up — reusing (warm)");
    return;
  }
  if (booting) {
    console.log("[pool] engine boot already in progress — awaiting…");
    return booting;
  }

  booting = (async () => {
    const t0 = performance.now();
    console.log("[pool] booting Railgun engine…");

    console.log("[pool] PPOI health-check…");
    const live = await poiHealthy();
    if (!live) {
      // HARD GATE: no live POI node → Railgun is unusable. Abort the boot so
      // the UI stays red and blocks unlock/register/operate.
      console.error(
        "[pool] ✗ no PPOI node responded — Railgun unavailable (aborting boot)",
      );
      throw new Error("POI network unreachable");
    }
    console.log(`[pool] ✓ PPOI live: ${live}`);

    console.log("[pool] starting engine (level-js → IndexedDB)…");
    await startRailgunEngine(
      "r1do",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      new (LevelDB as any)("r1do-railgun"),
      false, // shouldDebug
      makeArtifactStore(),
      false, // useNativeArtifacts
      false, // skipMerkletreeScans — must be false so balances scan
      POI_NODES,
      [], // customPOILists
      false, // verboseScanLogs
    );
    console.log("[pool] ✓ engine started");

    // The SDK ships NO Groth16 prover — inject snarkjs (browser).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    getProver().setSnarkJSGroth16(snarkjs.groth16 as any);
    console.log("[pool] ✓ Groth16 prover (snarkjs) injected");

    console.log(
      `[pool] loading Sepolia provider (chainId ${CHAIN.id}) — ${RPC_URLS.length} RPCs w/ failover…`,
    );
    const { feesSerialized } = await loadProvider(
      {
        chainId: CHAIN.id,
        // Index 0 (priority 1, heavier weight);
        // the public RPCs follow as failover, in order.
        providers: RPC_URLS.map((url, i) => ({
          provider: url,
          priority: i + 1,
          weight: i === 0 ? 2 : 1,
        })),
      },
      POOL_NETWORK,
      10_000,
    );
    // Railgun fees are read live from the contract (basis points; 25 = 0.25%).
    // Used to show the user the fee and the net they'll receive on shield/unshield.
    const shieldBps = Number(feesSerialized.shieldFeeV2);
    const unshieldBps = Number(feesSerialized.unshieldFeeV2);
    if (Number.isFinite(shieldBps)) poolFees.shieldBps = shieldBps;
    if (Number.isFinite(unshieldBps)) poolFees.unshieldBps = unshieldBps;
    console.log(
      `[pool] ✓ provider loaded — fees: shield ${poolFees.shieldBps}bps, unshield ${poolFees.unshieldBps}bps`,
    );

    engineBooted = true;
    console.log(
      `[pool] ✓ Railgun engine up (${Math.round(performance.now() - t0)}ms)`,
    );
  })();

  try {
    await booting;
  } finally {
    booting = null;
  }
}

export function isEngineBooted(): boolean {
  return engineBooted;
}

// Railgun protocol fees in basis points (25 = 0.25%), read live from the
// contract in bootEngine. Defaults to the known V2 values until loaded.
const poolFees = { shieldBps: 25, unshieldBps: 25 };
export function getPoolFees(): { shieldBps: number; unshieldBps: number } {
  return { ...poolFees };
}

/* ── 0zk wallet (STEP 1b) ─────────────────────────────────────────────────
   The Railgun identity derives from the SAME PRF as the rest of R1DO, via
   HKDF-SHA256 branches (same style as deriveOwnerKey / derivePQKeysFromPRF):
     · seed branch → BIP39 mnemonic (the 0zk spending/viewing keys)
     · enc  branch → encryptionKey (at-rest encryption of the engine's wallet)
   One 0zk per user; the engine must be booted first. */

type PoolWallet = { id: string; railgunAddress: string; username: string };
let poolWallet: PoolWallet | null = null;
// Per-wallet shield key (deterministic, derived from a PRF branch at unlock).
// Used to encrypt shield notes; kept in session memory so shielding needs no
// extra passkey tap. Cleared on reset.
let shieldPrivateKey: string | null = null;
// The 0zk wallet's encryptionKey — needed by transfer/unshield proving. Kept in
// session (like shieldPrivateKey) so operations need no extra passkey tap.
let walletEncryptionKey: string | null = null;
// Owner key for the ephemeral relay Safe (privacy mode): the proven transact is
// relayed from a FRESH throwaway Safe (this owner + a random saltNonce per tx)
// instead of the main Safe → no link between your identity and Railgun activity.
let relayOwnerKey: `0x${string}` | null = null;

function bytesToHex(b: Uint8Array): string {
  return Array.from(b)
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}

/** Derive + create the user's 0zk wallet from their PRF. Scoped to `username`:
    on an account switch the previous account's wallet/state is reset first so
    nothing leaks across accounts. Idempotent for the same account. */
export async function createPoolWallet(
  prf: Uint8Array,
  username: string,
): Promise<PoolWallet> {
  if (poolWallet && poolWallet.username === username) {
    console.log("[pool] 0zk wallet already derived — reusing");
    return poolWallet;
  }
  if (poolWallet && poolWallet.username !== username) {
    console.log(
      "[pool] account switch detected — resetting previous 0zk state",
    );
    await resetPool();
  }
  if (!engineBooted) throw new Error("engine not booted");

  console.log("[pool] deriving 0zk from PRF branches (HKDF-SHA256)…");
  const encKey = hkdf(sha256, prf, undefined, "r1do/pool/railgun/enc/v1", 32);
  const shieldKey = hkdf(
    sha256,
    prf,
    undefined,
    "r1do/pool/railgun/shield/v1",
    32,
  );
  const relayKey = hkdf(
    sha256,
    prf,
    undefined,
    "r1do/pool/railgun/relay/v1",
    32,
  );
  // Same derivation the "Show seed" backup uses (single source of truth in seed.ts).
  const mnemonic = poolMnemonicFromPRF(prf);
  const encryptionKey = bytesToHex(encKey);
  shieldPrivateKey = "0x" + bytesToHex(shieldKey);
  walletEncryptionKey = encryptionKey;
  relayOwnerKey = ("0x" + bytesToHex(relayKey)) as `0x${string}`;
  encKey.fill(0);
  shieldKey.fill(0);
  relayKey.fill(0);

  // Creation block for the scan map. PoC: a recent block (this 0zk has no
  // funds yet). TODO before real use: a proper creation-block strategy
  // (store first-shield block, or scan from the Railgun deploy block).
  console.log("[pool] reading current block…");
  const block = await provider().getBlockNumber();
  const creationBlock = Math.max(block - 100, 0);

  console.log("[pool] creating 0zk wallet…");
  const info = await createRailgunWallet(encryptionKey, mnemonic, {
    [POOL_NETWORK]: creationBlock,
  });
  poolWallet = { id: info.id, railgunAddress: info.railgunAddress, username };
  wireCallbacks();
  console.log(`[pool] ✓ 0zk wallet ready: ${info.railgunAddress}`);
  return poolWallet;
}

/** Only returns the wallet if it belongs to `username` (no cross-account resume). */
export function getPoolWallet(username: string): PoolWallet | null {
  return poolWallet && poolWallet.username === username ? poolWallet : null;
}

/** Owner key for the ephemeral relay Safe (privacy-mode transfer/unshield). */
export function getRelayKey(): `0x${string}` | null {
  return relayOwnerKey;
}

/* ── shield (STEP 2 — public deposit) ─────────────────────────────────────
   Build the on-chain shield tx (ETH → pool, to this user's 0zk). It carries
   NO ZK proof, so it's a plain {to,data,value}; the caller submits it via the
   Safe (UserOp/Pimlico). `value` is the ETH being deposited (from the Safe's
   balance); Pimlico only sponsors gas. The watcher then shows it move from
   ShieldPending → Spendable. */
export async function populateShieldTx(
  amount: bigint,
): Promise<{ to: string; data: string; value: string }> {
  if (!poolWallet) throw new Error("no 0zk wallet — unlock first");
  if (!shieldPrivateKey) throw new Error("shield key not derived");
  const { transaction } = await populateShieldBaseToken(
    TXID,
    POOL_NETWORK,
    poolWallet.railgunAddress,
    shieldPrivateKey,
    { tokenAddress: WETH, amount },
    undefined,
  );
  return {
    to: transaction.to as string,
    data: transaction.data as string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    value: BigInt((transaction as any).value ?? 0n).toString(),
  };
}

// Minimal ERC20 approve — the only extra write an ERC20 shield needs (the proxy
// pulls the tokens with transferFrom).
const ERC20_APPROVE_ABI = [
  {
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "approve",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

export type ShieldCall = { to: string; data: string; value: string };

/* ── shield (asset-agnostic) ──────────────────────────────────────────────
   Build the on-chain shield as a list of calls the caller submits in ONE Safe
   UserOp (the caller never touches the SDK; it just batches what it's given):
     · native (tokenAddress null) → the existing base-token shield, a single
       call (the ETH `value` rides its own field, no approve needed).
     · ERC20 → TWO calls: approve(proxy, amount) so Railgun's proxy can
       transferFrom, then the shield itself (value 0). Batched, so there's no
       standing allowance and no extra passkey tap.
   Recipient is always this user's own 0zk. */
export async function populateShieldCalls(
  tokenAddress: string | null,
  amount: bigint,
): Promise<ShieldCall[]> {
  if (!poolWallet) throw new Error("no 0zk wallet — unlock first");
  if (!shieldPrivateKey) throw new Error("shield key not derived");

  if (!tokenAddress) {
    // Native base-token path — reuse the single-call builder above.
    return [await populateShieldTx(amount)];
  }

  const { transaction } = await populateShield(
    TXID,
    POOL_NETWORK,
    shieldPrivateKey,
    [{ tokenAddress, amount, recipientAddress: poolWallet.railgunAddress }],
    [], // no NFTs
    undefined,
  );

  // The proxy is what runs transferFrom on a direct shield — approve it for
  // exactly `amount`. Warn (don't fail) if the SDK ever targets something else,
  // so a future relay-adapt routing surfaces instead of silently under-approving.
  if (
    transaction.to &&
    (transaction.to as string).toLowerCase() !== POOL_PROXY.toLowerCase()
  ) {
    console.warn(
      `[pool] shield target ${transaction.to} ≠ proxy ${POOL_PROXY} — approving proxy anyway`,
    );
  }
  const approveData = encodeFunctionData({
    abi: ERC20_APPROVE_ABI,
    functionName: "approve",
    args: [POOL_PROXY as `0x${string}`, amount],
  });

  return [
    { to: tokenAddress, data: approveData, value: "0" },
    {
      to: transaction.to as string,
      data: transaction.data as string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      value: BigInt((transaction as any).value ?? 0n).toString(),
    },
  ];
}

/* ── transfer (STEP 3 — private 0zk → 0zk) ────────────────────────────────
   Has a ZK proof: gasEstimate → generateTransferProof (Groth16 ~9s, with a
   progress callback) → populateProvedTransfer → {to,data,value}. The proven tx
   can be submitted by ANY account (the proof doesn't bind msg.sender), so the
   caller relays it via a Safe (self-relay, sendWithPublicWallet=true). The
   change/output then need a spent-POI the WATCHER generates — see the activity
   state below. `value` is 0 (pool-internal); gas is sponsored by Pimlico. */
export async function populateTransferTx(
  toZkAddress: string,
  amount: bigint,
  onProgress?: (pct: number) => void,
  tokenAddress: string = WETH, // default native (WETH); pass an ERC20 to move that token
): Promise<{ to: string; data: string; value: string }> {
  if (!poolWallet) throw new Error("no 0zk wallet — unlock first");
  if (!walletEncryptionKey) throw new Error("encryption key not derived");
  // 0zk→0zk transfer is the generic ERC20 path (NOT base-token), pool-internal,
  // so no approve and no unwrap — just parameterize which token moves.
  const recipients = [{ tokenAddress, amount, recipientAddress: toZkAddress }];

  console.log("[pool] transfer gas estimate…");
  const { gasEstimate } = await gasEstimateForUnprovenTransfer(
    TXID,
    POOL_NETWORK,
    poolWallet.id,
    walletEncryptionKey,
    undefined, // memoText
    recipients,
    [], // nft
    await dummyGas(),
    undefined, // feeTokenDetails
    true, // sendWithPublicWallet (self-relay)
  );

  console.log(
    "[pool] generating transfer proof (Groth16; 1st time downloads ~50MB artifacts)…",
  );
  await generateTransferProof(
    TXID,
    POOL_NETWORK,
    poolWallet.id,
    walletEncryptionKey,
    false, // showSenderAddressToRecipient
    undefined, // memoText
    recipients,
    [], // nft
    undefined, // broadcasterFeeERC20AmountRecipient
    true, // sendWithPublicWallet
    undefined, // overallBatchMinGasPrice
    (p: number) => onProgress?.(Math.round(p)),
  );
  console.log("[pool] ✓ transfer proof generated");

  const { transaction } = await populateProvedTransfer(
    TXID,
    POOL_NETWORK,
    poolWallet.id,
    false,
    undefined,
    recipients,
    [],
    undefined,
    true,
    undefined,
    await gasDetails(gasEstimate),
  );
  return {
    to: transaction.to as string,
    data: transaction.data as string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    value: BigInt((transaction as any).value ?? 0n).toString(),
  };
}

/* ── unshield (STEP 4 — private 0zk → public address) ─────────────────────
   Mirror of populateTransferTx but base-token: the shielded WETH is unwrapped
   and sent as ETH to `toAddress` (a public 0x). Same proving flow (gasEstimate
   → generateUnshieldBaseTokenProof → populateProvedUnshieldBaseToken). The
   proven tx is submittable by ANY account, so the caller relays it (main Safe
   in public mode, ephemeral Safe in privacy mode). Spike insight: the ETH lands
   at `toAddress` on confirmation — the unshield-event's spent-POI is background
   cleanup the watcher handles, nothing to wait on here. `value` is 0 (the pool
   moves the funds; the relayer just pays gas, sponsored by Pimlico). */
export async function populateUnshieldTx(
  toAddress: string,
  amount: bigint,
  onProgress?: (pct: number) => void,
  tokenAddress?: string, // undefined/WETH = native (base-token, unwrap→ETH); an ERC20 = generic unshield
): Promise<{ to: string; data: string; value: string }> {
  if (!poolWallet) throw new Error("no 0zk wallet — unlock first");
  if (!walletEncryptionKey) throw new Error("encryption key not derived");

  // ERC20 unshield: the generic (NON base-token) path. The proxy already holds
  // the tokens (NO approve) and sends `tokenAddress` straight to the public 0x —
  // no unwrap. The 0.25% fee goes to Railgun's treasury as a separate transfer.
  if (tokenAddress && tokenAddress.toLowerCase() !== WETH.toLowerCase()) {
    const erc20AmountRecipients = [
      { tokenAddress, amount, recipientAddress: toAddress },
    ];
    console.log("[pool] unshield (ERC20) gas estimate…");
    const { gasEstimate } = await gasEstimateForUnprovenUnshield(
      TXID,
      POOL_NETWORK,
      poolWallet.id,
      walletEncryptionKey,
      erc20AmountRecipients,
      [], // nft
      await dummyGas(),
      undefined, // feeTokenDetails
      true, // sendWithPublicWallet (self-relay)
    );
    console.log(
      "[pool] generating unshield proof (ERC20; 1st time downloads ~50MB artifacts)…",
    );
    await generateUnshieldProof(
      TXID,
      POOL_NETWORK,
      poolWallet.id,
      walletEncryptionKey,
      erc20AmountRecipients,
      [], // nft
      undefined, // broadcasterFeeERC20AmountRecipient
      true, // sendWithPublicWallet
      undefined, // overallBatchMinGasPrice
      (p: number) => onProgress?.(Math.round(p)),
    );
    console.log("[pool] ✓ unshield proof generated (ERC20)");
    const { transaction } = await populateProvedUnshield(
      TXID,
      POOL_NETWORK,
      poolWallet.id,
      erc20AmountRecipients,
      [], // nft
      undefined, // broadcasterFeeERC20AmountRecipient
      true, // sendWithPublicWallet
      undefined, // overallBatchMinGasPrice
      await gasDetails(gasEstimate),
    );
    return {
      to: transaction.to as string,
      data: transaction.data as string,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      value: BigInt((transaction as any).value ?? 0n).toString(),
    };
  }

  // Native base-token path (unwrap WETH→ETH) — unchanged.
  const wrappedERC20Amount = { tokenAddress: WETH, amount };

  console.log("[pool] unshield gas estimate…");
  const { gasEstimate } = await gasEstimateForUnprovenUnshieldBaseToken(
    TXID,
    POOL_NETWORK,
    toAddress,
    poolWallet.id,
    walletEncryptionKey,
    wrappedERC20Amount,
    await dummyGas(),
    undefined, // feeTokenDetails
    true, // sendWithPublicWallet (self-relay)
  );

  console.log(
    "[pool] generating unshield proof (Groth16; 1st time downloads ~50MB artifacts)…",
  );
  await generateUnshieldBaseTokenProof(
    TXID,
    POOL_NETWORK,
    toAddress,
    poolWallet.id,
    walletEncryptionKey,
    wrappedERC20Amount,
    undefined, // broadcasterFeeERC20AmountRecipient
    true, // sendWithPublicWallet
    undefined, // overallBatchMinGasPrice
    (p: number) => onProgress?.(Math.round(p)),
  );
  console.log("[pool] ✓ unshield proof generated");

  const { transaction } = await populateProvedUnshieldBaseToken(
    TXID,
    POOL_NETWORK,
    toAddress,
    poolWallet.id,
    wrappedERC20Amount,
    undefined, // broadcasterFeeERC20AmountRecipient
    true, // sendWithPublicWallet
    undefined, // overallBatchMinGasPrice
    await gasDetails(gasEstimate),
  );
  return {
    to: transaction.to as string,
    data: transaction.data as string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    value: BigInt((transaction as any).value ?? 0n).toString(),
  };
}

/* ── balances + watcher (STEP 1c) ─────────────────────────────────────────
   Mirrors the validated spike: a single background watcher keeps POI and
   balance fresh. Each tick (under a mutex so a tick never collides with
   another engine op):
     syncTxid → refreshReceivePOIs → generate spent POIs if any → scanBalances
   Balance updates flow through setOnBalanceUpdateCallback → onPoolBalances. */

export type PoolBalances = {
  spendable: bigint;
  missingExternal: bigint; // received from another, pending POI
  missingInternal: bigint; // own change, pending POI
  shieldPending: bigint; // shielded, awaiting list-provider validation
};

const balances: PoolBalances = {
  spendable: 0n,
  missingExternal: 0n,
  missingInternal: 0n,
  shieldPending: 0n,
};

let onBalances: ((b: PoolBalances) => void) | null = null;

/** Subscribe the UI to balance updates (fires immediately with the current). */
export function onPoolBalances(cb: (b: PoolBalances) => void): void {
  onBalances = cb;
  cb({ ...balances });
}

// Per-token shielded balances — the full picture (the native `balances` above is
// just the WETH slice of this, kept for the WETH-centric send/unshield flows).
// Keyed by lowercased token address. The balance callback fires once PER BUCKET
// carrying that bucket's full token list, so each event resets that one bucket
// across all known tokens, then applies the list.
export type TokenBuckets = {
  spendable: bigint;
  missingExternal: bigint;
  missingInternal: bigint;
  shieldPending: bigint;
};
const tokenBalances = new Map<string, TokenBuckets>();
let onTokenBalances: ((m: Map<string, TokenBuckets>) => void) | null = null;

/** Snapshot of every shielded token's balances (by lowercased token address). */
export function getPoolTokenBalances(): Map<string, TokenBuckets> {
  return new Map(tokenBalances);
}

/** Subscribe to per-token balance updates (fires immediately with the current). */
export function onPoolTokenBalances(
  cb: (m: Map<string, TokenBuckets>) => void,
): void {
  onTokenBalances = cb;
  cb(new Map(tokenBalances));
}

/* POI activity — so the UI can clearly tell the user "there's a pending POI
   being finalized" (transfer's change/output need a spent-POI WE generate). */
export type PoolActivity = {
  finalizing: boolean; // a spent-POI is pending → the watcher must generate it
  generatingProof: boolean; // actively proving right now
  proofProgress: number; // 0..100
};
const activity: PoolActivity = {
  finalizing: false,
  generatingProof: false,
  proofProgress: 0,
};
let onActivity: ((a: PoolActivity) => void) | null = null;
export function onPoolActivity(cb: (a: PoolActivity) => void): void {
  onActivity = cb;
  cb({ ...activity });
}
const notifyActivity = () => onActivity?.({ ...activity });

let callbacksWired = false;
function wireCallbacks() {
  if (callbacksWired) return;
  callbacksWired = true;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setOnBalanceUpdateCallback((e: any) => {
    if (!poolWallet || e.railgunWalletID !== poolWallet.id) return;
    // Which TokenBuckets field this bucket maps to (ignore ShieldBlocked /
    // ProofSubmitted / Spent — not part of the spendable/pending picture).
    const field: keyof TokenBuckets | undefined = (
      {
        Spendable: "spendable",
        MissingExternalPOI: "missingExternal",
        MissingInternalPOI: "missingInternal",
        ShieldPending: "shieldPending",
      } as Record<string, keyof TokenBuckets>
    )[e.balanceBucket];
    if (!field) return;

    // The event carries the FULL token list for this one bucket → zero the field
    // across known tokens first, then apply, so a token that left this bucket
    // drops to 0 (not stale).
    for (const v of tokenBalances.values()) v[field] = 0n;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    for (const a of e.erc20Amounts as any[]) {
      const k = (a.tokenAddress as string).toLowerCase();
      const cur = tokenBalances.get(k) ?? {
        spendable: 0n,
        missingExternal: 0n,
        missingInternal: 0n,
        shieldPending: 0n,
      };
      cur[field] = BigInt(a.amount);
      tokenBalances.set(k, cur);
    }

    // Keep the WETH-centric `balances` in sync for the existing native flows.
    const weth = tokenBalances.get(WETH.toLowerCase());
    balances.spendable = weth?.spendable ?? 0n;
    balances.missingExternal = weth?.missingExternal ?? 0n;
    balances.missingInternal = weth?.missingInternal ?? 0n;
    balances.shieldPending = weth?.shieldPending ?? 0n;

    const summary =
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (e.erc20Amounts as any[])
        .map((a) => `${a.tokenAddress}=${a.amount}`)
        .join(", ") || "(none)";
    console.log(`[pool] balance: ${e.balanceBucket} — ${summary}`);
    onBalances?.({ ...balances });
    onTokenBalances?.(new Map(tokenBalances));
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  setOnWalletPOIProofProgressCallback((e: any) => {
    if (!poolWallet || e.railgunWalletID !== poolWallet.id) return;
    const pct = Math.round(e.progress ?? 0);
    const done = e.status === "AllProofsCompleted" || (e.totalCount ?? 0) === 0;
    // The banner shows ONLY while a proof is actively generating: InProgress,
    // totalCount > 0 AND progress > 0. A false-positive txid only ever emits
    // AllProofsCompleted / totalCount 0 / 0% → this never flips true → the banner
    // never sticks. finalizing tracks this 1:1 (no pending-list guesswork).
    activity.generatingProof = !done && (e.totalCount ?? 0) > 0 && pct > 0;
    activity.finalizing = activity.generatingProof;
    activity.proofProgress = pct;
    console.log(
      `[watcher] POI proof ${e.status} ${pct}% (${e.index + 1}/${e.totalCount})`,
    );
    notifyActivity();
  });
}

// The engine auto-refreshes POIs during its own block scan (decryptBalances →
// refreshPOIsForTXIDVersion) in a detached promise. On testnet a spent/unshield
// POI whose data the aggregator can't serve rejects there as an "Uncaught (in
// promise)" — harmless (funds stay spendable) but noisy. Swallow that specific
// POI-refresh rejection silently so it doesn't spam the console.
if (typeof window !== "undefined") {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  window.addEventListener("unhandledrejection", (ev: any) => {
    const msg = ev?.reason?.message ?? String(ev?.reason ?? "");
    if (/refresh POIs|generate POIs|SentCommitments|unshield POI/i.test(msg)) {
      ev.preventDefault(); // it's a known testnet POI-refresh failure → ignore
    }
  });
}

// Mutex: serialize everything that touches the merkletree (watcher ticks +,
// later, operations) so a tick never collides → no "Failed to get merkletree".
let engineLock: Promise<unknown> = Promise.resolve();
function withEngineLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = engineLock.then(fn, fn) as Promise<T>;
  engineLock = run.then(
    () => {},
    () => {},
  );
  return run;
}

async function scanBalances(): Promise<void> {
  if (!poolWallet) return;
  await refreshBalances(CHAIN, [poolWallet.id]); // fires the balance callback
}

// generatePOIsForWallet pushes spent-POIs forward, but on testnet a POI whose
// data the aggregator can't serve just keeps failing. Only run it when the
// pending set actually CHANGES (a genuinely new spend) so we don't re-run a
// permanently-stuck set every tick. Funds stay spendable regardless; the engine
// also auto-refreshes POIs during its own scan.
let lastGeneratedPOIKey = "";
let lastSeenPOIKey = " "; // sentinel ≠ "" so the first tick always logs the state

async function watcherTick(): Promise<void> {
  if (!poolWallet) return;
  await withTimeout(
    syncRailgunTransactionsV2(POOL_NETWORK),
    60_000,
    "syncTxid",
  ).catch(() => {});
  await refreshReceivePOIsForWallet(TXID, POOL_NETWORK, poolWallet.id).catch(
    () => {},
  );
  const pending = await getChainTxidsStillPendingSpentPOIs(
    TXID,
    POOL_NETWORK,
    poolWallet.id,
  ).catch(() => [] as string[]);
  const key = [...pending].sort().join(",");
  // Visibility — the forest, not the per-txid error trees. Logged ONLY when the
  // pending set changes (no spam). Receive/shield-side pending shows in the
  // "[pool] balance: MissingExternal/Internal/ShieldPending" lines.
  if (key !== lastSeenPOIKey) {
    lastSeenPOIKey = key;
    if (pending.length === 0)
      console.log("[watcher] spent-POIs pending: 0 — all clear ✓");
    else
      console.log(
        `[watcher] spent-POIs pending: ${pending.length} [${pending.map((t) => t.slice(0, 10) + "…").join(", ")}] (each retried independently; a stuck one never blocks the rest)`,
      );
  }
  if (key && key !== lastGeneratedPOIKey) {
    // New pending set → try once (a stuck set is not retried every tick).
    lastGeneratedPOIKey = key;
    await withTimeout(
      generatePOIsForWallet(POOL_NETWORK, poolWallet.id),
      180_000,
      "generatePOIs",
    ).catch(() => {});
  } else if (!key) {
    lastGeneratedPOIKey = "";
  }
  await scanBalances();
}

let watcherActive = false;
const WATCH_INTERVAL = 20_000;

/** Start the background POI+balance watcher (tied to the private view). */
export function startWatcher(): void {
  if (watcherActive) return;
  if (!poolWallet) {
    console.warn("[watcher] no 0zk wallet yet — not starting");
    return;
  }
  watcherActive = true;
  console.log("[watcher] POI+balance watcher active (every 20s)");
  // Paint balances IMMEDIATELY (warm engine reads its cached scan state) so a
  // funded user never sees a 0 while the first tick's syncTxid/POI work runs.
  // Enqueued on the engine lock first → resolves before the first watcherTick.
  withEngineLock(scanBalances).catch((e) => console.warn("[watcher] initial balance paint:", e));
  (async () => {
    while (watcherActive && poolWallet) {
      try {
        await withEngineLock(watcherTick);
      } catch (e) {
        console.warn("[watcher] tick error:", e);
      }
      await sleep(WATCH_INTERVAL);
    }
  })();
}

/** Stop the watcher — called when leaving the private view. */
export function stopWatcher(): void {
  if (!watcherActive) return;
  watcherActive = false;
  console.log("[watcher] stopped");
}

/** "Nuclear" re-sync for the ACTIVE 0zk only: wipe and rebuild this wallet's
    UTXO merkletree + re-decrypt all its notes from chain. Fixes a wallet whose
    local scan has gaps (e.g. an RPC that dropped historical eth_getLogs left
    commitments undecrypted → spent-POIs stuck). Keeps the 0zk record (and its
    original creationBlock → full history is re-covered), auth, and stealthUtxos
    untouched — only the re-derivable engine cache is rebuilt. Heavy: minutes. */
export async function resyncPool(): Promise<void> {
  if (!poolWallet) throw new Error("no 0zk wallet — unlock first");
  const id = poolWallet.id;
  const wasWatching = watcherActive;
  stopWatcher();
  console.log(
    `[pool] re-sync: full UTXO rescan for active 0zk ${id.slice(0, 8)}…`,
  );
  try {
    // Serialize against any in-flight tick so we never collide on the merkletree.
    await withEngineLock(() =>
      rescanFullUTXOMerkletreesAndWallets(CHAIN, [id]),
    );
    console.log("[pool] ✓ re-sync complete");
  } finally {
    if (wasWatching) startWatcher();
  }
}

/** Clear ALL account-scoped pool state. Call on logout / account switch so a
    new account never inherits the previous 0zk, balances or watcher. The
    engine itself stays up (it's account-agnostic and holds wallets by id). */
export async function resetPool(): Promise<void> {
  stopWatcher();
  const prev = poolWallet;
  poolWallet = null;
  shieldPrivateKey = null;
  walletEncryptionKey = null;
  relayOwnerKey = null;
  balances.spendable = 0n;
  balances.missingExternal = 0n;
  balances.missingInternal = 0n;
  balances.shieldPending = 0n;
  tokenBalances.clear();
  onBalances = null;
  onTokenBalances = null;
  activity.finalizing = false;
  activity.generatingProof = false;
  activity.proofProgress = 0;
  onActivity = null;
  if (prev) {
    // Best-effort: unload the wallet from the engine so its keys leave memory.
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (RailgunSDK as any).unloadWalletByID?.(prev.id);
    } catch {
      /* ignore */
    }
  }
  console.log("[pool] reset — account state cleared");
}
