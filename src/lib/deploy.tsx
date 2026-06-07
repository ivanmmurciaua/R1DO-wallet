import {
  REGISTRY_ADDRESS,
  RPC_URL,
  BUNDLER_URL,
  PAYMASTER_URL,
  ENTRYPOINT_ADDRESS,
  SAFE_MODULES_ADDRESS,
  SAFE_MODULES_VERSION,
  SAFE_SW_VERSION,
} from "@/app/constants";
import { Safe4337Pack } from "@safe-global/relay-kit";
import { encodeFunctionData, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { sepolia } from "viem/chains";
import { log } from "./common";
import { getStealthUTXOs, getLocalData } from "./localstorage";
import { loadFromDevice } from "./passkeys";
import {
  STEALTH_REGISTRY_ADDRESS,
  STEALTH_REGISTRY_ABI,
  STEALTH_SCHEME_ID,
  ANNOUNCER_ADDRESS,
  ANNOUNCER_ABI,
  derivePQKeysFromPRF,
  deriveStealthSpendingKey,
  deriveStealthH,
  generateStealthPayment,
  type StealthUTXO,
} from "./stealth";

type StealthAnnouncement = { ephemeralPubkey: `0x${string}`; metadata: `0x${string}` };

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
 * Store passkey on chain.
 * @param {Safe4337Pack} wallet - Wallet built by Safe client.
 * @returns {Promise<string>} tx - The transaction id.
 * @throws {Error} If the operation fails.
 */
export const registerPasskey = async (
  wallet: Safe4337Pack,
  fingerprint: string,
  rawId: string,
  coordinateX: string,
  coordinateY: string,
  safeAddress: string,
): Promise<string> => {
  // TRACE -DEBUG
  // console.log("Storing on chain...");
  try {
    const storeTransaction = {
      to: REGISTRY_ADDRESS,
      data: encodeStoreData(fingerprint, rawId, coordinateX, coordinateY, safeAddress),
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
        throw new Error("Passkey registration transaction reverted");
      }

      return userOperationHash;
    }
  } catch (e: unknown) {
    console.error(e);
    await log("registerPasskey", e);
    throw new Error("Error storing passkey");
  }
  return "";
};

