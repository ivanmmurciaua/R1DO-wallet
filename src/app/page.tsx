"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import {
  createPasskey,
  // generateAuthKey
  generateFingerprint,
  loadFromDevice,
  readFromSC,
} from "@/lib/passkeys";
import { PasskeyArgType } from "@safe-global/protocol-kit";
import LoginWithPasskey from "@/components/LoginWithPasskey";
import styles from "./page.module.css";
import Image from "next/image";
import { safeClient } from "@/lib/client";
import { registerPasskey } from "@/lib/deploy";
import { Address } from "viem";
import { Safe4337Pack } from "@safe-global/relay-kit";
import { PasskeyOnchainResponseType, PasskeyResponseType } from "@/types";
import AccountDetails from "@/components/AccountDetails";
import { log } from "@/lib/common";
import {
  getLocalData,
  removeLocalData,
  setLocalData,
  updateLocalData,
} from "@/lib/localstorage";
import Popup from "@/components/Popup";

export default function Home() {
  const [deployed, setDeployed] = useState(false);
  const [address, setAddress] = useState<Address | null>(null);
  const [userWallet, setWallet] = useState<Safe4337Pack | null>(null);
  const [showPopup, setShowPopup] = useState(false);
  const [popupMessage, setPopupMessage] = useState("");
  // const [recovery, setRecovery] = useState(false);

  // PWA install prompt state
  const [showInstall, setShowInstall] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deferredPrompt = useRef<any>(null);

  const openInstallOption = () => {
    setShowInstall(true);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        setShowInstall(false);
        resolve();
      }, 10000);
    });
  };

  const openPopup = useCallback(
    (message: string) => {
      if (!showPopup) {
        setShowPopup(true);
      }
      setPopupMessage(message);
    },
    [showPopup],
  );

  const closePopup = () => {
    setShowPopup(false);
    setPopupMessage("");
  };

  const handleInstallClick = async () => {
    if (deferredPrompt.current) {
      deferredPrompt.current.prompt();
      await deferredPrompt.current.userChoice;
      deferredPrompt.current = null;
      setShowInstall(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const handler = (e: any) => {
      e.preventDefault();
      deferredPrompt.current = e;
      openInstallOption();
    };
    window.addEventListener("beforeinstallprompt", handler);

    return () => {
      window.removeEventListener("beforeinstallprompt", handler);
    };
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined" && !window.PublicKeyCredential) {
      openPopup("Credentials not supported on this device or browser");
    }
  }, [openPopup]);

  async function handleStore(
    username: string,
    fingerprint: string,
    passkey: PasskeyArgType,
    wallet: Safe4337Pack,
  ) {
    if (!fingerprint || !passkey || !wallet) {
      throw new Error("Missing data");
    }

    try {
      // CHECK: TEST MSG.SENDER
      const tx = await registerPasskey(
        wallet,
        fingerprint,
        passkey.rawId,
        passkey.coordinates.x,
        passkey.coordinates.y,
      );

      if (tx) {
        updateLocalData(username, fingerprint, passkey);
        setDeployed(true);
        closePopup();
      }
    } catch (e: unknown) {
      await log("handleStore", e);
      openPopup(
        "Something went wrong with your credential manager. Your wallet is not created",
      );
    }
  }

  async function handleWalletInit(
    passkey: PasskeyArgType,
  ): Promise<Safe4337Pack> {
    openPopup(`Loading your wallet`);
    const wallet = await safeClient(passkey);
    setWallet(wallet);

    const safeAddress: Address =
      (await wallet.protocolKit.getAddress()) as Address;
    setAddress(safeAddress);
    // console.log(safeAddress);

    const isSafeDeployed = await wallet.protocolKit.isSafeDeployed();
    setDeployed(isSafeDeployed);

    return wallet;
  }

  async function formatPasskey(fingerprint: string): Promise<PasskeyArgType> {
    const onchainPasskey = (await readFromSC(
      "getPasskey",
      fingerprint,
    )) as PasskeyOnchainResponseType;

    const passkey = {
      rawId: onchainPasskey.rawId,
      coordinates: {
        x: onchainPasskey.coordinateX,
        y: onchainPasskey.coordinateY,
      },
    } as PasskeyArgType;

    return passkey;
  }

  async function createOrLoad(username: string, external: boolean) {
    // TRACE - DEBUG
    // console.log("External provider", external);
    let passkey;

    const wallet = getLocalData(username);
    const fingerprint = wallet?.fingerprint || "";
    passkey = wallet?.passkey || {};

    if (fingerprint === "") {
      // TRACE - DEBUG
      // console.log("No fingerprint detected");

      if (Object.keys(passkey).length !== 0) {
        // Created but not deployed
        // Check locally and tell user forget it.
        if (await loadFromDevice(passkey.rawId!)) {
          // in device but exists onchain?
          await managePasskey(username, external, passkey as PasskeyArgType);
        } else {
          const e =
            "Your wallet is not created. Please remove your passkey from this device";
          openPopup(e);
          removeLocalData(username);

          await log("createOrLoad - 5,6,7", e);
          throw Error(e);
        }
      } else {
        await managePasskey(username, external);
      }
    } else {
      // TRACE - DEBUG
      // console.log("Fingerprint detected");
      openPopup(`Looking for your wallet`);
      if (!(await readFromSC("isRegistered", fingerprint)) as boolean) {
        // Finded fingerprint, not exists onchain but I can import passkey if I'm the owner of it and exists in my device.
        if (passkey) {
          if (await loadFromDevice(passkey.rawId!)) {
            // Store it onchain
            const wallet = await handleWalletInit(passkey as PasskeyArgType);
            await handleStore(
              username,
              fingerprint,
              passkey as PasskeyArgType,
              wallet,
            );
          } else {
            // localStorage.removeItem(username);
            openPopup("Something went wrong. Please try again later");
            const e = "Is registered onchain and is in LS, but not in device";
            await log("loading wallet from LS.", e);
            throw new Error(e);
          }
        } else {
          // 1010
          // Import message?
          openPopup("Something goes wrong. Please try again later");
          const e =
            "Is registered onchain and exists fingerprint but NO passkey in LS.";
          await log("loading wallet from LS.", e);
          throw new Error(e);
        }
      } else {
        passkey = await formatPasskey(fingerprint);
        // TRACE - DEBUG
        // console.log("Retrieved passkey from onchain: ", passkey);
        if (await loadFromDevice(passkey.rawId)) {
          // TRACE - DEBUG
          // console.log("Everything OK");
          updateLocalData(username, fingerprint, passkey);
          await handleWalletInit(passkey);
          closePopup();
        } else {
          // localStorage.removeItem(username);
          openPopup("Passkey could not be loaded in your device.");
          removeLocalData(username);

          const e = "Onchain exists, storage exists but not in your device";
          await log("loading wallet from device", e);
          throw new Error("Not exists in device");
        }
      }
    }
  }

  async function existsOnchain(
    username: string,
    existsPasskey: boolean = false,
  ) {
    openPopup(`Looking for your wallet`);
    let overwrite = false;
    let exists = false;

    const fingerprint = generateFingerprint(username);

    try {
      if ((await readFromSC("isRegistered", fingerprint)) as boolean) {
        const passkey = await formatPasskey(fingerprint);

        if (existsPasskey) {
          exists = true;
        } else {
          //TODO
          // VERY IMPORTANT. ASK USER BEFORE CONTINUE BECAUSE WILL OVERWRITE ONCHAIN REGISTRY.
          // The user has changed device or deleted passkey from the device.
          // And I don't know if is worth to store again in SC overwriting the existing.
          exists = true;
          overwrite = true;
          if (await loadFromDevice(passkey.rawId)) {
            setLocalData(username, fingerprint, passkey);
            await handleWalletInit(passkey);
            closePopup();
          } else {
            openPopup("Your wallet could not be loaded");
            const e = "Exists onchain but NOT exists in device";
            // Rotate keys mechanism
            await log("existsOnchain - 2", e);
            throw new Error(e);
          }
        }
      } // else NOT exists onchain
    } catch (e: unknown) {
      await log("existsOnchain", e);
      console.error(e);
    }

    return {
      exists: exists,
      overwrite: overwrite,
    };
  }

  async function managePasskey(
    username: string,
    external: boolean,
    passkey: PasskeyArgType | null = null,
  ) {
    let exists, overwrite: boolean;

    if (passkey) {
      ({ exists, overwrite } = await existsOnchain(username, true));
    } else {
      ({ exists, overwrite } = await existsOnchain(username));
    }

    try {
      if (exists) {
        if (!overwrite) {
          // Retrieve data and load wallet.
          const { passkey } = getLocalData(username)!;
          await handleWalletInit(passkey);
          closePopup();
        } else {
        }
      } else {
        if (passkey) {
          // console.log("Not deployed");
          const fingerprint = generateFingerprint(username);
          const wallet = await handleWalletInit(passkey);
          await handleStore(username, fingerprint, passkey, wallet);
        } else {
          // New user, if not exists onchain, could exists locally ????
          openPopup("Creating new passkey");
          const { fingerprint, passkey } = await handleCreatePasskey(
            username,
            external,
          );

          if (passkey.rawId !== "") {
            const wallet = await handleWalletInit(passkey);
            //TODO: Check this
            // updateLocalData(username, fingerprint, passkey);
            await handleStore(username, fingerprint!, passkey, wallet);
          } else {
            openPopup(
              "Your wallet could not be created. Try again or change browser/device",
            );
          }
        }
      }
    } catch (e: unknown) {
      await log("managePasskey", e);
      console.error(e);
    }
  }

  async function handleCreatePasskey(
    username: string,
    external: boolean,
  ): Promise<PasskeyResponseType> {
    const response = await createPasskey(username, external);
    return response;
  }

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        {/* Custom PWA Install Button */}
        {showInstall && (
          <div
            style={{
              position: "fixed",
              bottom: 24,
              left: 0,
              right: 0,
              display: "flex",
              justifyContent: "center",
              zIndex: 1000,
            }}
          >
            <button
              style={{
                background: "#1a1a1a",
                color: "#fff",
                border: "none",
                borderRadius: 8,
                padding: "12px 24px",
                fontSize: "1rem",
                boxShadow: "0 2px 8px rgba(0,0,0,0.15)",
                cursor: "pointer",
              }}
              onClick={handleInstallClick}
            >
              Install R1DO Wallet
            </button>
          </div>
        )}

        {!showPopup && userWallet && address && deployed ? (
          <AccountDetails wallet={userWallet} address={address} />
        ) : (
          <LoginWithPasskey createOrLoad={createOrLoad} />
        )}
        {showPopup && popupMessage && <Popup popupMessage={popupMessage} />}
      </main>

      <footer className={styles.footer}>
        <a
          href="https://ethereum.org"
          target="_blank"
          rel="noopener noreferrer"
        >
          <Image
            aria-hidden
            src="/ethereum-badge.svg"
            alt="Powered by Ethereum"
            width={77}
            height={33}
          />
        </a>
        <div>
          <p>Made with ❤️ in pursuit of digital financial 🗽</p>
        </div>
      </footer>
    </div>
  );
}
