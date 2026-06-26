import {
  DIRECTORY_ADDRESS,
  RPC_URL,
  BUNDLER_URL,
  PAYMASTER_URL,
  ENTRYPOINT_ADDRESS,
  SAFE_MODULES_ADDRESS,
  SAFE_MODULES_VERSION,
  SAFE_SW_VERSION,
  sepoliaTransport,
} from "@/app/constants";
import { Safe4337Pack } from "@safe-global/relay-kit";
import { encodeFunctionData, createPublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { activeChain, gasFloorEnabled } from "@/lib/networks";
import { getStealthBalances, getTokenBalances } from "@/lib/balances";
import { log } from "./common";
import { getSpendableUTXOs } from "./localstorage";
import { getWalletCredential } from "./credstore";
import { loadFromDevice } from "./passkeys";
import {
  derivePQKeysFromPRF,
  deriveStealthSpendingKey,
  deriveStealthH,
  generateStealthPayment,
  STEALTH_BLOB_LENGTH,
  type StealthUTXO,
} from "./stealth";
import { quoteFee } from "./fees";
import { getFeeRecipient } from "./feeRecipient";
import { nativeAsset, assetByAddress, type Asset } from "./assets";

// Bundler receipt polling: 30 attempts * 2s = 60s timeout
const RECEIPT_POLL_INTERVAL_MS = 2000;
const RECEIPT_POLL_MAX_ATTEMPTS = 30;

const waitForUserOpReceipt = async (
  wallet: Safe4337Pack,
  userOperationHash: string,
) => {
  for (let i = 0; i < RECEIPT_POLL_MAX_ATTEMPTS; i++) {
    await new Promise((resolve) =>
      setTimeout(resolve, RECEIPT_POLL_INTERVAL_MS),
    );
    const receipt = await wallet.getUserOperationReceipt(userOperationHash);
    if (receipt) return receipt;
  }
  throw new Error("Timed out waiting for user operation receipt");
};

/**
 * Send 0 to Zero Address.
 * @param {Safe4337Pack} wallet - Wallet built by Safe client.
 * @returns {Promise<void>}
 * @throws {Error} If the operation fails.
 */
export const makeTx = async (
  wallet: Safe4337Pack,
  destinationAddress: string,
  amount: string,
): Promise<string> => {
  // // TRACE -DEBUG
  // console.log("Making tx...");

  try {
    console.log(`[makeTx] to: ${destinationAddress} | value: ${amount}`);

    const safeOperation = await wallet.createTransaction({
      transactions: [{ to: destinationAddress, data: "0x", value: amount }],
    });

    const signedSafeOperation = await wallet.signSafeOperation(safeOperation);

    if (signedSafeOperation) {
      const userOperationHash = await wallet.executeTransaction({
        executable: signedSafeOperation,
      });
      console.log(`[makeTx] UserOp submitted: ${userOperationHash}`);

      const userOperationReceipt = await waitForUserOpReceipt(wallet, userOperationHash);

      if (!userOperationReceipt.success) {
        throw new Error("Transaction reverted on-chain");
      }

      const txHash = userOperationReceipt.receipt.transactionHash;
      console.log(`[makeTx] ✓ confirmed — tx: ${txHash}`);
      return txHash;
    }
  } catch (e: unknown) {
    await log("makeTx", e);
  }
  return "";
};

/**
 * Send an arbitrary pre-built transaction ({to, data, value}) as a sponsored
 * UserOp from the user's Safe. Used to submit Railgun's shield tx (the shield
 * carries no ZK proof, so it's a plain call) — Pimlico sponsors gas; the ETH
 * `value` being shielded comes from the Safe's balance. Returns the tx hash.
 */
export const sendTxViaSafe = async (
  wallet: Safe4337Pack,
  tx: { to: string; data: string; value: string },
): Promise<string> => {
  try {
    console.log(`[sendTxViaSafe] to: ${tx.to} | value: ${tx.value} | data: ${(tx.data.length - 2) / 2} bytes`);
    const safeOperation = await wallet.createTransaction({
      transactions: [{ to: tx.to, data: tx.data, value: tx.value }],
    });
    const signedOp = await wallet.signSafeOperation(safeOperation);
    if (signedOp) {
      const userOpHash = await wallet.executeTransaction({ executable: signedOp });
      console.log(`[sendTxViaSafe] UserOp submitted: ${userOpHash}`);
      const receipt = await waitForUserOpReceipt(wallet, userOpHash);
      if (!receipt.success) throw new Error("Transaction reverted on-chain");
      const txHash = receipt.receipt.transactionHash;
      console.log(`[sendTxViaSafe] ✓ confirmed — tx: ${txHash}`);
      return txHash;
    }
  } catch (e: unknown) {
    await log("sendTxViaSafe", e);
    throw e;
  }
  return "";
};

/**
 * Batch sibling of sendTxViaSafe — submits SEVERAL pre-built calls as ONE
 * sponsored UserOp (Safe executes them atomically, in order). Used for the ERC20
 * shield, which is [approve(proxy, amount), shield]: the approve must land in the
 * same op so the proxy can transferFrom. A single call works too (native shield).
 * Returns the tx hash.
 */
export const sendTxsViaSafe = async (
  wallet: Safe4337Pack,
  txs: { to: string; data: string; value: string }[],
): Promise<string> => {
  if (txs.length === 0) throw new Error("sendTxsViaSafe: no calls");
  try {
    console.log(`[sendTxsViaSafe] ${txs.length} call(s): ${txs.map((t) => t.to).join(", ")}`);
    const safeOperation = await wallet.createTransaction({
      transactions: txs.map((t) => ({ to: t.to, data: t.data, value: t.value })),
    });
    const signedOp = await wallet.signSafeOperation(safeOperation);
    if (signedOp) {
      const userOpHash = await wallet.executeTransaction({ executable: signedOp });
      console.log(`[sendTxsViaSafe] UserOp submitted: ${userOpHash}`);
      const receipt = await waitForUserOpReceipt(wallet, userOpHash);
      if (!receipt.success) throw new Error("Transaction reverted on-chain");
      const txHash = receipt.receipt.transactionHash;
      console.log(`[sendTxsViaSafe] ✓ confirmed — tx: ${txHash}`);
      return txHash;
    }
  } catch (e: unknown) {
    await log("sendTxsViaSafe", e);
    throw e;
  }
  return "";
};

// Minimal ERC20 transfer — the only write a public token send needs.
const ERC20_TRANSFER_ABI = [
  {
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    name: "transfer",
    outputs: [{ name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

/**
 * Public ERC20 send — the token sibling of makeTx. Tokens live in the main Safe
 * (stealth UTXOs hold only native, so there's no chunking/stealth path here —
 * that's the ERC20 stealth phase). One sponsored UserOp: `transfer(to, amount)`
 * to the token contract, value 0. Returns the tx hash ("" on failure).
 */
export const sendToken = async (
  wallet: Safe4337Pack,
  tokenAddress: `0x${string}`,
  to: `0x${string}`,
  amount: bigint,
): Promise<string> => {
  const data = encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: "transfer",
    args: [to, amount],
  });
  return sendTxViaSafe(wallet, { to: tokenAddress, data, value: "0" });
};

/**
 * Private ERC20 send — moves a token to a one-time stealth address AND carries
 * the delivery blob, in ONE sponsored UserOp with two calls:
 *   1. token.transfer(stealthAddress, amount) — funds land at the codeless Safe
 *      (an ERC20 balance is just a mapping entry; the Safe needn't be deployed).
 *   2. call(stealthAddress, value 0, data = blob) — the announce blob rides the
 *      tx calldata exactly like native sendStealth (minus the value). Detection
 *      is asset-agnostic: the scanner finds the UTXO from the blob regardless.
 * No announcer. Returns the tx hash ("" on failure).
 */
export const sendStealthToken = async (
  wallet: Safe4337Pack,
  stealthAddress: `0x${string}`,
  tokenAddress: `0x${string}`,
  amount: bigint,
  calldataBlob: `0x${string}`,
): Promise<string> => {
  try {
    const transferData = encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [stealthAddress, amount],
    });
    console.log(`[sendStealthToken] token ${tokenAddress} → stealth ${stealthAddress} | amount: ${amount} | blob: ${(calldataBlob.length - 2) / 2} bytes`);

    const safeOperation = await wallet.createTransaction({
      transactions: [
        { to: tokenAddress, data: transferData, value: "0" },
        { to: stealthAddress, data: calldataBlob, value: "0" },
      ],
    });
    const signedOp = await wallet.signSafeOperation(safeOperation);
    if (signedOp) {
      const userOpHash = await wallet.executeTransaction({ executable: signedOp });
      console.log(`[sendStealthToken] UserOp submitted: ${userOpHash}`);
      const receipt = await waitForUserOpReceipt(wallet, userOpHash);
      if (!receipt.success) throw new Error("Stealth token send reverted");
      const txHash = receipt.receipt.transactionHash;
      console.log(`[sendStealthToken] ✓ confirmed — tx: ${txHash}`);
      return txHash;
    }
  } catch (e: unknown) {
    await log("sendStealthToken", e);
    throw e;
  }
  return "";
};

/**
 * Private ERC20 send by meta-address — derives the one-time stealth payment and
 * delivers the token + blob in one UserOp (sendStealthToken). Token sibling of
 * the metaAddress branch of smartSend; funds come from the main Safe (token
 * stealth UTXOs aren't drained here — that's the spend phase).
 */
export const sendTokenPrivate = async (
  wallet: Safe4337Pack,
  tokenAddress: `0x${string}`,
  metaAddress: `0x${string}`,
  amount: bigint,
): Promise<string> => {
  const payment = await generateStealthPayment(metaAddress);
  return sendStealthToken(wallet, payment.stealthAddress, tokenAddress, amount, payment.calldataBlob);
};

/**
 * Relay a pre-built (already-proven) tx from a FRESH ephemeral Safe — a
 * throwaway "personal broadcaster" for privacy-mode transfer/unshield. The
 * owner key is a PRF branch; a random saltNonce gives a brand-new counterfactual
 * Safe per call (deployed on first/only use via Pimlico, no funds needed, value
 * 0). Result: no link between your identity and the Railgun transact.
 */
export const relayViaEphemeralSafe = async (
  relayOwnerKey: `0x${string}`,
  tx: { to: string; data: string; value: string },
): Promise<string> => {
  const owner = privateKeyToAccount(relayOwnerKey);
  const rand = crypto.getRandomValues(new Uint8Array(16));
  const saltNonce = BigInt("0x" + Array.from(rand).map((b) => b.toString(16).padStart(2, "0")).join("")).toString();

  const relayPack = await Safe4337Pack.init({
    provider: RPC_URL,
    signer: relayOwnerKey,
    bundlerUrl: BUNDLER_URL,
    safeModulesVersion: SAFE_MODULES_VERSION,
    customContracts: {
      entryPointAddress: ENTRYPOINT_ADDRESS,
      safe4337ModuleAddress: SAFE_MODULES_ADDRESS,
    },
    paymasterOptions: { isSponsored: true, paymasterUrl: PAYMASTER_URL },
    options: { owners: [owner.address], threshold: 1, safeVersion: SAFE_SW_VERSION, saltNonce },
  });
  const relayAddr = await relayPack.protocolKit.getAddress();
  console.log(`[relay] fresh ephemeral relay Safe ${relayAddr} (unlinkable)`);
  return sendTxViaSafe(relayPack, tx);
};

/**
 * v2: publish the user's encrypted directory entry (R1DODirectory.setEntry)
 * as a sponsored UserOp from their own Safe. The blob is sealed client-side
 * (Argon2id → XChaCha20-Poly1305) — the chain only sees fp → opaque bytes.
 * As the user's first UserOp this also deploys the counterfactual Safe.
 */
export const setDirectoryEntry = async (
  wallet: Safe4337Pack,
  fp: `0x${string}`,
  blob: `0x${string}`,
): Promise<string> => {
  try {
    const { DIRECTORY_ABI } = await import("./registry-v2");
    const storeTransaction = {
      to: DIRECTORY_ADDRESS,
      data: encodeFunctionData({
        abi: DIRECTORY_ABI,
        functionName: "setEntry",
        args: [fp, blob],
      }),
      value: "0",
    };

    const safeOperation = await wallet.createTransaction({
      transactions: [storeTransaction],
    });

    const signedSafeOperation = await wallet.signSafeOperation(safeOperation);

    if (signedSafeOperation) {
      const userOperationHash = await wallet.executeTransaction({
        executable: signedSafeOperation,
      });

      const receipt = await waitForUserOpReceipt(wallet, userOperationHash);

      if (!receipt.success) {
        throw new Error("Directory entry transaction reverted");
      }

      return userOperationHash;
    }
  } catch (e: unknown) {
    console.error(e);
    await log("setDirectoryEntry", e);
    throw new Error("Error publishing directory entry");
  }
  return "";
};

// Δ1: single tx — the value transfer to the (codeless) stealth Safe carries
// the delivery blob as calldata. No announcer contract, no extra call.
export const sendStealth = async (
  wallet: Safe4337Pack,
  stealthAddress: `0x${string}`,
  amount: string,
  calldataBlob: `0x${string}`,
): Promise<string> => {
  try {
    console.log(`[sendStealth] to: ${stealthAddress} | amount: ${amount} | blob: ${(calldataBlob.length - 2) / 2} bytes`);

    const sendTx = { to: stealthAddress, data: calldataBlob, value: amount };

    const safeOperation = await wallet.createTransaction({ transactions: [sendTx] });
    const signedOp = await wallet.signSafeOperation(safeOperation);

    if (signedOp) {
      const userOpHash = await wallet.executeTransaction({ executable: signedOp });
      console.log(`[sendStealth] UserOp submitted: ${userOpHash}`);

      const receipt = await waitForUserOpReceipt(wallet, userOpHash);
      if (!receipt.success) throw new Error("Stealth send reverted");

      const txHash = receipt.receipt.transactionHash;
      console.log(`[sendStealth] ✓ confirmed — tx: ${txHash}`);
      return txHash;
    }
  } catch (e: unknown) {
    await log("sendStealth", e);
    throw e;
  }
  return "";
};

// Spends a stealth UTXO: re-derives its owner key, instantiates the predicted
// Safe (deploying it on first spend if needed) and sends a sponsored UserOp.
// No native ETH required in the stealth address — the paymaster covers gas.
// If `calldataBlob` is set, the recipient is itself a stealth address and the
// transfer carries the delivery blob (Δ1 — no announcer).
export const spendStealthUTXO = async (
  utxo:               StealthUTXO,
  amount:             string,
  recipient:          `0x${string}`,
  spendingPrivateKey: `0x${string}`,
  viewingPrivateKey:  `0x${string}`,
  mlkemDecapsKey:     Uint8Array,
  calldataBlob?:      `0x${string}`,
  // Extra calls appended to the SAME UserOp executed by this UTXO's Safe — used
  // to batch the operator fee (a stealth payment to r1do-wallet) onto a draw-path
  // chunk so the fee rides one UserOp with no extra op.
  extraCalls?:        { to: string; data: string; value: string }[],
): Promise<string> => {
  console.log(`[spendStealthUTXO] utxo: ${utxo.stealthAddress} → ${recipient} | amount: ${amount}`);

  const h = await deriveStealthH(viewingPrivateKey, mlkemDecapsKey, utxo.ephemeralPubkey, utxo.kemCiphertext);
  const saltNonce = BigInt(h).toString();

  const stealthPrivKey = await deriveStealthSpendingKey(
    spendingPrivateKey,
    viewingPrivateKey,
    mlkemDecapsKey,
    utxo.ephemeralPubkey,
    utxo.kemCiphertext,
  );
  const stealthOwner = privateKeyToAccount(stealthPrivKey);

  const stealthPack = await Safe4337Pack.init({
    provider: RPC_URL,
    signer: stealthPrivKey,
    bundlerUrl: BUNDLER_URL,
    safeModulesVersion: SAFE_MODULES_VERSION,
    customContracts: {
      entryPointAddress: ENTRYPOINT_ADDRESS,
      safe4337ModuleAddress: SAFE_MODULES_ADDRESS,
    },
    paymasterOptions: { isSponsored: true, paymasterUrl: PAYMASTER_URL },
    options: {
      owners: [stealthOwner.address],
      threshold: 1,
      safeVersion: SAFE_SW_VERSION,
      saltNonce,
    },
  });

  const predictedAddress = await stealthPack.protocolKit.getAddress();
  if (predictedAddress.toLowerCase() !== utxo.stealthAddress.toLowerCase()) {
    throw new Error(`Predicted Safe address mismatch: ${predictedAddress} ≠ ${utxo.stealthAddress}`);
  }

  // Token UTXO — the stealth Safe EXECUTES token.transfer (no native value moves;
  // the token address is the one tagged on the UTXO at discovery). Public spend =
  // one call; private chained spend = transfer + blob call to the next stealth
  // address, the same two-call shape as sendStealthToken (detection stays
  // asset-agnostic, and the destination UTXO gets tagged by the receiver's probe).
  if (utxo.asset) {
    const transferData = encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: [recipient, BigInt(amount)],
    });
    const transactions = [
      { to: utxo.asset, data: transferData, value: "0" },
      ...(calldataBlob ? [{ to: recipient, data: calldataBlob, value: "0" }] : []),
      ...(extraCalls ?? []),
    ];
    try {
      console.log(`[spendStealthUTXO] token ${utxo.asset} spend → ${recipient}${calldataBlob ? " (chained private)" : ""}`);
      const safeOperation = await stealthPack.createTransaction({ transactions });
      const signedOp = await stealthPack.signSafeOperation(safeOperation);
      if (signedOp) {
        const userOpHash = await stealthPack.executeTransaction({ executable: signedOp });
        console.log(`[spendStealthUTXO] token UserOp submitted: ${userOpHash}`);
        const receipt = await waitForUserOpReceipt(stealthPack, userOpHash);
        if (!receipt.success) throw new Error("Stealth token spend reverted");
        const txHash = receipt.receipt.transactionHash;
        console.log(`[spendStealthUTXO] ✓ token spend confirmed — tx: ${txHash}`);
        return txHash;
      }
    } catch (e: unknown) {
      await log("spendStealthUTXO", e);
      throw e;
    }
    return "";
  }

  // Plain spend with nothing to batch → the single-call fast path.
  if (!calldataBlob && !extraCalls?.length) {
    return await makeTx(stealthPack, recipient, amount);
  }

  // Chained private spend (blob rides the transfer, Δ1) and/or extra calls (e.g.
  // the batched operator fee) → one UserOp from this UTXO's Safe.
  try {
    const transactions = [
      { to: recipient, data: calldataBlob ?? "0x", value: amount },
      ...(extraCalls ?? []),
    ];

    const safeOperation = await stealthPack.createTransaction({ transactions });
    const signedOp = await stealthPack.signSafeOperation(safeOperation);

    if (signedOp) {
      const userOpHash = await stealthPack.executeTransaction({ executable: signedOp });
      console.log(`[spendStealthUTXO] UserOp submitted: ${userOpHash}`);

      const receipt = await waitForUserOpReceipt(stealthPack, userOpHash);
      if (!receipt.success) throw new Error("Stealth UTXO spend reverted");

      const txHash = receipt.receipt.transactionHash;
      console.log(`[spendStealthUTXO] ✓ confirmed — tx: ${txHash}`);
      return txHash;
    }
  } catch (e: unknown) {
    await log("spendStealthUTXO", e);
    throw e;
  }
  return "";
};

