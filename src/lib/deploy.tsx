import { sepoliaTransport } from "@/app/constants";
import { buildSafeWallet, type SafeWallet, type BuiltUserOp } from "./aa-client";
import { encodeFunctionData, createPublicClient, formatEther } from "viem";
import { activeChain, gasFloorEnabled, directoryAddress, directoryNetwork } from "@/lib/networks";
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
  wallet: SafeWallet,
  userOperationHash: string,
) => {
  for (let i = 0; i < RECEIPT_POLL_MAX_ATTEMPTS; i++) {
    await new Promise((resolve) =>
      setTimeout(resolve, RECEIPT_POLL_INTERVAL_MS),
    );
    const receipt = await wallet.getUserOperationReceipt(userOperationHash);
    if (receipt) {
      // MEASURE: the REAL on-chain gas (not the prepared-op limits, which
      // overestimate). actualGasCost (wei paid) is the true economic cost — on
      // Arbitrum it folds in the L1 calldata premium (huge for deploying ops, whose
      // initCode is big). Correlate the hash with the `[aa] prepared op … deploy=…`
      // line to know if this op deployed the Safe. Deploy cost = (op WITH deploy) −
      // (same op WITHOUT deploy). TEMP instrumentation.
      try {
        const used = receipt.actualGasUsed ?? 0n;
        const cost = receipt.actualGasCost ?? 0n;
        const eff = used > 0n ? (Number(cost) / Number(used) / 1e9).toFixed(5) : "?";
        console.log(
          `[gas actual] op=${userOperationHash} success=${receipt.success} ` +
            `actualGasUsed=${used} actualGasCost=${cost}wei (${formatEther(cost)} ETH) effPrice=${eff}gwei`,
        );
      } catch { /* logging must never break the send */ }
      return receipt;
    }
  }
  throw new Error("Timed out waiting for user operation receipt");
};

/**
 * Send 0 to Zero Address.
 * @param {SafeWallet} wallet - Wallet built by Safe client.
 * @returns {Promise<void>}
 * @throws {Error} If the operation fails.
 */
