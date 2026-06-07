import { PasskeyArgType } from "@safe-global/protocol-kit";
import { Address } from "viem";

export type PasskeyResponseType = {
  fingerprint: string;
  passkey: PasskeyArgType;
  prfOutput?: Uint8Array;
};

export type PasskeyOnchainResponseType = {
  rawId: string;
  coordinateX: string;
  coordinateY: string;
  userAddress: Address;
  safeAddress: Address;
  timestamp: number;
};

export type LocalStorageData = {
  username: string;
  fingerprint: string;
  passkey: PasskeyArgType;
  privacy?: boolean;
};