// The user's stealth UTXOs with their on-chain balances — the selectable
// "coins" for coin-control (B advanced). Sorted largest first, dust filtered.
export const getStealthCoins = async (
  username: string,
): Promise<{ utxo: StealthUTXO; balance: bigint }[]> => {
  const utxos = getSpendableUTXOs(username);
  if (utxos.length === 0) return [];
  const publicClient = createPublicClient({ chain: activeChain(), transport: sepoliaTransport() });

  // Per-asset balances: a stealth UTXO holds exactly one asset (tagged on the
  // note). Read native ones via getEthBalance and each token's UTXOs via that
  // token's balanceOf — otherwise token coins read ~0 native and get dropped.
  const balances = new Array<bigint>(utxos.length).fill(0n);
  const nativeIdx: number[] = [];
  const byToken = new Map<`0x${string}`, number[]>();
  utxos.forEach((u, i) => {
    if (u.asset) byToken.set(u.asset, [...(byToken.get(u.asset) ?? []), i]);
    else nativeIdx.push(i);
  });

  if (nativeIdx.length > 0) {
    const nb = await getStealthBalances(publicClient, nativeIdx.map((i) => utxos[i].stealthAddress));
    nativeIdx.forEach((idx, k) => (balances[idx] = nb[k]));
  }
  for (const [token, idxs] of byToken) {
    const tb = await getTokenBalances(publicClient, token, idxs.map((i) => utxos[i].stealthAddress));
    idxs.forEach((idx, k) => (balances[idx] = tb[k]));
  }

  const coins = utxos.map((utxo, i) => ({ utxo, balance: balances[i] }));
  return coins.filter((c) => c.balance > 0n).sort((a, b) => (a.balance < b.balance ? 1 : -1));
};