export const makeTx = async (
  wallet: SafeWallet,
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
  wallet: SafeWallet,
  tx: { to: string; data: string; value: string },
  label = "", // MEASURE: tags the [gas] line (e.g. "transfer (USDT)")
): Promise<string> => {
  try {
    console.log(`[sendTxViaSafe] to: ${tx.to} | value: ${tx.value} | data: ${(tx.data.length - 2) / 2} bytes`);
    const safeOperation = await wallet.createTransaction({
      transactions: [{ to: tx.to, data: tx.data, value: tx.value }],
    });
    gasWeiOf(safeOperation, label); // MEASURE: real sponsored gas of this UserOp (pool transfer/unshield relay)
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
  wallet: SafeWallet,
  txs: { to: string; data: string; value: string }[],
  label = "", // MEASURE: tags the [gas] line (e.g. "shield (USDT)")
): Promise<string> => {
  if (txs.length === 0) throw new Error("sendTxsViaSafe: no calls");
  try {
    console.log(`[sendTxsViaSafe] ${txs.length} call(s): ${txs.map((t) => t.to).join(", ")}`);
    const safeOperation = await wallet.createTransaction({
      transactions: txs.map((t) => ({ to: t.to, data: t.data, value: t.value })),
    });
    gasWeiOf(safeOperation, label); // MEASURE: real sponsored gas of this UserOp (pool shield / light draw chunk)
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
  wallet: SafeWallet,
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
  wallet: SafeWallet,
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
  wallet: SafeWallet,
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
  label = "", // MEASURE: tags the [gas] line (privacy-mode relay → includes ephemeral Safe deploy)
): Promise<string> => {
  const rand = crypto.getRandomValues(new Uint8Array(16));
  const saltNonce = BigInt("0x" + Array.from(rand).map((b) => b.toString(16).padStart(2, "0")).join(""));

  const relayPack = await buildSafeWallet(relayOwnerKey, saltNonce);
  const relayAddr = await relayPack.protocolKit.getAddress();
  console.log(`[relay] fresh ephemeral relay Safe ${relayAddr} (unlinkable)`);
  return sendTxViaSafe(relayPack, tx, label);
};

/**
 * v2: publish the user's encrypted directory entry (R1DODirectory.setEntry)
 * as a sponsored UserOp from their own Safe. The blob is sealed client-side
 * (Argon2id → XChaCha20-Poly1305) — the chain only sees fp → opaque bytes.
 * As the user's first UserOp this also deploys the counterfactual Safe.
 */
export const setDirectoryEntry = async (
  wallet: SafeWallet,
  fp: `0x${string}`,
  blob: `0x${string}`,
): Promise<string> => {
  try {
    const { DIRECTORY_ABI } = await import("./registry-v2");
    const dir = directoryAddress();
    // The directory is ONE global contract on the directory network. Rebind the
    // caller's wallet to that network so this write (and its Safe deploy) lands on
    // Arbitrum via Arbitrum's Pimlico bundler — even when the active chain differs.
    // SafeL2-everywhere ⇒ the same Safe address, so the entry's safeAddress matches.
    const dirWallet = await wallet.onNetwork(directoryNetwork());
    const storeTransaction = {
      to: dir,
      data: encodeFunctionData({
        abi: DIRECTORY_ABI,
        functionName: "setEntry",
        args: [fp, blob],
      }),
      value: "0",
    };

    const safeOperation = await dirWallet.createTransaction({
      transactions: [storeTransaction],
    });

    const signedSafeOperation = await dirWallet.signSafeOperation(safeOperation);

    if (signedSafeOperation) {
      const userOperationHash = await dirWallet.executeTransaction({
        executable: signedSafeOperation,
      });

      const receipt = await waitForUserOpReceipt(dirWallet, userOperationHash);

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

// Δ: single tx — the value transfer to the (codeless) stealth Safe carries
// the delivery blob as calldata. No announcer contract, no extra call.
export const sendStealth = async (
  wallet: SafeWallet,
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

// Re-derives a stealth UTXO's owner key and instantiates its predicted Safe4337
// pack (verifying the address). Shared by spendStealthUTXO (the actual spend) and
// quoteStealthUTXOFee (the no-submit gas estimate) so both run on the SAME Safe.
const deriveStealthPack = async (
  utxo: StealthUTXO,
  spendingPrivateKey: `0x${string}`,
  viewingPrivateKey: `0x${string}`,
  mlkemDecapsKey: Uint8Array,
): Promise<SafeWallet> => {
  const h = await deriveStealthH(viewingPrivateKey, mlkemDecapsKey, utxo.ephemeralPubkey, utxo.kemCiphertext);
  const saltNonce = BigInt(h);
  const stealthPrivKey = await deriveStealthSpendingKey(
    spendingPrivateKey, viewingPrivateKey, mlkemDecapsKey, utxo.ephemeralPubkey, utxo.kemCiphertext,
  );
  const stealthPack = await buildSafeWallet(stealthPrivKey, saltNonce);
  const predicted = await stealthPack.protocolKit.getAddress();
  if (predicted.toLowerCase() !== utxo.stealthAddress.toLowerCase()) {
    throw new Error(`Predicted Safe address mismatch: ${predicted} ≠ ${utxo.stealthAddress}`);
  }
  return stealthPack;
};

/** The calls for a UTXO spend that carves the operator fee: recipient gets
 *  `gross − fee`, r1do gets `fee`. Native or token, optional recipient blob (Δ
 *  chained private). Shared by the spend and the gas-estimate so both build the
 *  exact same op. */
const buildUTXOSpendCalls = (
  utxo: StealthUTXO,
  recipient: `0x${string}`,
  calldataBlob: `0x${string}` | undefined,
  gross: bigint,
  fee: bigint,
  feePay: { stealthAddress: `0x${string}`; calldataBlob: `0x${string}` },
): { to: string; data: string; value: string }[] => {
  const net = gross - fee;
  const token = utxo.asset as `0x${string}` | undefined;
  if (token) {
    const recipTransfer = encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [recipient, net] });
    const feeTransfer = encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [feePay.stealthAddress, fee] });
    return [
      { to: token, data: recipTransfer, value: "0" },
      ...(calldataBlob ? [{ to: recipient, data: calldataBlob, value: "0" }] : []),
      { to: token, data: feeTransfer, value: "0" },
      { to: feePay.stealthAddress, data: feePay.calldataBlob, value: "0" },
    ];
  }
  return [
    { to: recipient, data: calldataBlob ?? "0x", value: net.toString() },
    { to: feePay.stealthAddress, data: feePay.calldataBlob, value: fee.toString() },
  ];
};

/**
 * UI helper for coin-control: estimate the fee for spending a stealth UTXO. Needs
 * the spending keys (passkey-derived) to instantiate the UTXO's Safe — so it's
 * called at the Review step (one passkey tap, then reused for the spend). Builds
 * a representative op (no submit) on the UTXO's Safe to read the real gas →
 * fee = max(0.1%, gas). Returns the margin (fail-open) if the floor is off or the
 * estimate fails.
 */
export const quoteStealthUTXOFee = async (
  utxo: StealthUTXO,
  spendingPrivateKey: `0x${string}`,
  viewingPrivateKey: `0x${string}`,
  mlkemDecapsKey: Uint8Array,
  recipient: `0x${string}`,
  calldataBlob: `0x${string}` | undefined,
  gross: bigint,
  feePay: { stealthAddress: `0x${string}`; calldataBlob: `0x${string}` },
  asset: Asset,
): Promise<{ fee: bigint; coversGas: boolean }> => {
  const margin = (await quoteFee({ op: "send", asset, amount: gross, gasWei: 0n })).fee;
  if (!gasFloorEnabled() || gross <= margin) return { fee: margin, coversGas: true };
  try {
    const pack = await deriveStealthPack(utxo, spendingPrivateKey, viewingPrivateKey, mlkemDecapsKey);
    const op = await pack.createTransaction({ transactions: buildUTXOSpendCalls(utxo, recipient, calldataBlob, gross, margin, feePay) });
    const gasWei = gasWeiOf(op);
    const q = await quoteFee({ op: "send", asset, amount: gross, gasWei });
    return { fee: q.fee, coversGas: q.boundBy === "margin" };
  } catch (e) {
    console.warn("[quoteStealthUTXOFee] estimate failed, using margin:", e);
    return { fee: margin, coversGas: true };
  }
};

// Spends a stealth UTXO: re-derives its owner key, instantiates the predicted
// Safe (deploying it on first spend if needed) and sends a sponsored UserOp.
// No native ETH required in the stealth address — the paymaster covers gas.
// If `calldataBlob` is set, the recipient is itself a stealth address and the
// transfer carries the delivery blob (Δ — no announcer).
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
  // When set, `amount` is the GROSS to spend and the operator fee is carved with
  // the REAL gas floor (max(0.1%, gas)) from THIS UTXO's Safe: recipient gets
  // `amount − fee`, r1do gets `fee`. Used by coin-control and the draw path's
  // chunk 0. `marginAmount` (the WHOLE send) sets the 0.1% base; it defaults to
  // `amount` (coin-control = single spend), but the draw passes the total so the
  // 0.1% is of the total while the fee is still carved from this chunk.
  feeCtx?: {
    asset: Asset;
    feePay: { stealthAddress: `0x${string}`; calldataBlob: `0x${string}` };
    marginAmount?: bigint;
  },
): Promise<string> => {
  console.log(`[spendStealthUTXO] utxo: ${utxo.stealthAddress} → ${recipient} | amount: ${amount}`);

  const stealthPack = await deriveStealthPack(utxo, spendingPrivateKey, viewingPrivateKey, mlkemDecapsKey);

  // Gas-floor path (coin-control): `amount` is the GROSS. Carve the fee with the
  // real gas read off THIS UTXO's Safe — recipient gets `amount − fee`, r1do gets
  // `fee = max(0.1%, gas)`. Same submitSendWithFee dance, just from the stealth pack.
  if (feeCtx) {
    const gross = BigInt(amount);
    const res = await submitSendWithFee(
      stealthPack,
      feeCtx.asset,
      feeCtx.marginAmount ?? gross, // 0.1% base (total in the draw, gross in coin-control)
      (fee) => buildUTXOSpendCalls(utxo, recipient, calldataBlob, gross, fee, feeCtx.feePay),
      gross, // the fee is carved from THIS chunk
    );
    return res ? res.txHash : "";
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

  // Chained private spend (blob rides the transfer, Δ) and/or extra calls (e.g.
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
// Shield ONE stealth UTXO into the pool from its OWN one-time Safe, skimming the
// R1DO operator fee (gas × 1.15) off-the-top in the SAME UserOp: shields
// `amount − fee` and sends `fee` to a fresh Δ stealth of r1do (native: value+blob;
// ERC20: transfer+blob). The fee is based on the REAL gas of THIS op — which
// includes the stealth Safe's deploy on its first spend, so privacy covers it.
// Common neck for BOTH shield modes (smartShield + shieldCoins). Fail-open: no fee
// recipient, unknown asset, or fee ≥ amount → plain shield (never lose the chunk).
const shieldStealthUTXOWithFee = async (
  utxo: StealthUTXO,
  keys: { spendingPrivateKey: `0x${string}`; viewingPrivateKey: `0x${string}`; mlkemDecapsKey: Uint8Array },
  asset: string | null, // ERC20 address, or null = native
  amount: bigint, // what leaves this stealth Safe toward the pool (before the skim)
  buildShieldCalls: (asset: string | null, amount: bigint) => Promise<{ to: string; data: string; value: string }[]>,
  feeRecipient: { metaAddress: `0x${string}` } | null, // resolved ONCE by the caller
  label = "", // MEASURE: tags the [gas] line
): Promise<{ txHash: string; fee: bigint }> => {
  const saltNonce = BigInt(await deriveStealthH(keys.viewingPrivateKey, keys.mlkemDecapsKey, utxo.ephemeralPubkey, utxo.kemCiphertext));
  const stealthPrivKey = await deriveStealthSpendingKey(
    keys.spendingPrivateKey,
    keys.viewingPrivateKey,
    keys.mlkemDecapsKey,
    utxo.ephemeralPubkey,
    utxo.kemCiphertext,
  );
  const stealthPack = await buildSafeWallet(stealthPrivKey, saltNonce);
  const predicted = await stealthPack.protocolKit.getAddress();
  if (predicted.toLowerCase() !== utxo.stealthAddress.toLowerCase()) {
    throw new Error(`Stealth Safe mismatch: ${predicted} ≠ ${utxo.stealthAddress}`);
  }

  const assetObj: Asset | null = asset === null ? nativeAsset() : (assetByAddress(asset) ?? null);
  const plain = async (): Promise<{ txHash: string; fee: bigint }> => {
    const calls = await buildShieldCalls(asset, amount);
    return { txHash: await sendTxsViaSafe(stealthPack, calls, label), fee: 0n };
  };
  if (!feeRecipient || !assetObj) return plain(); // no operator / unknown asset → plain shield

  const feePay = await generateStealthPayment(feeRecipient.metaAddress);
  // Skim `fee` to r1do from the SAME stealth Safe (native: value+blob; ERC20: transfer+blob).
  const feeCalls = (fee: bigint) =>
    asset === null
      ? [{ to: feePay.stealthAddress, data: feePay.calldataBlob, value: fee.toString() }]
      : [
          { to: asset, data: encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [feePay.stealthAddress, fee] }), value: "0" },
          { to: feePay.stealthAddress, data: feePay.calldataBlob, value: "0" },
        ];
  const build = async (fee: bigint) => [...(await buildShieldCalls(asset, amount - fee)), ...feeCalls(fee)];

  // Read the REAL gas (zero-fee placeholder, same calldata shape) → fee = gas × 1.15.
  const probe = await stealthPack.createTransaction({ transactions: await build(0n) });
  const gasWei = gasWeiOf(probe, label);
  const { fee } = await quoteFee({ op: "shield", asset: assetObj, amount, gasWei });
  if (fee <= 0n || fee >= amount) return plain(); // gas ≥ chunk → skip the fee, never lose the shield

  const txHash = await sendTxsViaSafe(stealthPack, await build(fee), label);
  return { txHash, fee };
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
  const feeRecipient = await getFeeRecipient(); // resolved ONCE; fresh r1do stealth per chunk
  const txHashes: string[] = [];
  let shielded = 0n;
  for (const { utxo, take } of plan) {
    try {
      const { txHash: tx, fee } = await shieldStealthUTXOWithFee(utxo, keys, asset, take, buildShieldCalls, feeRecipient, `shield (${asset ? "ERC20" : "native"}, privacy)`);
      if (!tx) throw new Error("shield returned no tx hash");
      txHashes.push(tx);
      shielded += take - fee; // the pool got take − fee (fee → r1do)
      console.log(`[smartShield] ✓ shielded ${take - fee} (+fee ${fee}) from ${utxo.stealthAddress.slice(0, 8)}… — tx ${tx}`);
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
  const feeRecipient = await getFeeRecipient(); // resolved ONCE; fresh r1do stealth per coin
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
      const { txHash: tx, fee } = await shieldStealthUTXOWithFee(utxo, keys, asset, balance, buildShieldCalls, feeRecipient, `shield (${asset ? "ERC20" : "native"}, privacy)`);
      if (!tx) throw new Error("shield returned no tx hash");
      txHashes.push(tx);
      shielded += balance - fee; // coin fully consumed: pool balance−fee + r1do fee
      console.log(`[shieldCoins] ✓ shielded ${balance - fee} (+fee ${fee}) from ${utxo.stealthAddress.slice(0, 8)}… — tx ${tx}`);
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

/**
 * PUBLIC shield WITH the operator fee — one sponsored UserOp from the main Safe
 * (already deployed, no passkey). Shields `amount − fee` into the pool and skims
 * `fee` to r1do as a batched stealth payment in the SAME op (native: value+blob;
 * token: transfer+blob). fee = max(flat-pinch, gas) (op "shield"). Mirrors
 * submitSendWithFee but with an ASYNC call builder (the Railgun shield calls are
 * built by the SDK). `buildShieldCalls` is passed in so this module never imports
 * the SDK. Returns null (fail-open → caller does a plain shield) when r1do is
 * unresolvable or the amount can't cover the fee.
 *
 * NOTE (Δ): only the PUBLIC path is fee'd for now. The privacy multi-chunk
 * shield and the unshield fee are a later step (magnitudes set on Arbitrum).
 */
export type ShieldFeeResult =
  | { ok: true; txHash: string; fee: bigint }
  | { ok: false; reason: "no-recipient" | "too-small" };

export const shieldPublicWithFee = async (
  wallet: SafeWallet,
  asset: Asset,
  token: `0x${string}` | null,
  amount: bigint,
  buildShieldCalls: (asset: string | null, amt: bigint) => Promise<{ to: string; data: string; value: string }[]>,
): Promise<ShieldFeeResult> => {
  const recipient = await getFeeRecipient();
  if (!recipient) return { ok: false, reason: "no-recipient" }; // can't collect → caller shields plain
  if (amount <= 0n) return { ok: false, reason: "too-small" };
  const feePay = await generateStealthPayment(recipient.metaAddress);
  const label = `shield (${token ? "ERC20" : "native"}, public)`;

  // Skim `fee` to r1do in the shielded asset, batched after the shield calls.
  const feeCalls = (fee: bigint) =>
    token
      ? [
          { to: token as string, data: encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [feePay.stealthAddress, fee] }), value: "0" },
          { to: feePay.stealthAddress, data: feePay.calldataBlob, value: "0" },
        ]
      : [{ to: feePay.stealthAddress, data: feePay.calldataBlob, value: fee.toString() }];
  const build = async (fee: bigint) => [...(await buildShieldCalls(token, amount - fee)), ...feeCalls(fee)];

  // Gas-based cost-plus: build once with a zero-fee placeholder to read the REAL
  // gas, then fee = gas × markup (op "shield" → ×1.15) and rebuild. The gas barely
  // changes with the fee amount (same calldata shape), so one estimate is enough.
  let calls = await build(0n);
  const probe = await wallet.createTransaction({ transactions: calls });
  const gasWei = gasWeiOf(probe, label);
  const fee = (await quoteFee({ op: "shield", asset, amount, gasWei })).fee;
  if (fee <= 0n || amount <= fee) return { ok: false, reason: "too-small" }; // gas ≥ amount → block, never free
  calls = await build(fee);

  const tx = await sendTxsViaSafe(wallet, calls, label);
  return tx ? { ok: true, txHash: tx, fee } : { ok: false, reason: "no-recipient" };
};

export type UnshieldFeeResult =
  | { ok: true; txHash: string; fee: bigint }
  | { ok: false; reason: "no-recipient" | "too-small" };

/**
 * PUBLIC unshield (ERC20 or native ETH) WITH the R1DO operator fee, skimmed like the
 * shield's. Railgun rejects two unshields of the same token in one batch
 * ("addUnshieldData once per token"), so the fee can't be a second proof output.
 * Instead we unshield the FULL amount to our OWN Safe (one legal output) and, in the
 * SAME UserOp, the Safe distributes: `net` to the user's destination + `fee` to a
 * fresh Δ stealth of r1do-wallet (blob announced so r1do can detect+spend it).
 * The batch also unlocks the NATIVE fee in ETH: the base-token unshield unwraps
 * WETH→ETH into the Safe, so the fee leg is a plain ETH transfer (no WETH detour).
 * Gas-based fee = gas × markup (op "unshield" → ×1.30). PUBLIC only (privacy = later).
 * Fails open ("no-recipient"/"too-small") so the caller can do a plain unshield.
 */
export const unshieldPublicWithFee = async (
  wallet: SafeWallet,
  asset: Asset,
  token: `0x${string}` | null, // null = native ETH (fee leg is a value transfer)
  moves: bigint, // total leaving the pool (gross, before Railgun's own fee)
  destination: `0x${string}`,
  railgunBps: number, // Railgun's unshield fee (25 = 0.25%) — the Safe receives moves minus this
  proveUnshield: (toAddress: string, amount: bigint) => Promise<{ to: string; data: string; value: string }>,
): Promise<UnshieldFeeResult> => {
  const recipient = await getFeeRecipient();
  if (!recipient) return { ok: false, reason: "no-recipient" };
  const feePay = await generateStealthPayment(recipient.metaAddress);
  const safeAddr = (await wallet.protocolKit.getAddress()) as `0x${string}`;
  const label = `unshield (${asset.symbol}, public + fee)`;
  // Unshield the FULL amount to our own Safe (the proof runs here — heavy). This is
  // fee-INDEPENDENT, so it's proved ONCE; the fee only changes the transfer amounts.
  const proven = await proveUnshield(safeAddr, moves);
  // The Safe only receives `moves − Railgun's 0.25%` → that's what's distributable.
  const received = moves - (moves * BigInt(railgunBps)) / 10_000n;
  const isNative = token === null;
  // A plain value/token move as a Safe call.
  const transfer = (to: string, amt: bigint) =>
    isNative
      ? { to, data: "0x", value: amt.toString() }
      : {
          to: token as string,
          data: encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [to as `0x${string}`, amt] }),
          value: "0",
        };
  const isExternal = destination.toLowerCase() !== safeAddr.toLowerCase();
  const buildCalls = (fee: bigint) => [
    proven,
    // net → user's destination (skip when they withdrew to their own Safe: the net
    // just stays there, and we only move the fee out).
    ...(isExternal ? [transfer(destination, received - fee)] : []),
    // fee → r1do's fresh Δ stealth. Native: ONE call carries the fee (value) AND
    // the blob. ERC20: a token transfer + a 0-value blob announce.
    ...(isNative
      ? [{ to: feePay.stealthAddress, data: feePay.calldataBlob, value: fee.toString() }]
      : [transfer(feePay.stealthAddress, fee), { to: feePay.stealthAddress, data: feePay.calldataBlob, value: "0" }]),
  ];
  // Gas-based cost-plus: read the batch's REAL gas (zero-fee placeholder), then
  // fee = gas × markup and rebuild the transfers (no re-prove — proven leg unchanged).
  const probe = await wallet.createTransaction({ transactions: buildCalls(0n) });
  const gasWei = gasWeiOf(probe, label);
  const { fee } = await quoteFee({ op: "unshield", asset, amount: moves, gasWei });
  if (fee <= 0n || received - fee <= 0n) return { ok: false, reason: "too-small" };
  const txHash = await sendTxsViaSafe(wallet, buildCalls(fee), label);
  return txHash ? { ok: true, txHash, fee } : { ok: false, reason: "no-recipient" };
};

