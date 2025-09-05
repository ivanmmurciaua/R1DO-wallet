import {
  BUNDLER_URL,
  ENTRYPOINT_ADDRESS,
  PAYMASTER_ADDRESS,
  PAYMASTER_URL,
  RPC_URL,
  SAFE_MODULES_ADDRESS,
  SAFE_MODULES_VERSION,
  SAFE_SW_VERSION,
} from "@/app/constants";
import { PasskeyArgType } from "@safe-global/protocol-kit";
import { PaymasterOptions, Safe4337Pack } from "@safe-global/relay-kit";
import { createPublicClient, http } from "viem"; //Address, createPublicClient, http } from "viem";
import { arbitrumSepolia } from "viem/chains";

export const client = createPublicClient({
  chain: arbitrumSepolia,
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
    safeModulesVersion: SAFE_MODULES_VERSION,
    customContracts: {
      entryPointAddress: ENTRYPOINT_ADDRESS,
      safe4337ModuleAddress: SAFE_MODULES_ADDRESS,
    },
    paymasterOptions,
    options: {
      safeVersion: SAFE_SW_VERSION,
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