// Total shieldable balance held across the user's stealth UTXOs (the source
// "coin" total for the privacy-by-default deposit).
export const getStealthTotal = async (username: string): Promise<bigint> => {
  const utxos = getSpendableUTXOs(username);
  if (utxos.length === 0) return 0n;
  const publicClient = createPublicClient({ chain: activeChain(), transport: sepoliaTransport() });
  const balances = await getStealthBalances(publicClient, utxos.map((u) => u.stealthAddress));
  return balances.reduce((s, b) => s + b, 0n);
};

/* ── Smart shield (privacy-by-default deposit into RAILGUN) ──────────────────
   Re-instantiate a stealth UTXO's Safe and submit a pre-built tx (the Railgun
   shield) FROM it — mirrors spendStealthUTXO's Safe derivation. Pimlico
   sponsors gas, so the stealth address needs no native ETH for gas (only the
   `value` being shielded, which is part of its own balance). */
const shieldStealthUTXO = async (
  utxo: StealthUTXO,
  keys: { spendingPrivateKey: `0x${string}`; viewingPrivateKey: `0x${string}`; mlkemDecapsKey: Uint8Array },
  // Native shield = 1 call; ERC20 shield = [approve(proxy), shield] in ONE UserOp.
  shieldCalls:
    | { to: string; data: string; value: string }
    | { to: string; data: string; value: string }[],
): Promise<string> => {
  const h = await deriveStealthH(keys.viewingPrivateKey, keys.mlkemDecapsKey, utxo.ephemeralPubkey, utxo.kemCiphertext);
  const saltNonce = BigInt(h).toString();
  const stealthPrivKey = await deriveStealthSpendingKey(
    keys.spendingPrivateKey,
    keys.viewingPrivateKey,
    keys.mlkemDecapsKey,
    utxo.ephemeralPubkey,
    utxo.kemCiphertext,
  );
  const stealthOwner = privateKeyToAccount(stealthPrivKey);
  const stealthPack = await Safe4337Pack.init({
    provider: RPC_URL,
    signer: stealthPrivKey,
    bundlerUrl: BUNDLER_URL,
    safeModulesVersion: SAFE_MODULES_VERSION,
    customContracts: {
      entryPointAddress: ENTRYPOINT_ADDRESS,
      safe4337ModuleAddress: SAFE_MODULES_ADDRESS,
    },
    paymasterOptions: { isSponsored: true, paymasterUrl: PAYMASTER_URL },
    options: { owners: [stealthOwner.address], threshold: 1, safeVersion: SAFE_SW_VERSION, saltNonce },
  });
  const predicted = await stealthPack.protocolKit.getAddress();
  if (predicted.toLowerCase() !== utxo.stealthAddress.toLowerCase()) {
    throw new Error(`Stealth Safe mismatch: ${predicted} ≠ ${utxo.stealthAddress}`);
  }
  const calls = Array.isArray(shieldCalls) ? shieldCalls : [shieldCalls];
  return sendTxsViaSafe(stealthPack, calls);
};

