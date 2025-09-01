import { REGISTRY_ADDRESS } from "@/app/constants";
import { Safe4337Pack } from "@safe-global/relay-kit";
import { encodeFunctionData, zeroAddress } from "viem";

/**
 * Send 0 to Zero Address.
 * @param {Safe4337Pack} wallet - Wallet built by Safe client.
 * @returns {Promise<void>}
 * @throws {Error} If the operation fails.
 */
export const makeTx = async (wallet: Safe4337Pack): Promise<string> => {
  // // TRACE -DEBUG
  // console.log("Making test tx...");

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
  // // TRACE - DEBUG
  // console.log("SafeOperation", signedSafeOperation);

  // 3) Execute SafeOperation
  const userOperationHash = await wallet.executeTransaction({
    executable: signedSafeOperation,
  });

  return userOperationHash;
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
  console.log("Storing on chain...");

  // 1) Create SafeOperation
  const storeTransaction = {
    to: REGISTRY_ADDRESS,
    data: encodeStoreData(fingerprint, rawId, coordinateX, coordinateY),
    value: "0",
  };

  const safeOperation = await wallet.createTransaction({
    transactions: [storeTransaction],
  });

  // 2) Sign SafeOperation
  const signedSafeOperation = await wallet.signSafeOperation(safeOperation);

  // TRACE - DEBUG
  console.log("SafeOperation", signedSafeOperation);

  // 3) Execute SafeOperation
  const userOperationHash = await wallet.executeTransaction({
    executable: signedSafeOperation,
  });

  return userOperationHash;
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
