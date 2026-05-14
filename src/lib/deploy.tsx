import { REGISTRY_ADDRESS } from "@/app/constants";
import { Safe4337Pack } from "@safe-global/relay-kit";
import { encodeFunctionData } from "viem";
import { log } from "./common";

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
    // 1) Create SafeOperation
    const rawTx = {
      to: destinationAddress,
      data: "0x",
      value: amount,
    };

    const safeOperation = await wallet.createTransaction({
      transactions: [rawTx],
    });

    // 2) Sign SafeOperation
    const signedSafeOperation = await wallet.signSafeOperation(safeOperation);

    if (signedSafeOperation) {
      // 3) Execute signed SafeOperation
      const userOperationHash = await wallet.executeTransaction({
        executable: signedSafeOperation,
      });

      const userOperationReceipt = await waitForUserOpReceipt(
        wallet,
        userOperationHash,
      );

      if (!userOperationReceipt.success) {
        throw new Error("Transaction reverted on-chain");
      }

      return userOperationReceipt.receipt.transactionHash;
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
): Promise<string> => {
  // TRACE -DEBUG
  // console.log("Storing on chain...");
  try {
    const storeTransaction = {
      to: REGISTRY_ADDRESS,
      data: encodeStoreData(fingerprint, rawId, coordinateX, coordinateY),
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

const encodeStoreData = (
  fingerprint: string,
  rawId: string,
  coordinateX: string,
  coordinateY: string,
) => {
  return encodeFunctionData({
    abi: [
      {
        inputs: [
          {
            name: "fingerprint",
            type: "bytes32",
          },
          {
            name: "rawId",
            type: "string",
          },
          {
            name: "coordinateX",
            type: "bytes32",
          },
          {
            name: "coordinateY",
            type: "bytes32",
          },
        ],
        name: "registerPasskey",
        payable: false,
        stateMutability: "nonpayable",
        type: "function",
      },
    ],
    functionName: "registerPasskey",
    args: [fingerprint, rawId, coordinateX, coordinateY],
  });
};