export type SmartShieldResult = {
  success: boolean;
  shieldedAmount: bigint;
  txHashes: string[];
  error?: string;
};

// Shield `totalAmount` into the pool drawing ONLY from the user's stealth UTXOs
// (largest first), each from its own one-time stealth Safe → inlinkable. A
// partial on the boundary UTXO is fine: the change stays in that same stealth
// Safe (already a one-time address, no new linkage). The main Safe is NOT used
// (that would be linkable — that's the separate public-shield path). One
// passkey tap derives the stealth keys reused for every chunk.
// `buildShieldTx(amount)` builds the Railgun shield tx to the user's 0zk so the
// heavy SDK stays in the caller (this module never imports it).
export const smartShield = async (
  totalAmount: bigint,
  username: string,
  asset: string | null, // null = native; token address = drain that token's stealth UTXOs
  buildShieldCalls: (asset: string | null, amount: bigint) => Promise<{ to: string; data: string; value: string }[]>,
): Promise<SmartShieldResult> => {
  const cred = await getWalletCredential(username).catch(() => null);
  if (!cred) return { success: false, shieldedAmount: 0n, txHashes: [], error: "Passkey not found on this device." };
  const prf = await loadFromDevice(cred.rawId);
  if (!prf || prf.length === 0) {
    return { success: false, shieldedAmount: 0n, txHashes: [], error: "Could not access your passkey. Try again." };
  }
  const keys = await derivePQKeysFromPRF(prf);

  const akey = asset?.toLowerCase() ?? null;
  const utxos = getSpendableUTXOs(username).filter((u) => (u.asset?.toLowerCase() ?? null) === akey);
  const publicClient = createPublicClient({ chain: activeChain(), transport: sepoliaTransport() });
  const addrs = utxos.map((u) => u.stealthAddress);
  const shieldBalances = asset
    ? await getTokenBalances(publicClient, asset as `0x${string}`, addrs)
    : await getStealthBalances(publicClient, addrs);
  const candidates = utxos
    .map((utxo, i) => ({ utxo, balance: shieldBalances[i] }))
    .filter((c) => c.balance > 0n)
    .sort((a, b) => (a.balance < b.balance ? 1 : -1));

  const available = candidates.reduce((sum, c) => sum + c.balance, 0n);
  if (available < totalAmount) {
    return { success: false, shieldedAmount: 0n, txHashes: [], error: "Insufficient shieldable balance." };
  }

  // Plan: largest-first whole UTXOs + a partial on the boundary to hit exactly.
  const plan: { utxo: StealthUTXO; take: bigint }[] = [];
  let remaining = totalAmount;
  for (const { utxo, balance } of candidates) {
    if (remaining <= 0n) break;
    const take = balance < remaining ? balance : remaining;
    plan.push({ utxo, take });
    remaining -= take;
  }

  console.log(`[smartShield] Plan: ${plan.length} stealth coin(s) → pool, total ${totalAmount}`);
  const txHashes: string[] = [];
  let shielded = 0n;
  for (const { utxo, take } of plan) {
    try {
      const calls = await buildShieldCalls(asset, take);
      const tx = await shieldStealthUTXO(utxo, keys, calls);
      if (!tx) throw new Error("shield returned no tx hash");
      txHashes.push(tx);
      shielded += take;
      console.log(`[smartShield] ✓ shielded ${take} from ${utxo.stealthAddress.slice(0, 8)}… — tx ${tx}`);
    } catch (e) {
      console.error("[smartShield] chunk failed:", e);
      return {
        success: false,
        shieldedAmount: shielded,
        txHashes,
        error: e instanceof Error ? e.message : "shield chunk failed",
      };
    }
  }
  return { success: true, shieldedAmount: shielded, txHashes };
};