/**
 * PRIVACY unshield (ERC20 or native ETH) WITH the R1DO operator fee. Same batch idea
 * as the public one, but the "repartidor" is a FRESH EPHEMERAL Safe (throwaway,
 * unlinkable to your identity) instead of your main Safe — so the withdrawal isn't
 * linked to you. Because the unshield is proof-bound (the recipient lives INSIDE the
 * proof), the ephemeral Safe's address must exist BEFORE proving: we build it first,
 * prove the unshield → it, then it fans out in the SAME UserOp:
 *   net → your destination (+ your Δ blob folded in, when `destBlob` is set = your
 *         own fresh stealth + announce), and fee → a fresh Δ stealth of r1do.
 * The r1do blob is ALWAYS included (r1do needs it on-chain to detect+spend its fee).
 * No fee recipient → still routes through the ephemeral Safe (privacy), just with no
 * fee legs (net = full received). Gas (incl. the ephemeral deploy) × 1.30.
 */
export const unshieldPrivacyWithFee = async (
  relayOwnerKey: `0x${string}`,
  asset: Asset,
  token: `0x${string}` | null, // null = native ETH
  moves: bigint, // total leaving the pool (gross, before Railgun's own fee)
  destination: `0x${string}`, // your fresh stealth OR an external address
  railgunBps: number,
  proveUnshield: (toAddress: string, amount: bigint) => Promise<{ to: string; data: string; value: string }>,
  destBlob: `0x${string}` | null, // your OWN stealth's Δ blob to announce in-batch (announce), or null (ghost/external)
): Promise<UnshieldFeeResult> => {
  const recipient = await getFeeRecipient();
  const feePay = recipient ? await generateStealthPayment(recipient.metaAddress) : null;

  // Ephemeral repartidor Safe FIRST — its address is the unshield's proof recipient.
  const rand = crypto.getRandomValues(new Uint8Array(16));
  const saltNonce = BigInt("0x" + Array.from(rand).map((b) => b.toString(16).padStart(2, "0")).join(""));
  const relayPack = await buildSafeWallet(relayOwnerKey, saltNonce);
  const ephemeralAddr = (await relayPack.protocolKit.getAddress()) as `0x${string}`;
  const label = `unshield (${asset.symbol}, privacy${feePay ? " + fee" : ""})`;
  console.log(`[relay] ephemeral repartidor Safe ${ephemeralAddr} (unlinkable)`);

  // Prove the unshield → the ephemeral Safe (heavy, once, fee-independent).
  const proven = await proveUnshield(ephemeralAddr, moves);
  const received = moves - (moves * BigInt(railgunBps)) / 10_000n; // ephemeral Safe gets this
  const isNative = token === null;
  const transfer = (to: string, amt: bigint) =>
    isNative
      ? { to, data: "0x", value: amt.toString() }
      : {
          to: token as string,
          data: encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [to as `0x${string}`, amt] }),
          value: "0",
        };
  // net → destination (+ your blob if announce). Native folds value+blob into one call.
  const destLegs = (net: bigint) =>
    isNative
      ? [{ to: destination, data: destBlob ?? "0x", value: net.toString() }]
      : [transfer(destination, net), ...(destBlob ? [{ to: destination, data: destBlob, value: "0" }] : [])];
  // fee → r1do (only when there's a recipient). Native: value+blob; ERC20: transfer+blob.
  const feeLegs = (fee: bigint) =>
    !feePay
      ? []
      : isNative
        ? [{ to: feePay.stealthAddress, data: feePay.calldataBlob, value: fee.toString() }]
        : [transfer(feePay.stealthAddress, fee), { to: feePay.stealthAddress, data: feePay.calldataBlob, value: "0" }];
  const buildCalls = (fee: bigint) => [proven, ...destLegs(received - fee), ...feeLegs(fee)];

  // No operator fee → net = full received, relay as-is (still via the ephemeral Safe).
  if (!feePay) {
    const txHash = await sendTxsViaSafe(relayPack, buildCalls(0n), label);
    return { ok: true, txHash, fee: 0n };
  }
  // Gas-based cost-plus: read the batch's REAL gas (incl. the ephemeral deploy) → ×1.30.
  const probe = await relayPack.createTransaction({ transactions: buildCalls(0n) });
  const gasWei = gasWeiOf(probe, label);
  const { fee } = await quoteFee({ op: "unshield", asset, amount: moves, gasWei });
  if (fee <= 0n || received - fee <= 0n) return { ok: false, reason: "too-small" };
  const txHash = await sendTxsViaSafe(relayPack, buildCalls(fee), label);
  return txHash ? { ok: true, txHash, fee } : { ok: false, reason: "no-recipient" };
};

