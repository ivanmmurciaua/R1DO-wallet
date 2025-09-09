import { PasskeyArgType } from "@safe-global/protocol-kit";

export type PasskeyResponseType = {
  fingerprint: string;
  passkey: PasskeyArgType;
};

export type PasskeyOnchainResponseType = {
  rawId: string;
  coordinateX: string;
  coordinateY: string;
  timestamp: number;
};

export type ImportedUserData = {
  [username: string]: {
    fingerprint: string;
    passkey: PasskeyArgType;
  };
};