// Coin-control shield (B advanced): shield the SELECTED stealth UTXOs whole,
// each from its own one-time Safe → inlinkable. One passkey tap derives the
// stealth keys reused for every coin. `buildShieldTx(amount)` shields to the 0zk.
export const shieldCoins = async (
  selected: StealthUTXO[],
  username: string,
  // asset = null → native (1 call); = token address → [approve, shield] (2 calls).
  buildShieldCalls: (asset: string | null, amount: bigint) => Promise<{ to: string; data: string; value: string }[]>,
): Promise<SmartShieldResult> => {
  const cred = await getWalletCredential(username).catch(() => null);
  if (!cred) return { success: false, shieldedAmount: 0n, txHashes: [], error: "Passkey not found on this device." };
  const prf = await loadFromDevice(cred.rawId);
  if (!prf || prf.length === 0) {
    return { success: false, shieldedAmount: 0n, txHashes: [], error: "Could not access your passkey. Try again." };
  }
  const keys = await derivePQKeysFromPRF(prf);
  const publicClient = createPublicClient({ chain: activeChain(), transport: sepoliaTransport() });

  console.log(`[shieldCoins] shielding ${selected.length} selected coin(s) → pool`);
  const txHashes: string[] = [];
  let shielded = 0n;
  for (const utxo of selected) {
    try {
      const asset = utxo.asset ?? null;
      // whole coin — native getBalance or this token's balanceOf
      const balance = asset
        ? (await getTokenBalances(publicClient, asset, [utxo.stealthAddress]))[0]
        : await publicClient.getBalance({ address: utxo.stealthAddress });
      if (balance === 0n) continue;
      const calls = await buildShieldCalls(asset, balance);
      const tx = await shieldStealthUTXO(utxo, keys, calls);
      if (!tx) throw new Error("shield returned no tx hash");
      txHashes.push(tx);
      shielded += balance;
      console.log(`[shieldCoins] ✓ shielded ${balance} from ${utxo.stealthAddress.slice(0, 8)}… — tx ${tx}`);
    } catch (e) {
      console.error("[shieldCoins] chunk failed:", e);
      return {
        success: false,
        shieldedAmount: shielded,
        txHashes,
        error: e instanceof Error ? e.message : "shield chunk failed",
      };
    }
  }
  return { success: true, shieldedAmount: shielded, txHashes };
};

export type SmartSendResult = {
  success: boolean;
  sentAmount: bigint;
  txHashes: string[];
  error?: string;
};

// Sends `totalAmount` to `recipientAddress` — or, if `metaAddress` is set, to a
// fresh stealth address generated from it — drawing first from the main Safe
// and, if that's not enough, from the user's stealth UTXOs (largest first).
// Each source is its own Safe with its own owner key, so a UserOp can't span
// more than one: the shortfall is covered by N sequential UserOps presented to
// the caller as a single logical send. The passkey is touched at most once —
// root keys are derived from the PRF and reused to sign every UTXO chunk.
/**
 * Build the operator-fee call for a PUBLIC native send: resolves r1do-wallet,
 * computes the skimmed fee (0.1%) and returns a one-time stealth payment call
 * for `fee` wei to the operator, ready to batch in the SAME UserOp as the send.
 * Returns null if the recipient isn't resolvable or the fee rounds to 0 —
 * fail-open: the user's send must never break because we can't collect.
 *
 * NOTE: gasWei is 0 here for now → the gas-floor is skipped and the fee is the
 * pure 0.1% margin. Floor wiring (reading the safeOperation gas) is a later step.
 * The light-world UI (SendEth Review) shows the same number via computeFee, so
 * the displayed fee always equals what's charged here.
 */
const buildSendFeeCall = async (
  totalAmount: bigint,
): Promise<{ amount: bigint; call: { to: string; data: string; value: string } } | null> => {
  const recipient = await getFeeRecipient();
  if (!recipient) return null;
  const { fee } = await quoteFee({ op: "send", asset: nativeAsset(), amount: totalAmount, gasWei: 0n });
  if (fee <= 0n) return null;
  const payment = await generateStealthPayment(recipient.metaAddress);
  return {
    amount: fee,
    call: { to: payment.stealthAddress, data: payment.calldataBlob, value: fee.toString() },
  };
};

/** Random hex of `bytes` length — for representative (not real) calldata. */
const randHex = (bytes: number): `0x${string}` =>
  `0x${Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}` as `0x${string}`;

/** Total gas cost (wei) of a built (un-submitted) SafeOperation. */
const gasWeiOf = (op: Awaited<ReturnType<Safe4337Pack["createTransaction"]>>): bigint => {
  const uo = op.getUserOperation() as {
    callGasLimit: bigint | string;
    verificationGasLimit: bigint | string;
    preVerificationGas: bigint | string;
    maxFeePerGas: bigint | string;
  };
  const b = (v: bigint | string) => BigInt(v);
  const limits = b(uo.callGasLimit) + b(uo.verificationGasLimit) + b(uo.preVerificationGas);
  const maxFee = b(uo.maxFeePerGas);
  const total = limits * maxFee;
  console.log(
    `[gas] callGasLimit=${uo.callGasLimit} verificationGasLimit=${uo.verificationGasLimit} ` +
      `preVerificationGas=${uo.preVerificationGas} maxFeePerGas=${uo.maxFeePerGas} | ` +
      `gasLimits=${limits} × maxFeePerGas=${maxFee} = gasWei=${total} (~${Number(total) / 1e18} ETH)`,
  );
  return total;
};

/**
 * Submit a fee-bearing send charging "margin + gas": build once with a
 * provisional margin-only fee to READ the real gas of the UserOp, recompute the
 * fee (margin + gasFloor), then rebuild with the final fee and submit. `buildCalls`
 * returns the transactions for a given fee (recipient gets total − fee, fee goes
 * to r1do). Returns null (fail-open) if the amount can't cover the fee.
 */
const submitSendWithFee = async (
  wallet: Safe4337Pack,
  asset: Asset,
  totalAmount: bigint,
  buildCalls: (fee: bigint) => { to: string; data: string; value: string }[],
): Promise<{ txHash: string; fee: bigint } | null> => {
  const margin = (await quoteFee({ op: "send", asset, amount: totalAmount, gasWei: 0n })).fee;
  if (totalAmount <= margin) return null;

  // Always build once (with the margin fee). On chains WITH the gas floor, read
  // the real gas off that build and bump to max(margin, gas) — rebuilding only if
  // it changed. On chains WITHOUT (Sepolia), this single build is the final op.
  let fee = margin;
  let op = await wallet.createTransaction({ transactions: buildCalls(margin) });
  if (gasFloorEnabled()) {
    const gasWei = gasWeiOf(op);
    fee = (await quoteFee({ op: "send", asset, amount: totalAmount, gasWei })).fee;
    if (totalAmount <= fee) return null; // gas pushed the fee past the amount → fail-open
    if (fee !== margin) op = await wallet.createTransaction({ transactions: buildCalls(fee) });
  }

  const signed = await wallet.signSafeOperation(op);
  if (!signed) return null;
  const userOpHash = await wallet.executeTransaction({ executable: signed });
  console.log(`[submitSendWithFee] UserOp submitted: ${userOpHash} | fee ${fee}`);
  const receipt = await waitForUserOpReceipt(wallet, userOpHash);
  if (!receipt.success) throw new Error("Send reverted on-chain");
  return { txHash: receipt.receipt.transactionHash, fee };
};

