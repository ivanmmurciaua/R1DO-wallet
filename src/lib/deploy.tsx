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
import { activeChain } from "@/lib/networks";
import { getStealthBalances, getTokenBalances } from "@/lib/balances";
import { log } from "./common";
import { getStealthUTXOs } from "./localstorage";
import { getWalletCredential } from "./credstore";
import { loadFromDevice } from "./passkeys";
import {
  derivePQKeysFromPRF,
  deriveStealthSpendingKey,
  deriveStealthH,
  generateStealthPayment,
  type StealthUTXO,
} from "./stealth";

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
    const transactions = calldataBlob
      ? [
          { to: utxo.asset, data: transferData, value: "0" },
          { to: recipient, data: calldataBlob, value: "0" },
        ]
      : [{ to: utxo.asset, data: transferData, value: "0" }];
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

  if (!calldataBlob) {
    return await makeTx(stealthPack, recipient, amount);
  }

  // Private chained spend: the transfer itself carries the blob (Δ1)
  try {
    const sendTx = { to: recipient, data: calldataBlob, value: amount };

    const safeOperation = await stealthPack.createTransaction({ transactions: [sendTx] });
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
  const utxos = getStealthUTXOs(username);
  if (utxos.length === 0) return [];
  const publicClient = createPublicClient({ chain: activeChain(), transport: sepoliaTransport() });
  const balances = await getStealthBalances(publicClient, utxos.map((u) => u.stealthAddress));
  const coins = utxos.map((utxo, i) => ({ utxo, balance: balances[i] }));
  return coins.filter((c) => c.balance > 0n).sort((a, b) => (a.balance < b.balance ? 1 : -1));
};

// Total shieldable balance held across the user's stealth UTXOs (the source
// "coin" total for the privacy-by-default deposit).
export const getStealthTotal = async (username: string): Promise<bigint> => {
  const utxos = getStealthUTXOs(username);
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
  shieldTx: { to: string; data: string; value: string },
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
  return sendTxViaSafe(stealthPack, shieldTx);
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
  buildShieldTx: (amount: bigint) => Promise<{ to: string; data: string; value: string }>,
): Promise<SmartShieldResult> => {
  const cred = await getWalletCredential(username).catch(() => null);
  if (!cred) return { success: false, shieldedAmount: 0n, txHashes: [], error: "Passkey not found on this device." };
  const prf = await loadFromDevice(cred.rawId);
  if (!prf || prf.length === 0) {
    return { success: false, shieldedAmount: 0n, txHashes: [], error: "Could not access your passkey. Try again." };
  }
  const keys = await derivePQKeysFromPRF(prf);

  const utxos = getStealthUTXOs(username);
  const publicClient = createPublicClient({ chain: activeChain(), transport: sepoliaTransport() });
  const shieldBalances = await getStealthBalances(publicClient, utxos.map((u) => u.stealthAddress));
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
      const shieldTx = await buildShieldTx(take);
      const tx = await shieldStealthUTXO(utxo, keys, shieldTx);
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
  buildShieldTx: (amount: bigint) => Promise<{ to: string; data: string; value: string }>,
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
      const balance = await publicClient.getBalance({ address: utxo.stealthAddress });
      if (balance === 0n) continue;
      const shieldTx = await buildShieldTx(balance); // whole coin
      const tx = await shieldStealthUTXO(utxo, keys, shieldTx);
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

  // Cheap path — main Safe alone covers it, exactly like before
  if (mainBalance >= totalAmount) {
    const tx = blob
      ? await sendStealth(wallet, destination, totalAmount.toString(), blob)
      : await makeTx(wallet, destination, totalAmount.toString());
    return tx
      ? { success: true, sentAmount: totalAmount, txHashes: [tx] }
      : { success: false, sentAmount: 0n, txHashes: [], error: "Send failed." };
  }

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

  const utxos = getStealthUTXOs(username);
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

  const txHashes: string[] = [];
  let sent = 0n;
  for (let i = 0; i < plan.length; i++) {
    const { source, amount } = plan[i];
    // The blob only needs to ride on one chunk — the scanner finds the UTXO
    // from it and the remaining chunks land on the same stealth address.
    const chunkBlob = i === 0 ? blob : undefined;
    try {
      const tx =
        source.type === "main"
          ? chunkBlob
            ? await sendStealth(wallet, destination, amount.toString(), chunkBlob)
            : await makeTx(wallet, destination, amount.toString())
          : await spendStealthUTXO(
              source.utxo,
              amount.toString(),
              destination,
              keys.spendingPrivateKey,
              keys.viewingPrivateKey,
              keys.mlkemDecapsKey,
              chunkBlob,
            );

      if (!tx) throw new Error("Operation returned no transaction hash");
      txHashes.push(tx);
      sent += amount;
    } catch (e: unknown) {
      console.error("[smartSend] Chunk failed:", e);
      return { success: false, sentAmount: sent, txHashes };
    }
  }

  return { success: true, sentAmount: sent, txHashes };
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

  // Cheap path — the main Safe alone covers it (no passkey needed).
  if (mainBalance >= totalAmount) {
    const tx = blob
      ? await sendStealthToken(wallet, destination, token, totalAmount, blob)
      : await sendToken(wallet, token, destination, totalAmount);
    return tx
      ? { success: true, sentAmount: totalAmount, txHashes: [tx] }
      : { success: false, sentAmount: 0n, txHashes: [], error: "Send failed." };
  }

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
  const tokenUtxos = getStealthUTXOs(username).filter((u) => u.asset?.toLowerCase() === token.toLowerCase());
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

  const txHashes: string[] = [];
  let sent = 0n;
  for (let i = 0; i < plan.length; i++) {
    const { source, amount } = plan[i];
    // The blob rides only on the first chunk — the scanner finds the UTXO from
    // it and the remaining chunks land on the same stealth address.
    const chunkBlob = i === 0 ? blob : undefined;
    try {
      const tx =
        source.type === "main"
          ? chunkBlob
            ? await sendStealthToken(wallet, destination, token, amount, chunkBlob)
            : await sendToken(wallet, token, destination, amount)
          : await spendStealthUTXO(
              source.utxo,
              amount.toString(),
              destination,
              keys.spendingPrivateKey,
              keys.viewingPrivateKey,
              keys.mlkemDecapsKey,
              chunkBlob,
            );

      if (!tx) throw new Error("Operation returned no transaction hash");
      txHashes.push(tx);
      sent += amount;
    } catch (e: unknown) {
      console.error("[smartSendToken] Chunk failed:", e);
      return { success: false, sentAmount: sent, txHashes };
    }
  }

  return { success: true, sentAmount: sent, txHashes };
};