// Batch: send ETH to stealth address + announce on ERC-5564 in a single UserOp
export const sendStealth = async (
  wallet: Safe4337Pack,
  stealthAddress: `0x${string}`,
  amount: string,
  ephemeralPubkey: `0x${string}`,
  metadata: `0x${string}`,
): Promise<string> => {
  try {
    console.log(`[sendStealth] to: ${stealthAddress} | amount: ${amount}`);

    const sendTx = { to: stealthAddress, data: "0x" as `0x${string}`, value: amount };

    const announceTx = {
      to: ANNOUNCER_ADDRESS,
      data: encodeFunctionData({
        abi: ANNOUNCER_ABI,
        functionName: "announce",
        args: [STEALTH_SCHEME_ID, stealthAddress, ephemeralPubkey, metadata],
      }),
      value: "0",
    };

    const safeOperation = await wallet.createTransaction({ transactions: [sendTx, announceTx] });
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

export const registerStealthKeys = async (
  wallet: Safe4337Pack,
  prfOutput: Uint8Array,
): Promise<string> => {
  try {
    const { pqMetaAddress } = await derivePQKeysFromPRF(prfOutput);

    const stealthTx = {
      to: STEALTH_REGISTRY_ADDRESS,
      data: encodeFunctionData({
        abi: STEALTH_REGISTRY_ABI,
        functionName: "registerKeys",
        args: [STEALTH_SCHEME_ID, pqMetaAddress],
      }),
      value: "0",
    };

    const safeOperation = await wallet.createTransaction({ transactions: [stealthTx] });
    const signedOp = await wallet.signSafeOperation(safeOperation);

    if (signedOp) {
      const userOpHash = await wallet.executeTransaction({ executable: signedOp });
      const receipt = await waitForUserOpReceipt(wallet, userOpHash);

      if (!receipt.success) throw new Error("Stealth registration reverted");

      return userOpHash;
    }
  } catch (e: unknown) {
    await log("registerStealthKeys", e);
    throw e;
  }
  return "";
};

// Spends a stealth UTXO: re-derives its owner key, instantiates the predicted
// Safe (deploying it on first spend if needed) and sends a sponsored UserOp.
// No native ETH required in the stealth address — the paymaster covers gas.
export const spendStealthUTXO = async (
  utxo:               StealthUTXO,
  amount:             string,
  recipient:          `0x${string}`,
  spendingPrivateKey: `0x${string}`,
  viewingPrivateKey:  `0x${string}`,
  mlkemDecapsKey:     Uint8Array,
  announce?:          StealthAnnouncement,
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

  if (!announce) {
    return await makeTx(stealthPack, recipient, amount);
  }

  // Bundle transfer + ERC-5564 announce in one UserOp, mirroring sendStealth
  try {
    const sendTx = { to: recipient, data: "0x" as `0x${string}`, value: amount };
    const announceTx = {
      to: ANNOUNCER_ADDRESS,
      data: encodeFunctionData({
        abi: ANNOUNCER_ABI,
        functionName: "announce",
        args: [STEALTH_SCHEME_ID, recipient, announce.ephemeralPubkey, announce.metadata],
      }),
      value: "0",
    };

    const safeOperation = await stealthPack.createTransaction({ transactions: [sendTx, announceTx] });
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
  let announce: StealthAnnouncement | undefined;
  if (metaAddress) {
    const payment = await generateStealthPayment(metaAddress);
    destination = payment.stealthAddress;
    announce = { ephemeralPubkey: payment.ephemeralPubkey, metadata: payment.metadata };
  }

  // Cheap path — main Safe alone covers it, exactly like before
  if (mainBalance >= totalAmount) {
    const tx = announce
      ? await sendStealth(wallet, destination, totalAmount.toString(), announce.ephemeralPubkey, announce.metadata)
      : await makeTx(wallet, destination, totalAmount.toString());
    return tx
      ? { success: true, sentAmount: totalAmount, txHashes: [tx] }
      : { success: false, sentAmount: 0n, txHashes: [], error: "Send failed." };
  }

  console.log(`[smartSend] Main balance (${mainBalance}) short of ${totalAmount} — drawing from stealth UTXOs`);

  const data = getLocalData(username);
  if (!data?.passkey?.rawId) {
    return { success: false, sentAmount: 0n, txHashes: [], error: "Passkey not found on this device." };
  }
  const prf = await loadFromDevice(data.passkey.rawId);
  if (!prf || prf.length === 0) {
    return { success: false, sentAmount: 0n, txHashes: [], error: "Could not access your passkey. Try again." };
  }
  const keys = await derivePQKeysFromPRF(prf);

  const utxos = getStealthUTXOs(username);
  const publicClient = createPublicClient({ chain: sepolia, transport: http(RPC_URL) });
  const candidates = (
    await Promise.all(
      utxos.map(async (utxo) => ({ utxo, balance: await publicClient.getBalance({ address: utxo.stealthAddress }) })),
    )
  )
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
    const chunkAnnounce = i === 0 ? announce : undefined;
    try {
      const tx =
        source.type === "main"
          ? chunkAnnounce
            ? await sendStealth(wallet, destination, amount.toString(), chunkAnnounce.ephemeralPubkey, chunkAnnounce.metadata)
            : await makeTx(wallet, destination, amount.toString())
          : await spendStealthUTXO(
              source.utxo,
              amount.toString(),
              destination,
              keys.spendingPrivateKey,
              keys.viewingPrivateKey,
              keys.mlkemDecapsKey,
              chunkAnnounce,
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

const encodeStoreData = (
  fingerprint: string,
  rawId: string,
  coordinateX: string,
  coordinateY: string,
  safeAddress: string,
) => {
  return encodeFunctionData({
    abi: [
      {
        inputs: [
          { name: "fingerprint",  type: "bytes32" },
          { name: "rawId",        type: "string"  },
          { name: "coordinateX",  type: "bytes32" },
          { name: "coordinateY",  type: "bytes32" },
          { name: "safeAddress",  type: "address" },
        ],
        name: "registerPasskey",
        payable: false,
        stateMutability: "nonpayable",
        type: "function",
      },
    ],
    functionName: "registerPasskey",
    args: [fingerprint, rawId, coordinateX, coordinateY, safeAddress as `0x${string}`],
  });
};