/**
 * UI helper: estimate the fee for a send so the Review can ALWAYS show the
 * breakdown (You send / Service fee / Recipient receives) — something is always
 * charged, be it the 0.1% or the gas. Builds a representative send op (no submit)
 * to read the real gas, then fee = max(0.1%, gas). `coversGas` = the 0.1% covers
 * the gas (→ show "Gas: Sponsored"). On failure / no recipient it falls back to
 * the plain 0.1% margin. The gas leg is an estimate (slippage possible on the
 * gas-dominated branch); the 0.1% branch is exact.
 */
export const quoteSendFee = async (
  wallet: Safe4337Pack,
  token: `0x${string}` | null,
  totalAmount: bigint,
  recipientAddress: `0x${string}`,
  metaAddress: `0x${string}` | null,
): Promise<{ fee: bigint; coversGas: boolean }> => {
  const asset = token ? assetByAddress(token) : nativeAsset();
  if (!asset) return { fee: 0n, coversGas: true };
  const margin = (await quoteFee({ op: "send", asset, amount: totalAmount, gasWei: 0n })).fee;
  // Gas floor off (testnet) → fee is just the 0.1%; no gas estimate, gas covered.
  if (!gasFloorEnabled()) return { fee: margin, coversGas: true };
  try {
    const recipient = await getFeeRecipient();
    if (!recipient || totalAmount <= margin) return { fee: margin, coversGas: true };
    const net = totalAmount - margin;

    // Gas depends only on the calldata SIZE, not on the real stealth address or
    // blob contents — so for the Review estimate we use a representative random
    // "review-blob" of the real length and skip the expensive ML-KEM derivation
    // (generateStealthPayment) entirely. Both the private recipient and the r1do
    // fee leg get a fresh random address + the same-sized review-blob.
    const reviewBlob = randHex(STEALTH_BLOB_LENGTH);
    let destination: `0x${string}` = recipientAddress;
    let blob: `0x${string}` | undefined;
    if (metaAddress) {
      destination = randHex(20);
      blob = reviewBlob;
    }
    const feePay = { stealthAddress: randHex(20), calldataBlob: reviewBlob };

    let calls: { to: string; data: string; value: string }[];
    if (token) {
      const transferData = encodeFunctionData({
        abi: ERC20_TRANSFER_ABI,
        functionName: "transfer",
        args: [(blob ? destination : recipientAddress) as `0x${string}`, net],
      });
      const feeTransfer = encodeFunctionData({
        abi: ERC20_TRANSFER_ABI,
        functionName: "transfer",
        args: [feePay.stealthAddress, margin],
      });
      calls = [
        { to: token, data: transferData, value: "0" },
        ...(blob ? [{ to: destination, data: blob, value: "0" }] : []),
        { to: token, data: feeTransfer, value: "0" },
        { to: feePay.stealthAddress, data: feePay.calldataBlob, value: "0" },
      ];
    } else {
      const recipientCall = blob
        ? { to: destination, data: blob, value: net.toString() }
        : { to: recipientAddress, data: "0x", value: net.toString() };
      calls = [recipientCall, { to: feePay.stealthAddress, data: feePay.calldataBlob, value: margin.toString() }];
    }

    const op = await wallet.createTransaction({ transactions: calls });
    const gasWei = gasWeiOf(op);
    const q = await quoteFee({ op: "send", asset, amount: totalAmount, gasWei });
    return { fee: q.fee, coversGas: q.boundBy === "margin" };
  } catch (e) {
    console.warn("[quoteSendFee] estimate failed, using margin:", e);
    return { fee: margin, coversGas: true };
  }
};

