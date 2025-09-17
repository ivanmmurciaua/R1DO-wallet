import { PasskeyArgType } from "@safe-global/protocol-kit";
import { Address } from "viem";

export type PasskeyResponseType = {
  fingerprint: string;
  passkey: PasskeyArgType;
};

export type PasskeyOnchainResponseType = {
  rawId: string;
  coordinateX: string;
  coordinateY: string;
  userAddress: Address;
  timestamp: number;
};

export type LocalStorageData = {
  username: string;
  fingerprint: string;
  passkey: PasskeyArgType;
};