/**
 * UI helper: estimate the PUBLIC shield operator fee (no submit) so the deposit
 * dialog shows the breakdown and blocks "amount too small". Builds the real shield
 * op on the main Safe (deployed → no passkey) to read gas → fee = gas × markup.
 * Uses a random-blob dummy for the fee leg (gas depends on calldata SIZE, not the
 * real r1do stealth payment) so the estimate skips the ML-KEM derivation. Returns
 * fee 0 on failure / no recipient (caller shields plain, never blocks).
 */
export const quoteShieldFee = async (
  wallet: SafeWallet,
  asset: Asset,
  token: `0x${string}` | null,
  amount: bigint,
  buildShieldCalls: (asset: string | null, amt: bigint) => Promise<{ to: string; data: string; value: string }[]>,
): Promise<{ fee: bigint; coversGas: boolean; feeTooBig: boolean }> => {
  try {
    const recipient = await getFeeRecipient();
    if (!recipient) return { fee: 0n, coversGas: true, feeTooBig: false };
    // Estimate the op with a zero-fee placeholder leg (calldata shape = same gas).
    const reviewBlob = randHex(STEALTH_BLOB_LENGTH);
    const feeAddr = randHex(20);
    const feeCalls = token
      ? [
          { to: token as string, data: encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [feeAddr, 0n] }), value: "0" },
          { to: feeAddr, data: reviewBlob, value: "0" },
        ]
      : [{ to: feeAddr, data: reviewBlob, value: "0" }];
    const calls = [...(await buildShieldCalls(token, amount)), ...feeCalls];
    const op = await wallet.createTransaction({ transactions: calls });
    const gasWei = gasWeiOf(op, `${token ? "ERC20" : "native"} shield [quote]`);
    const q = await quoteFee({ op: "shield", asset, amount, gasWei });
    // Gas-based: the fee IS the gas × markup, so it always "covers gas" by design.
    return { fee: q.fee, coversGas: true, feeTooBig: amount <= q.fee };
  } catch (e) {
    console.warn("[quoteShieldFee] estimate failed, no fee:", e);
    return { fee: 0n, coversGas: true, feeTooBig: false };
  }
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
/** Random hex of `bytes` length — for representative (not real) calldata. */
const randHex = (bytes: number): `0x${string}` =>
  `0x${Array.from(crypto.getRandomValues(new Uint8Array(bytes)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")}` as `0x${string}`;