export const smartSend = async (
  wallet: Safe4337Pack,
  recipientAddress: `0x${string}`,
  totalAmount: bigint,
  username: string,
  metaAddress: `0x${string}` | null,
): Promise<SmartSendResult> => {
  const mainBalance = BigInt((await wallet.protocolKit.getBalance()).toString());

  // One destination for the whole logical send — generated once if private
  let destination = recipientAddress;
  let blob: `0x${string}` | undefined;
  if (metaAddress) {
    const payment = await generateStealthPayment(metaAddress);
    destination = payment.stealthAddress;
    blob = payment.calldataBlob;
  }

  // Cheap path — main Safe alone covers it. Skim the operator fee and collect it
  // as a batched stealth payment to r1do-wallet in the SAME UserOp, for BOTH a
  // public destination (plain transfer) and a private one (stealth payment +
  // blob). Recipient gets `totalAmount − fee`; the user spends `totalAmount`.
  if (mainBalance >= totalAmount) {
    const recipient = await getFeeRecipient();
    if (recipient && totalAmount > 0n) {
      // One-time stealth payment to the operator, reused across both builds so
      // the gas probe and the real op are structurally identical.
      const feePay = await generateStealthPayment(recipient.metaAddress);
      const buildCalls = (fee: bigint) => {
        const net = totalAmount - fee;
        const recipientCall = blob
          ? { to: destination, data: blob, value: net.toString() } // private: stealth + blob
          : { to: recipientAddress, data: "0x", value: net.toString() }; // public: plain transfer
        return [recipientCall, { to: feePay.stealthAddress, data: feePay.calldataBlob, value: fee.toString() }];
      };
      const res = await submitSendWithFee(wallet, nativeAsset(), totalAmount, buildCalls);
      if (res) return { success: true, sentAmount: totalAmount - res.fee, txHashes: [res.txHash] };
      // fail-open (unresolvable / amount can't cover fee) → plain send below.
    }
    const tx = blob
      ? await sendStealth(wallet, destination, totalAmount.toString(), blob)
      : await makeTx(wallet, destination, totalAmount.toString());
    return tx
      ? { success: true, sentAmount: totalAmount, txHashes: [tx] }
      : { success: false, sentAmount: 0n, txHashes: [], error: "Send failed." };
  }

  // NOTE: the draw-from-stealth-UTXO path below does NOT charge the fee yet —
  // chunked sourcing makes a clean batched skim trickier. Next step.
  console.log(`[smartSend] Main balance (${mainBalance}) short of ${totalAmount} — drawing from stealth UTXOs`);

  const cred = await getWalletCredential(username).catch(() => null);
  if (!cred) {
    return { success: false, sentAmount: 0n, txHashes: [], error: "Passkey not found on this device." };
  }
  const prf = await loadFromDevice(cred.rawId);
  if (!prf || prf.length === 0) {
    return { success: false, sentAmount: 0n, txHashes: [], error: "Could not access your passkey. Try again." };
  }
  const keys = await derivePQKeysFromPRF(prf);

  const utxos = getSpendableUTXOs(username);
  const publicClient = createPublicClient({ chain: activeChain(), transport: sepoliaTransport() });
  const sendBalances = await getStealthBalances(publicClient, utxos.map((u) => u.stealthAddress));
  const candidates = utxos
    .map((utxo, i) => ({ utxo, balance: sendBalances[i] }))
    .filter((c) => c.balance > 0n)
    .sort((a, b) => (a.balance < b.balance ? 1 : -1));

  const stealthAvailable = candidates.reduce((sum, c) => sum + c.balance, 0n);
  if (mainBalance + stealthAvailable < totalAmount) {
    return { success: false, sentAmount: 0n, txHashes: [], error: "Insufficient balance." };
  }

  type Source = { type: "main" } | { type: "utxo"; utxo: StealthUTXO };
  const plan: { source: Source; amount: bigint }[] = [];
  let remaining = totalAmount;
  if (mainBalance > 0n) {
    const take = mainBalance < remaining ? mainBalance : remaining;
    plan.push({ source: { type: "main" }, amount: take });
    remaining -= take;
  }
  for (const { utxo, balance } of candidates) {
    if (remaining <= 0n) break;
    const take = balance < remaining ? balance : remaining;
    plan.push({ source: { type: "utxo", utxo }, amount: take });
    remaining -= take;
  }

  console.log(`[smartSend] Plan: ${plan.length} chunk(s) → ${destination}`);

  // Operator fee — carve it from the FIRST (largest) chunk: that chunk delivers
  // `amount − fee` to the recipient and `fee` to r1do-wallet, batched in its own
  // UserOp (no extra op). The first chunk is the biggest single source, so it
  // comfortably exceeds the 0.1% fee. fail-open if unresolvable or chunk 0 ≤ fee.
  const feeCall = await buildSendFeeCall(totalAmount);
  const carved = feeCall && plan.length > 0 && plan[0].amount > feeCall.amount ? feeCall : null;

  const txHashes: string[] = [];
  let sent = 0n;
  for (let i = 0; i < plan.length; i++) {
    const { source, amount } = plan[i];
    // The blob only needs to ride on one chunk — the scanner finds the UTXO
    // from it and the remaining chunks land on the same stealth address.
    const chunkBlob = i === 0 ? blob : undefined;
    // Chunk 0 carries the carved fee → recipient gets `amount − fee` here.
    const toRecipient = i === 0 && carved ? amount - carved.amount : amount;
    const feeRider = i === 0 && carved ? [carved.call] : undefined;
    try {
      const tx =
        source.type === "main"
          ? feeRider
            ? await sendTxsViaSafe(wallet, [
                { to: destination, data: chunkBlob ?? "0x", value: toRecipient.toString() },
                ...feeRider,
              ])
            : chunkBlob
              ? await sendStealth(wallet, destination, toRecipient.toString(), chunkBlob)
              : await makeTx(wallet, destination, toRecipient.toString())
          : await spendStealthUTXO(
              source.utxo,
              toRecipient.toString(),
              destination,
              keys.spendingPrivateKey,
              keys.viewingPrivateKey,
              keys.mlkemDecapsKey,
              chunkBlob,
              feeRider,
            );

      if (!tx) throw new Error("Operation returned no transaction hash");
      txHashes.push(tx);
      sent += toRecipient;
    } catch (e: unknown) {
      console.error("[smartSend] Chunk failed:", e);
      return { success: false, sentAmount: sent, txHashes };
    }
  }

  return { success: true, sentAmount: sent, txHashes };
};

/**
 * ERC20 sibling of buildSendFeeCall: the operator fee is skimmed IN the token
 * being sent and collected as a stealth TOKEN payment to r1do-wallet — two calls
 * (token.transfer(stealthAddr, fee) + the blob delivery), ready to batch in the
 * SAME UserOp as the recipient transfer. Returns null on fail-open (recipient
 * unresolvable / unknown token / fee rounds to 0). gasWei 0 for now → pure 0.1%.
 */
const buildSendTokenFeeCall = async (
  token: `0x${string}`,
  totalAmount: bigint,
): Promise<{ amount: bigint; calls: { to: string; data: string; value: string }[] } | null> => {
  const recipient = await getFeeRecipient();
  if (!recipient) return null;
  const asset = assetByAddress(token);
  if (!asset) return null;
  const { fee } = await quoteFee({ op: "send", asset, amount: totalAmount, gasWei: 0n });
  if (fee <= 0n) return null;
  const payment = await generateStealthPayment(recipient.metaAddress);
  const transferData = encodeFunctionData({
    abi: ERC20_TRANSFER_ABI,
    functionName: "transfer",
    args: [payment.stealthAddress, fee],
  });
  return {
    amount: fee,
    calls: [
      { to: token, data: transferData, value: "0" },
      { to: payment.stealthAddress, data: payment.calldataBlob, value: "0" },
    ],
  };
};

/**
 * Unified operator-fee builder for ANY asset (native or a curated token), as the
 * skimmed stealth payment to r1do-wallet: native → one call, token → two
 * (transfer + blob). The shared brick for collecting the fee from a single spend
 * (e.g. coin-control in SpendStealthUTXO). Returns null on fail-open.
 */
export const buildSendFeeCalls = async (
  token: `0x${string}` | null,
  totalAmount: bigint,
): Promise<{ amount: bigint; calls: { to: string; data: string; value: string }[] } | null> => {
  if (token) return buildSendTokenFeeCall(token, totalAmount);
  const native = await buildSendFeeCall(totalAmount);
  return native ? { amount: native.amount, calls: [native.call] } : null;
};

