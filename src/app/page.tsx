"use client";
import { useState, useEffect } from "react";
import {
  createPasskey,
  generateAuthKey,
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
import ImportPasskey from "@/components/ImportPasskey";
import { Box, Stack } from "@mui/material";

export default function Home() {
  const [deployed, setDeployed] = useState(false);
  const [address, setAddress] = useState<Address | null>(null);
  const [userName, setUsername] = useState("");
  const [userWallet, setWallet] = useState<Safe4337Pack | null>(null);
  const [showPopup, setShowPopup] = useState(false);
  const [popupMessage, setPopupMessage] = useState("");
  const [recovery, setRecovery] = useState(false);

  const openPopup = (message: string) => {
    if (!showPopup) {
      setShowPopup(true);
    }
    setPopupMessage(message);
  };

  const closePopup = () => {
    setShowPopup(false);
    setPopupMessage("");
  };

  const openRecoveryMessage = (message: string) => {
    setShowPopup(true);
    setPopupMessage(message);
    //TODO: Check logic
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        setShowPopup(false);
        resolve();
      }, 2000);
    });
  };

  const setLocalData = (
    username: string,
    fingerprint: string,
    passkey: PasskeyArgType,
  ) => {
    localStorage.setItem(
      username,
      JSON.stringify({
        fingerprint: fingerprint,
        passkey: passkey,
      }),
    );
  };

  useEffect(() => {
    if (typeof window !== "undefined" && !window.PublicKeyCredential) {
      openPopup("Credentials not supported on this device or browser");
    }
  });

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
        setLocalData(username, fingerprint, passkey);
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
    setUsername(username);
    let passkey;

    const { fingerprint } = JSON.parse(localStorage.getItem(username) || "{}");
    ({ passkey } = JSON.parse(localStorage.getItem(username) || "{}"));

    if (!fingerprint) {
      // TRACE - DEBUG
      // console.log("No fingerprint detected");

      if (passkey) {
        // Created but not deployed
        // Check locally and tell user forget it.
        if (await loadFromDevice(passkey.rawId)) {
          // in device but exists onchain?
          await managePasskey(username, external, passkey);
        } else {
          const e =
            "Your wallet is not created. Please remove your passkey from this device";
          openPopup(e);
          localStorage.removeItem(username);

          await log("createOrLoad - 5,6,7", e);
          throw Error(e);
        }
      } else {
        await managePasskey(username, external);
      }
    } else {
      // TRACE - DEBUG
      // console.log("Fingerprint detected");
      openPopup(`Looking for your wallet ${username}`);
      if (!(await readFromSC("isRegistered", fingerprint)) as boolean) {
        // Finded fingerprint, not exists onchain but I can import passkey if I'm the owner of it and exists in my device.
        if (passkey) {
          if (await loadFromDevice(passkey.rawId)) {
            // Store it onchain
            const wallet = await handleWalletInit(passkey);
            await handleStore(username, fingerprint, passkey, wallet);
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
          setLocalData(username, fingerprint, passkey);
          await handleWalletInit(passkey);
          closePopup();
        } else {
          // localStorage.removeItem(username);
          openPopup("Passkey could not be loaded in your device.");
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
    openPopup(`Looking for your wallet ${username}`);
    let overwrite = false;
    let exists = false;

    const fingerprint = generateFingerprint(generateAuthKey(username));

    try {
      if ((await readFromSC("isRegistered", fingerprint)) as boolean) {
        const passkey = await formatPasskey(fingerprint);

        if (existsPasskey) {
          setLocalData(username, fingerprint, passkey);
          exists = true;
        } else {
          //TODO
          // VERY IMPORTANT. ASK USER BEFORE CONTINUE BECAUSE WILL OVERWRITE ONCHAIN REGISTRY.
          // The user has changed device or deleted passkey from the device.
          // And I don't know if is worth to store again in SC overwriting the existing.
          exists = true;
          overwrite = true;
          if (await loadFromDevice(passkey.rawId)) {
            openRecoveryMessage(
              "You can recover your wallet by importing it below",
            );
            setRecovery(true);
          } else {
            openPopup(
              "Sorry something went wrong, try again but it seems you've lost your wallet :(",
            );
            const e = "Exists onchain but NOT exists in device";
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
          const { passkey } = JSON.parse(
            localStorage.getItem(username) || "{}",
          );
          await handleWalletInit(passkey);
          closePopup();
        } else {
        }
      } else {
        if (passkey) {
          // console.log("Not deployed");
          const fingerprint = generateFingerprint(generateAuthKey(username));
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
            // setLocalData(username, fingerprint, passkey);
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
        {!showPopup && userWallet && address && deployed ? (
          <AccountDetails
            username={userName}
            wallet={userWallet}
            address={address}
          />
        ) : (
          <>
            <LoginWithPasskey createOrLoad={createOrLoad} />
            {recovery && (
              <Stack>
                <Box>
                  <ImportPasskey onImport={() => setRecovery(false)} />
                </Box>
              </Stack>
            )}
          </>
        )}

        {showPopup && popupMessage && (
          <div className={styles.popupOverlay}>
            <div className={styles.popup}>
              <h3>{popupMessage}</h3>
            </div>
          </div>
        )}
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
            width={100}
            height={50}
          />
        </a>
        <div>
          <p>Made with ❤️ in pursuit of digital financial 🗽</p>
        </div>
      </footer>
    </div>
  );
}