/** Total gas cost (wei) of a built (un-submitted) SafeOperation. `label` tags the
 *  log line so measurement runs are self-identifying (op + asset). */
const gasWeiOf = (op: BuiltUserOp, label = ""): bigint => {
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
    `[gas]${label ? ` ${label}` : ""} callGasLimit=${uo.callGasLimit} verificationGasLimit=${uo.verificationGasLimit} ` +
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
  wallet: SafeWallet,
  asset: Asset,
  // The 0.1% margin is computed off `marginAmount` (the WHOLE send). The fee is
  // CARVED from `carveAmount` (defaults to marginAmount) — in the draw path the
  // margin is 0.1% of the total but the fee comes out of chunk 0, so they differ.
  marginAmount: bigint,
  buildCalls: (fee: bigint) => { to: string; data: string; value: string }[],
  carveAmount: bigint = marginAmount,
): Promise<{ txHash: string; fee: bigint } | null> => {
  const margin = (await quoteFee({ op: "send", asset, amount: marginAmount, gasWei: 0n })).fee;
  if (carveAmount <= margin) return null;

  // Always build once (with the margin fee). On chains WITH the gas floor, read
  // the real gas off that build and bump to max(margin, gas) — rebuilding only if
  // it changed. On chains WITHOUT (Sepolia), this single build is the final op.
  let fee = margin;
  let op = await wallet.createTransaction({ transactions: buildCalls(margin) });
  if (gasFloorEnabled()) {
    const gasWei = gasWeiOf(op);
    fee = (await quoteFee({ op: "send", asset, amount: marginAmount, gasWei })).fee;
    if (carveAmount <= fee) return null; // gas pushed the fee past the carve source → fail-open
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
  wallet: SafeWallet,
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

/* ── Draw path (multi-source send) ──────────────────────────────────────────
   When the main Safe alone can't cover the send, the shortfall is sourced from
   the user's native stealth UTXOs. Each source is its own Safe → N sponsored
   UserOps (one per chunk). The operator's REAL gas is therefore the SUM of all
   N chunks, and the fee is decided against the WHOLE send: fee = max(0.1% ×
   total, Σ gas). The fee is carved OFF THE TOP across chunks (r1do filled first,
   recipient gets the rest), so the charge never hinges on a single chunk. If the
   total can't cover the fee the UI blocks "Amount too small" — never a free send. */

export type DrawSource = { type: "main" } | { type: "utxo"; utxo: StealthUTXO };

export type DrawKeys = {
  spendingPrivateKey: `0x${string}`;
  viewingPrivateKey: `0x${string}`;
  mlkemDecapsKey: Uint8Array;
};

/** A draw prepared at the Review step (one passkey tap): the plan, the fee read
 *  off the SUMMED chunk gas, the keys and the one-time stealth payments — all
 *  reused by smartSend so the send touches the passkey zero extra times. */
export type PreparedDraw = {
  keys: DrawKeys;
  plan: { source: DrawSource; amount: bigint }[];
  fee: bigint;
  feePay: { stealthAddress: `0x${string}`; calldataBlob: `0x${string}` } | null;
  destination: `0x${string}`;
  blob?: `0x${string}`;
  // The ERC20 being sent, or undefined for a native draw. Drives the chunk call
  // shape (token.transfer + separate blob call vs a value transfer carrying it).
  token?: `0x${string}`;
};

/** Calls for ONE draw chunk: deliver `toRecip` to the recipient and/or `toFee` to
 *  r1do. Native moves `value` (the blob rides as the transfer calldata); a token
 *  does `transfer()` with the blob as a separate delivery call. Legs with a zero
 *  amount are omitted. Shared by the recipient/fee split across every chunk. */
const buildChunkCalls = (
  token: `0x${string}` | undefined,
  destination: `0x${string}`,
  recipBlob: `0x${string}` | undefined,
  feeStealthAddr: `0x${string}` | undefined,
  feeBlob: `0x${string}` | undefined,
  toRecip: bigint,
  toFee: bigint,
): { to: string; data: string; value: string }[] => {
  const calls: { to: string; data: string; value: string }[] = [];
  if (token) {
    if (toRecip > 0n) {
      const d = encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [destination, toRecip] });
      calls.push({ to: token, data: d, value: "0" });
      if (recipBlob) calls.push({ to: destination, data: recipBlob, value: "0" });
    }
    if (toFee > 0n && feeStealthAddr) {
      const d = encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [feeStealthAddr, toFee] });
      calls.push({ to: token, data: d, value: "0" });
      if (feeBlob) calls.push({ to: feeStealthAddr, data: feeBlob, value: "0" });
    }
  } else {
    if (toRecip > 0n) calls.push({ to: destination, data: recipBlob ?? "0x", value: toRecip.toString() });
    if (toFee > 0n && feeStealthAddr) calls.push({ to: feeStealthAddr, data: feeBlob ?? "0x", value: toFee.toString() });
  }
  return calls;
};

