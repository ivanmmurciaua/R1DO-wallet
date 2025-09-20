import { LOCAL_WALLET_LIST } from "@/app/constants";
import { LocalStorageData } from "@/types";
import { PasskeyArgType } from "@safe-global/protocol-kit";

export const getAllWallets = (): LocalStorageData[] => {
  const walletList: LocalStorageData[] =
    JSON.parse(localStorage.getItem(LOCAL_WALLET_LIST) || "[]") || [];
  return walletList.filter((wallet) => wallet.fingerprint !== "");
};

export const setLocalData = (
  username: string,
  fingerprint: string,
  passkey: PasskeyArgType,
): void => {
  const existingData =
    JSON.parse(localStorage.getItem(LOCAL_WALLET_LIST) || "[]") || [];
  console.log(existingData);

  const newWallet = {
    username: username,
    fingerprint: fingerprint,
    passkey: {
      rawId: passkey.rawId,
      coordinates: {
        x: passkey.coordinates.x,
        y: passkey.coordinates.y,
      },
    },
  };
  existingData.push(newWallet);
  console.log(existingData);

  localStorage.setItem(LOCAL_WALLET_LIST, JSON.stringify(existingData));
};

export const getLocalData = (username: string): LocalStorageData | null => {
  const walletList: LocalStorageData[] =
    JSON.parse(localStorage.getItem(LOCAL_WALLET_LIST) || "[]") || [];

  const wallet = walletList.find((w) => w.username === username);
  return wallet || null;
};

export const removeLocalData = (username: string): void => {
  const walletList: LocalStorageData[] =
    JSON.parse(localStorage.getItem(LOCAL_WALLET_LIST) || "[]") || [];

  const updatedWalletList = walletList.filter((w) => w.username !== username);
  localStorage.setItem(LOCAL_WALLET_LIST, JSON.stringify(updatedWalletList));
};

export const updateLocalData = (
  username: string,
  newFingerprint: string,
  newPasskey: PasskeyArgType,
): void => {
  const walletList: LocalStorageData[] =
    JSON.parse(localStorage.getItem(LOCAL_WALLET_LIST) || "[]") || [];

  const updatedWalletList = walletList.map((w) => {
    if (w.username === username) {
      return {
        username: username,
        fingerprint: newFingerprint,
        passkey: {
          rawId: newPasskey.rawId,
          coordinates: {
            x: newPasskey.coordinates.x,
            y: newPasskey.coordinates.y,
          },
        },
      };
    }
    return w;
  });

  localStorage.setItem(LOCAL_WALLET_LIST, JSON.stringify(updatedWalletList));
};

export const getDecimals = (): number => {
  const amountConfig = localStorage.getItem("LOCAL_AMOUNT_CONFIG");
  if (!amountConfig) {
    localStorage.setItem("LOCAL_AMOUNT_CONFIG", "15");
    return 15;
  }

  return parseInt(amountConfig);
};
