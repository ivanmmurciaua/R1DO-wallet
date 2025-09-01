import {
  BUNDLER_URL,
  PAYMASTER_ADDRESS,
  PAYMASTER_URL,
  RPC_URL,
} from "@/app/constants";
import { PasskeyArgType } from "@safe-global/protocol-kit";
import { PaymasterOptions, Safe4337Pack } from "@safe-global/relay-kit";
import { createPublicClient, http } from "viem"; //Address, createPublicClient, http } from "viem";
import { sepolia } from "viem/chains";

export const client = createPublicClient({
  chain: sepolia,
  transport: http(),
});

const paymasterOptions = {
  isSponsored: true,
  paymasterAddress: PAYMASTER_ADDRESS,
  paymasterUrl: PAYMASTER_URL,
} as PaymasterOptions;

export const safeClient = async (
  owner: PasskeyArgType,
): Promise<Safe4337Pack> => {
  const safe4337Pack = await Safe4337Pack.init({
    provider: RPC_URL,
    signer: owner,
    bundlerUrl: BUNDLER_URL,
    paymasterOptions,
    options: {
      owners: [],
      threshold: 1,
    },
  });

  return safe4337Pack;
};

// // TODO: Test it to load an existing wallet.
// const existingSafeClient = async (
//   passkey: PasskeyArgType,
//   address: Address,
// ): Promise<Safe4337Pack> => {
//   const safe4337Pack = await Safe4337Pack.init({
//     provider: RPC_URL,
//     signer: passkey,
//     bundlerUrl: BUNDLER_URL,
//     paymasterOptions,
//     options: {
//       safeAddress: address,
//     },
//   });

//   return safe4337Pack;
// };