/** Builds the draw plan: which sources (main first, then stealth UTXOs holding
 *  the asset, largest-first) fund `total`, and how much from each. `token` =
 *  undefined for native, else the ERC20 to drain. Keyless — only reads balances.
 *  Returns null if the combined balance can't cover `total`. */
export const planDraw = async (
  wallet: SafeWallet,
  username: string,
  total: bigint,
  token?: `0x${string}`,
): Promise<{ plan: { source: DrawSource; amount: bigint }[]; mainBalance: bigint } | null> => {
  const publicClient = createPublicClient({ chain: activeChain(), transport: sepoliaTransport() });
  let mainBalance: bigint;
  let utxos: StealthUTXO[];
  let balances: bigint[];
  if (token) {
    const safe = (await wallet.protocolKit.getAddress()) as `0x${string}`;
    [mainBalance] = await getTokenBalances(publicClient, token, [safe]);
    utxos = getSpendableUTXOs(username).filter((u) => u.asset?.toLowerCase() === token.toLowerCase());
    balances = await getTokenBalances(publicClient, token, utxos.map((u) => u.stealthAddress));
  } else {
    mainBalance = BigInt((await wallet.protocolKit.getBalance()).toString());
    utxos = getSpendableUTXOs(username).filter((u) => !u.asset); // native UTXOs only
    balances = await getStealthBalances(publicClient, utxos.map((u) => u.stealthAddress));
  }
  const candidates = utxos
    .map((utxo, i) => ({ utxo, balance: balances[i] ?? 0n }))
    .filter((c) => c.balance > 0n)
    .sort((a, b) => (a.balance < b.balance ? 1 : -1));

  const available = mainBalance + candidates.reduce((s, c) => s + c.balance, 0n);
  if (available < total) return null;

  const plan: { source: DrawSource; amount: bigint }[] = [];
  let remaining = total;
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
  return { plan, mainBalance };
};

/**
 * UI helper for the DRAW path: estimate the fee for a multi-chunk send. A draw is
 * N sponsored UserOps (one per source Safe), so the operator's real gas is the
 * SUM of all N → fee = max(0.1% × total, Σ gas). Needs the passkey-derived keys
 * to instantiate each UTXO's Safe, so it runs at the Review step (one tap, reused
 * for the send). Builds a representative full-shape op per chunk (no submit) to
 * read gas. `feeTooBig` = the total can't cover the fee → the UI must block
 * "Amount too small" (never send for free). Falls back to the 0.1% margin if the
 * floor is off or an estimate throws.
 */
export const quoteDrawFee = async (
  wallet: SafeWallet,
  keys: DrawKeys,
  plan: { source: DrawSource; amount: bigint }[],
  total: bigint,
  destination: `0x${string}`,
  blob: `0x${string}` | undefined,
  feePay: { stealthAddress: `0x${string}`; calldataBlob: `0x${string}` },
  asset: Asset,
): Promise<{ fee: bigint; coversGas: boolean; feeTooBig: boolean }> => {
  const margin = (await quoteFee({ op: "send", asset, amount: total, gasWei: 0n })).fee;
  if (!gasFloorEnabled()) return { fee: margin, coversGas: true, feeTooBig: total <= margin };
  const token = (asset.address ?? undefined) as `0x${string}` | undefined;
  try {
    let gasWei = 0n;
    for (const { source, amount } of plan) {
      // Representative full-shape chunk (recipient leg + a zero-value fee leg) →
      // upper-bound gas; over-estimating the floor is safe (never undercharges).
      // The fee leg carries the blob (size = gas) but moves 0 so the chunk never
      // exceeds the source balance during estimation.
      const calls = token
        ? [
            { to: token, data: encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [destination, amount] }), value: "0" },
            ...(blob ? [{ to: destination, data: blob, value: "0" }] : []),
            { to: token, data: encodeFunctionData({ abi: ERC20_TRANSFER_ABI, functionName: "transfer", args: [feePay.stealthAddress, 0n] }), value: "0" },
            { to: feePay.stealthAddress, data: feePay.calldataBlob, value: "0" },
          ]
        : [
            { to: destination, data: blob ?? "0x", value: amount.toString() },
            { to: feePay.stealthAddress, data: feePay.calldataBlob, value: "0" },
          ];
      const pack =
        source.type === "utxo"
          ? await deriveStealthPack(source.utxo, keys.spendingPrivateKey, keys.viewingPrivateKey, keys.mlkemDecapsKey)
          : wallet;
      const op = await pack.createTransaction({ transactions: calls });
      gasWei += gasWeiOf(op);
    }
    const q = await quoteFee({ op: "send", asset, amount: total, gasWei });
    return { fee: q.fee, coversGas: q.boundBy === "margin", feeTooBig: total <= q.fee };
  } catch (e) {
    console.warn("[quoteDrawFee] estimate failed, using margin:", e);
    return { fee: margin, coversGas: true, feeTooBig: total <= margin };
  }
};

