import { LOCAL_WALLET_LIST } from "@/app/constants";
import { LocalStorageData } from "@/types";
import { PasskeyArgType } from "@safe-global/protocol-kit";
import { PACKED_VERIFIERS_HEX } from "@/app/constants";
import type { StealthUTXO } from "@/lib/stealth";

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

  const newWallet = {
    username: username,
    fingerprint: fingerprint,
    passkey: {
      rawId: passkey.rawId,
      coordinates: {
        x: passkey.coordinates.x,
        y: passkey.coordinates.y,
      },
      verifierAddress: passkey.verifierAddress,
    },
  };
  existingData.push(newWallet);
  localStorage.setItem(LOCAL_WALLET_LIST, JSON.stringify(existingData));
};

export const getLocalData = (username: string): LocalStorageData | null => {
  const walletList: LocalStorageData[] =
    JSON.parse(localStorage.getItem(LOCAL_WALLET_LIST) || "[]") || [];

  const wallet = walletList.find((w) => w.username === username);
  if (!wallet) return null;

  // Migration: add verifierAddress for entries saved before protocol-kit v7
  if (!wallet.passkey.verifierAddress) {
    wallet.passkey.verifierAddress = PACKED_VERIFIERS_HEX;
  }

  return wallet;
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
  privacy?: boolean,
): void => {
  const walletList: LocalStorageData[] =
    JSON.parse(localStorage.getItem(LOCAL_WALLET_LIST) || "[]") || [];

  const existing = walletList.find((w) => w.username === username);
  const entry: LocalStorageData = {
    username,
    fingerprint: newFingerprint,
    passkey: {
      rawId: newPasskey.rawId,
      coordinates: {
        x: newPasskey.coordinates.x,
        y: newPasskey.coordinates.y,
      },
      verifierAddress: newPasskey.verifierAddress,
    },
    privacy: privacy ?? existing?.privacy ?? false,
  };

  const exists = walletList.some((w) => w.username === username);
  const updatedWalletList = exists
    ? walletList.map((w) => (w.username === username ? entry : w))
    : [...walletList, entry];

  localStorage.setItem(LOCAL_WALLET_LIST, JSON.stringify(updatedWalletList));
};

const STEALTH_UTXOS_PREFIX   = "STEALTH_UTXOS";
const STEALTH_BLOCK_PREFIX   = "STEALTH_LAST_BLOCK";

export const getStealthUTXOs = (username: string): StealthUTXO[] => {
  const raw = localStorage.getItem(`${STEALTH_UTXOS_PREFIX}_${username}`);
  return raw ? JSON.parse(raw) : [];
};

export const saveStealthScan = (
  username: string,
  utxos: StealthUTXO[],
  lastBlock: bigint,
): void => {
  localStorage.setItem(`${STEALTH_UTXOS_PREFIX}_${username}`, JSON.stringify(utxos));
  localStorage.setItem(`${STEALTH_BLOCK_PREFIX}_${username}`, lastBlock.toString());
};

export const getLastScannedBlock = (username: string): bigint | null => {
  const val = localStorage.getItem(`${STEALTH_BLOCK_PREFIX}_${username}`);
  return val ? BigInt(val) : null;
};

const LOCAL_AMOUNT_CONFIG = "LOCAL_AMOUNT_CONFIG";
const LOCAL_SYMBOL_CONFIG = "LOCAL_SYMBOL_CONFIG";

export const DEFAULT_DECIMALS = 15;
export const DEFAULT_SYMBOL = "⧫";

export const getDecimals = (): number => {
  const amountConfig = localStorage.getItem(LOCAL_AMOUNT_CONFIG);
  if (!amountConfig) {
    localStorage.setItem(LOCAL_AMOUNT_CONFIG, DEFAULT_DECIMALS.toString());
    return DEFAULT_DECIMALS;
  }

  return parseInt(amountConfig);
};

export const setDecimalsConfig = (decimals: number): void => {
  localStorage.setItem(LOCAL_AMOUNT_CONFIG, decimals.toString());
};

export const getSymbol = (): string => {
  return localStorage.getItem(LOCAL_SYMBOL_CONFIG) || DEFAULT_SYMBOL;
};

export const setSymbolConfig = (symbol: string): void => {
  localStorage.setItem(LOCAL_SYMBOL_CONFIG, symbol);
};

const LOCAL_THEME_MODE = "LOCAL_THEME_MODE";

export const getThemeMode = (): "light" | "dark" => {
  return localStorage.getItem(LOCAL_THEME_MODE) === "dark" ? "dark" : "light";
};

export const setThemeMode = (mode: "light" | "dark"): void => {
  localStorage.setItem(LOCAL_THEME_MODE, mode);
};