// ERC20 sibling of smartSend: sends `totalAmount` of `token` to `recipientAddress`
// (or, if `metaAddress` is set, to a fresh stealth address), drawing first from
// the main Safe and then from stealth UTXOs tagged with THIS token (largest
// first). Same plan/blob/single-passkey discipline as smartSend; only the
// primitives differ — balanceOf reads, asset-filtered candidates, token sends.
export const smartSendToken = async (
  wallet: Safe4337Pack,
  token: `0x${string}`,
  recipientAddress: `0x${string}`,
  totalAmount: bigint,
  username: string,
  metaAddress: `0x${string}` | null,
): Promise<SmartSendResult> => {
  const publicClient = createPublicClient({ chain: activeChain(), transport: sepoliaTransport() });
  const safeAddress = (await wallet.protocolKit.getAddress()) as `0x${string}`;
  const [mainBalance] = await getTokenBalances(publicClient, token, [safeAddress]);

  // One destination for the whole logical send — generated once if private.
  let destination = recipientAddress;
  let blob: `0x${string}` | undefined;
  if (metaAddress) {
    const payment = await generateStealthPayment(metaAddress);
    destination = payment.stealthAddress;
    blob = payment.calldataBlob;
  }

  // Cheap path — the main Safe alone covers it (no passkey needed). Skim the
  // operator fee IN the token and collect it as a batched stealth TOKEN payment
  // to r1do-wallet in the SAME UserOp, for BOTH a public destination (plain
  // transfer) and a private one (token transfer to the stealth Safe + blob).
  // Recipient gets `totalAmount − fee`; the user spends `totalAmount`.
  if (mainBalance >= totalAmount) {
    const recipient = await getFeeRecipient();
    const asset = assetByAddress(token);
    if (recipient && asset && totalAmount > 0n) {
      // One-time stealth TOKEN payment to the operator, reused across both builds
      // so the gas probe and the real op are structurally identical.
      const feePay = await generateStealthPayment(recipient.metaAddress);
      const buildCalls = (fee: bigint) => {
        const net = totalAmount - fee;
        const transferData = encodeFunctionData({
          abi: ERC20_TRANSFER_ABI,
          functionName: "transfer",
          args: [(blob ? destination : recipientAddress) as `0x${string}`, net],
        });
        const recipientCalls = blob
          ? [
              { to: token, data: transferData, value: "0" }, // private: token → stealth Safe
              { to: destination, data: blob, value: "0" }, //   + blob delivery (Δ1)
            ]
          : [{ to: token, data: transferData, value: "0" }]; // public: plain token transfer
        const feeTransfer = encodeFunctionData({
          abi: ERC20_TRANSFER_ABI,
          functionName: "transfer",
          args: [feePay.stealthAddress, fee],
        });
        return [
          ...recipientCalls,
          { to: token, data: feeTransfer, value: "0" }, // fee → r1do stealth (token)
          { to: feePay.stealthAddress, data: feePay.calldataBlob, value: "0" }, //   + blob
        ];
      };
      const res = await submitSendWithFee(wallet, asset, totalAmount, buildCalls);
      if (res) return { success: true, sentAmount: totalAmount - res.fee, txHashes: [res.txHash] };
      // fail-open (unresolvable / amount can't cover fee) → plain send below.
    }
    const tx = blob
      ? await sendStealthToken(wallet, destination, token, totalAmount, blob)
      : await sendToken(wallet, token, destination, totalAmount);
    return tx
      ? { success: true, sentAmount: totalAmount, txHashes: [tx] }
      : { success: false, sentAmount: 0n, txHashes: [], error: "Send failed." };
  }

  // NOTE: the draw-from-stealth-UTXO path below does NOT charge the fee yet — same
  // as smartSend; chunked sourcing makes a clean batched skim trickier. Next step.
  console.log(`[smartSendToken] Main ${token} balance (${mainBalance}) short of ${totalAmount} — drawing from stealth UTXOs`);

  const cred = await getWalletCredential(username).catch(() => null);
  if (!cred) {
    return { success: false, sentAmount: 0n, txHashes: [], error: "Passkey not found on this device." };
  }
  const prf = await loadFromDevice(cred.rawId);
  if (!prf || prf.length === 0) {
    return { success: false, sentAmount: 0n, txHashes: [], error: "Could not access your passkey. Try again." };
  }
  const keys = await derivePQKeysFromPRF(prf);

  // Only UTXOs holding THIS token are spendable for it — a USDT UTXO can't pay
  // DAI. The tag narrows the read to the right addresses.
  const tokenUtxos = getSpendableUTXOs(username).filter((u) => u.asset?.toLowerCase() === token.toLowerCase());
  const sendBalances = await getTokenBalances(publicClient, token, tokenUtxos.map((u) => u.stealthAddress));
  const candidates = tokenUtxos
    .map((utxo, i) => ({ utxo, balance: sendBalances[i] ?? 0n }))
    .filter((c) => c.balance > 0n)
    .sort((a, b) => (a.balance < b.balance ? 1 : -1));

  const stealthAvailable = candidates.reduce((sum, c) => sum + c.balance, 0n);
  if (mainBalance + stealthAvailable < totalAmount) {
    return { success: false, sentAmount: 0n, txHashes: [], error: "Insufficient balance." };
  }

  type Source = { type: "main" } | { type: "utxo"; utxo: StealthUTXO };
  const plan: { source: Source; amount: bigint }[] = [];
  let remaining = totalAmount;
  if (mainBalance > 0n) {
    const take = mainBalance < remaining ? mainBalance : remaining;
    plan.push({ source: { type: "main" }, amount: take });
    remaining -= take;
  }
  for (const { utxo, balance } of candidates) {
    if (remaining <= 0n) break;
    const take = balance < remaining ? balance : remaining;
    plan.push({ source: { type: "utxo", utxo }, amount: take });
    remaining -= take;
  }

  console.log(`[smartSendToken] Plan: ${plan.length} chunk(s) of ${token} → ${destination}`);

  // Operator fee — carve it (IN the token) from the FIRST (largest) chunk: that
  // chunk delivers `amount − fee` to the recipient and `fee` to r1do-wallet,
  // batched in its own UserOp. fail-open if unresolvable or chunk 0 ≤ fee.
  const feeCalls = await buildSendTokenFeeCall(token, totalAmount);
  const carved = feeCalls && plan.length > 0 && plan[0].amount > feeCalls.amount ? feeCalls : null;

  const txHashes: string[] = [];
  let sent = 0n;
  for (let i = 0; i < plan.length; i++) {
    const { source, amount } = plan[i];
    // The blob rides only on the first chunk — the scanner finds the UTXO from
    // it and the remaining chunks land on the same stealth address.
    const chunkBlob = i === 0 ? blob : undefined;
    // Chunk 0 carries the carved fee → recipient gets `amount − fee` here.
    const toRecipient = i === 0 && carved ? amount - carved.amount : amount;
    const feeRider = i === 0 && carved ? carved.calls : undefined;
    try {
      let tx: string;
      if (source.type === "main") {
        if (feeRider) {
          // Batch the recipient token transfer (+ blob if private) with the token
          // fee calls in one UserOp from the main Safe.
          const transferData = encodeFunctionData({
            abi: ERC20_TRANSFER_ABI,
            functionName: "transfer",
            args: [(chunkBlob ? destination : recipientAddress) as `0x${string}`, toRecipient],
          });
          const recipientCalls = chunkBlob
            ? [
                { to: token, data: transferData, value: "0" },
                { to: destination, data: chunkBlob, value: "0" },
              ]
            : [{ to: token, data: transferData, value: "0" }];
          tx = await sendTxsViaSafe(wallet, [...recipientCalls, ...feeRider]);
        } else {
          tx = chunkBlob
            ? await sendStealthToken(wallet, destination, token, toRecipient, chunkBlob)
            : await sendToken(wallet, token, destination, toRecipient);
        }
      } else {
        tx = await spendStealthUTXO(
          source.utxo,
          toRecipient.toString(),
          destination,
          keys.spendingPrivateKey,
          keys.viewingPrivateKey,
          keys.mlkemDecapsKey,
          chunkBlob,
          feeRider,
        );
      }

      if (!tx) throw new Error("Operation returned no transaction hash");
      txHashes.push(tx);
      sent += toRecipient;
    } catch (e: unknown) {
      console.error("[smartSendToken] Chunk failed:", e);
      return { success: false, sentAmount: sent, txHashes };
    }
  }

  return { success: true, sentAmount: sent, txHashes };
};