/**
 * Execute a prepared draw: N sponsored UserOps, one per source. The fee is carved
 * OFF THE TOP across chunks — r1do is filled first, the recipient gets the rest —
 * so the charge is decided on the TOTAL, never on one chunk. Each chunk delivers
 * `toRecip` to the recipient and/or `toFee` to r1do; the recipient blob and the
 * fee blob each ride the FIRST chunk that carries value to that party. A failed
 * chunk aborts (the partial is reported) — it NEVER falls back to a free send.
 * `sentAmount` is what the recipient receives (total − fee).
 */
const executeDraw = async (
  wallet: SafeWallet,
  plan: { source: DrawSource; amount: bigint }[],
  keys: DrawKeys,
  fee: bigint,
  destination: `0x${string}`,
  blob: `0x${string}` | undefined,
  feePay: { stealthAddress: `0x${string}`; calldataBlob: `0x${string}` } | null,
  token?: `0x${string}`,
  // Reports (chunksDone, totalChunks) as each UserOp lands → the UI draws a
  // determinate "Sending i/N" bar (a draw fans out one sponsored UserOp per source).
  onProgress?: (done: number, total: number) => void,
): Promise<SmartSendResult> => {
  // Guard: the fee must never eat the whole send (that's "Amount too small",
  // which the Review blocks). Belt-and-suspenders so execution can't send free.
  if (feePay && fee >= plan.reduce((s, c) => s + c.amount, 0n)) {
    return { success: false, sentAmount: 0n, txHashes: [], error: "Amount too small to cover the network fee." };
  }

  console.log(`[executeDraw] ${plan.length} chunk(s) → ${destination} | fee ${feePay ? fee : 0n}${token ? ` (token ${token})` : ""}`);
  onProgress?.(0, plan.length);

  let feeRemaining = feePay ? fee : 0n;
  let recipBlobSent = false;
  let feeBlobSent = false;
  const txHashes: string[] = [];
  let sent = 0n;

  for (const { source, amount } of plan) {
    const toFee = feeRemaining < amount ? feeRemaining : amount;
    feeRemaining -= toFee;
    const toRecip = amount - toFee;

    const recipBlob = !recipBlobSent && toRecip > 0n ? blob : undefined;
    const feeBlob = !feeBlobSent && toFee > 0n && feePay ? feePay.calldataBlob : undefined;

    const calls = buildChunkCalls(token, destination, recipBlob, feePay?.stealthAddress, feeBlob, toRecip, toFee);

    try {
      const pack =
        source.type === "main"
          ? wallet
          : await deriveStealthPack(source.utxo, keys.spendingPrivateKey, keys.viewingPrivateKey, keys.mlkemDecapsKey);
      const tx = await sendTxsViaSafe(pack, calls);
      if (!tx) throw new Error("Operation returned no transaction hash");
      if (toRecip > 0n) recipBlobSent = true;
      if (toFee > 0n) feeBlobSent = true;
      txHashes.push(tx);
      sent += toRecip;
      onProgress?.(txHashes.length, plan.length);
    } catch (e: unknown) {
      console.error("[executeDraw] Chunk failed:", e);
      return { success: false, sentAmount: sent, txHashes };
    }
  }

  return { success: true, sentAmount: sent, txHashes };
};

export const smartSend = async (
  wallet: SafeWallet,
  recipientAddress: `0x${string}`,
  totalAmount: bigint,
  username: string,
  metaAddress: `0x${string}` | null,
  // A draw prepared at the Review step (SendEth private send). When set, smartSend
  // skips re-derivation/estimation and executes it directly (no extra passkey tap).
  prepared?: PreparedDraw,
  // Forwarded to executeDraw for the "Sending i/N" progress bar (draw path only).
  onProgress?: (done: number, total: number) => void,
): Promise<SmartSendResult> => {
  // One destination for the whole logical send. Reuse the one prepared at the
  // Review (so the breakdown the user saw matches what's sent), else generate now.
  let destination = recipientAddress;
  let blob: `0x${string}` | undefined;
  if (prepared) {
    destination = prepared.destination;
    blob = prepared.blob;
  } else if (metaAddress) {
    const payment = await generateStealthPayment(metaAddress);
    destination = payment.stealthAddress;
    blob = payment.calldataBlob;
  }

  // Cheap path — main Safe alone covers it (skipped when a draw was prepared).
  // Skim the operator fee and collect it as a batched stealth payment to
  // r1do-wallet in the SAME UserOp, for BOTH a public destination (plain
  // transfer) and a private one (stealth payment + blob). Recipient gets
  // `totalAmount − fee`; the user spends `totalAmount`.
  if (!prepared) {
    const mainBalance = BigInt((await wallet.protocolKit.getBalance()).toString());
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
  }

  // Draw path — source the shortfall from native stealth UTXOs. When a Review
  // prepared it, execute it directly (keys, plan and SUMMED-gas fee already in
  // hand). Otherwise derive keys (one passkey tap), plan, and estimate the fee
  // inline — blocking if the total can't cover it (never a free send).
  if (prepared) {
    console.log(`[smartSend] Executing prepared draw: ${prepared.plan.length} chunk(s) → ${destination}`);
    return executeDraw(wallet, prepared.plan, prepared.keys, prepared.fee, destination, blob, prepared.feePay, undefined, onProgress);
  }

  console.log(`[smartSend] Main Safe short of ${totalAmount} — drawing from stealth UTXOs`);

  const cred = await getWalletCredential(username).catch(() => null);
  if (!cred) {
    return { success: false, sentAmount: 0n, txHashes: [], error: "Passkey not found on this device." };
  }
  const prf = await loadFromDevice(cred.rawId);
  if (!prf || prf.length === 0) {
    return { success: false, sentAmount: 0n, txHashes: [], error: "Could not access your passkey. Try again." };
  }
  const keys = await derivePQKeysFromPRF(prf);

  const planned = await planDraw(wallet, username, totalAmount);
  if (!planned) {
    return { success: false, sentAmount: 0n, txHashes: [], error: "Insufficient balance." };
  }
  const { plan } = planned;

  // Operator fee — decided against the WHOLE send with the SUMMED gas of every
  // chunk: fee = max(0.1% × total, Σ gas). If the total can't cover it, block
  // ("Amount too small") rather than send for free.
  const feeRecipient = await getFeeRecipient();
  const feePay = feeRecipient ? await generateStealthPayment(feeRecipient.metaAddress) : null;
  const nAsset = nativeAsset();

  let fee = 0n;
  if (feePay) {
    const q = await quoteDrawFee(wallet, keys, plan, totalAmount, destination, blob, feePay, nAsset);
    if (q.feeTooBig) {
      return { success: false, sentAmount: 0n, txHashes: [], error: "Amount too small to cover the network fee." };
    }
    fee = q.fee;
  }

  console.log(`[smartSend] Plan: ${plan.length} chunk(s) → ${destination} | fee ${fee}`);
  return executeDraw(wallet, plan, keys, fee, destination, blob, feePay, undefined, onProgress);
};

