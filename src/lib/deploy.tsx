import { REGISTRY_ADDRESS } from "@/app/constants";
import { Safe4337Pack } from "@safe-global/relay-kit";
import { encodeFunctionData, zeroAddress } from "viem";
import { log } from "./common";

/**
 * Send 0 to Zero Address.
 * @param {Safe4337Pack} wallet - Wallet built by Safe client.
 * @returns {Promise<void>}
 * @throws {Error} If the operation fails.
 */
export const makeTx = async (wallet: Safe4337Pack): Promise<string> => {
  // // TRACE -DEBUG
  // console.log("Making test tx...");

  try {
    // 1) Create SafeOperation
    const rawTx = {
      to: zeroAddress,
      data: "0x0000000000000000000000000000000000000000000000000000000000000000",
      value: "0",
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

      console.log(userOperationHash);
      return userOperationHash;
    }
  } catch (e: unknown) {
    console.error(e);
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