/**
 * Prepare a native draw at the Review step (ONE passkey tap): derive the keys,
 * build the plan, resolve the recipient + r1do stealth payments and estimate the
 * fee off the SUMMED chunk gas. Returns everything the Review needs to show the
 * real breakdown plus a `PreparedDraw` to hand straight to smartSend (no second
 * tap). Keeps all the crypto/auth here so the UI imports none of it. The fee
 * decision is on the TOTAL: `feeTooBig` → the UI blocks "Amount too small".
 */
export type PrepareDrawResult =
  | { ok: true; prepared: PreparedDraw; fee: bigint; coversGas: boolean; feeTooBig: boolean }
  | { ok: false; error: string };

export const prepareDraw = async (
  wallet: SafeWallet,
  recipientAddress: `0x${string}`,
  total: bigint,
  username: string,
  metaAddress: `0x${string}` | null,
  // The ERC20 to send, or undefined for native.
  token?: `0x${string}`,
): Promise<PrepareDrawResult> => {
  const asset = token ? assetByAddress(token) : nativeAsset();
  if (!asset) return { ok: false, error: "Unknown asset." };

  const cred = await getWalletCredential(username).catch(() => null);
  if (!cred) return { ok: false, error: "Passkey not found on this device." };
  const prf = await loadFromDevice(cred.rawId);
  if (!prf || prf.length === 0) return { ok: false, error: "Could not access your passkey. Try again." };
  const keys = await derivePQKeysFromPRF(prf);

  const planned = await planDraw(wallet, username, total, token);
  if (!planned) return { ok: false, error: "Insufficient balance." };
  const { plan } = planned;

  // One destination for the whole send — a fresh stealth address if private.
  let destination = recipientAddress;
  let blob: `0x${string}` | undefined;
  if (metaAddress) {
    const payment = await generateStealthPayment(metaAddress);
    destination = payment.stealthAddress;
    blob = payment.calldataBlob;
  }

  const feeRecipient = await getFeeRecipient();
  const feePay = feeRecipient ? await generateStealthPayment(feeRecipient.metaAddress) : null;

  // No resolvable operator → no fee (fail-open). Otherwise fee = max(0.1%×total,
  // Σ gas) and feeTooBig if the total can't cover it.
  let fee = 0n;
  let coversGas = true;
  let feeTooBig = false;
  if (feePay) {
    const q = await quoteDrawFee(wallet, keys, plan, total, destination, blob, feePay, asset);
    fee = q.fee;
    coversGas = q.coversGas;
    feeTooBig = q.feeTooBig;
  }

  return { ok: true, prepared: { keys, plan, fee, feePay, destination, blob, token }, fee, coversGas, feeTooBig };
};

// ERC20 sibling of smartSend: sends `totalAmount` of `token` to `recipientAddress`
// (or, if `metaAddress` is set, to a fresh stealth address), drawing first from
// the main Safe and then from stealth UTXOs tagged with THIS token (largest
// first). Same plan/blob/single-passkey discipline as smartSend; only the
// primitives differ — balanceOf reads, asset-filtered candidates, token sends.
export const smartSendToken = async (
  wallet: SafeWallet,
  token: `0x${string}`,
  recipientAddress: `0x${string}`,
  totalAmount: bigint,
  username: string,
  metaAddress: `0x${string}` | null,
  // A draw prepared at the Review step. When set, executes it directly (no extra tap).
  prepared?: PreparedDraw,
  // Forwarded to executeDraw for the "Sending i/N" progress bar (draw path only).
  onProgress?: (done: number, total: number) => void,
): Promise<SmartSendResult> => {
  // Destination: reuse the prepared one (matches the Review) else generate now.
  let destination = recipientAddress;
  let blob: `0x${string}` | undefined;
  if (prepared) {
    destination = prepared.destination;
    blob = prepared.blob;
  } else if (metaAddress) {
    const payment = await generateStealthPayment(metaAddress);
    destination = payment.stealthAddress;
    blob = payment.calldataBlob;
  }

  // Cheap path — the main Safe alone covers it (no passkey needed, skipped when a
  // draw was prepared). Skim the operator fee IN the token and collect it as a
  // batched stealth TOKEN payment to r1do-wallet in the SAME UserOp, for BOTH a
  // public destination (plain transfer) and a private one (token transfer to the
  // stealth Safe + blob). Recipient gets `totalAmount − fee`; user spends `totalAmount`.
  if (!prepared) {
    const publicClient = createPublicClient({ chain: activeChain(), transport: sepoliaTransport() });
    const safeAddress = (await wallet.protocolKit.getAddress()) as `0x${string}`;
    const [mainBalance] = await getTokenBalances(publicClient, token, [safeAddress]);
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
              { to: destination, data: blob, value: "0" }, //   + blob delivery (Δ)
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
  }

  // Draw path — source the shortfall from this token's stealth UTXOs. Execute the
  // prepared draw directly (no extra tap), or derive keys + plan + estimate the
  // fee inline (SUMMED gas of every chunk), blocking if the total can't cover it.
  if (prepared) {
    console.log(`[smartSendToken] Executing prepared draw: ${prepared.plan.length} chunk(s) → ${destination}`);
    return executeDraw(wallet, prepared.plan, prepared.keys, prepared.fee, destination, blob, prepared.feePay, token, onProgress);
  }

  console.log(`[smartSendToken] Main ${token} balance short of ${totalAmount} — drawing from stealth UTXOs`);

  const cred = await getWalletCredential(username).catch(() => null);
  if (!cred) {
    return { success: false, sentAmount: 0n, txHashes: [], error: "Passkey not found on this device." };
  }
  const prf = await loadFromDevice(cred.rawId);
  if (!prf || prf.length === 0) {
    return { success: false, sentAmount: 0n, txHashes: [], error: "Could not access your passkey. Try again." };
  }
  const keys = await derivePQKeysFromPRF(prf);

  const planned = await planDraw(wallet, username, totalAmount, token);
  if (!planned) {
    return { success: false, sentAmount: 0n, txHashes: [], error: "Insufficient balance." };
  }
  const { plan } = planned;

  // Operator fee — decided against the WHOLE send with the SUMMED gas of every
  // chunk: fee = max(0.1% × total, Σ gas), carved IN the token off the top. Block
  // ("Amount too small") if the total can't cover it rather than send for free.
  const feeRecipient = await getFeeRecipient();
  const feePay = feeRecipient ? await generateStealthPayment(feeRecipient.metaAddress) : null;
  const asset = assetByAddress(token);

  let fee = 0n;
  if (feePay && asset) {
    const q = await quoteDrawFee(wallet, keys, plan, totalAmount, destination, blob, feePay, asset);
    if (q.feeTooBig) {
      return { success: false, sentAmount: 0n, txHashes: [], error: "Amount too small to cover the network fee." };
    }
    fee = q.fee;
  }

  console.log(`[smartSendToken] Plan: ${plan.length} chunk(s) of ${token} → ${destination} | fee ${fee}`);
  return executeDraw(wallet, plan, keys, fee, destination, blob, feePay, token, onProgress);
};

