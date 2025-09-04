"use client";
import { useState, useEffect } from "react";
import {
  createPasskey,
  existsPasskey,
  generateAuthKey,
  generateFingerprint,
  getPasskey,
  load,
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

export default function Home() {
  const [deployed, setDeployed] = useState(false);
  const [address, setAddress] = useState<Address | null>(null);
  const [userName, setUsername] = useState("");
  const [userWallet, setWallet] = useState<Safe4337Pack | null>(null);
  const [showPopup, setShowPopup] = useState(false);
  const [popupMessage, setPopupMessage] = useState("");

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

  useEffect(() => {
    if (typeof window !== "undefined" && !window.PublicKeyCredential) {
      openPopup("Credentials not supported on this device or browser.");
    }
  });

  async function handleStore(
    fingerprint: string,
    passkey: PasskeyArgType,
    wallet: Safe4337Pack,
  ) {
    openPopup("Deploying your wallet");
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
        setDeployed(true);
        closePopup();
      }
    } catch (e) {
      await log(e);
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

    const isSafeDeployed = await wallet.protocolKit.isSafeDeployed();
    setDeployed(isSafeDeployed);

    closePopup();

    return wallet;
  }

  async function formatPasskey(fingerprint: string): Promise<PasskeyArgType> {
    const onchainPasskey = (await getPasskey(
      fingerprint,
    )) as PasskeyOnchainResponseType;
    const passkey = {
      rawId: onchainPasskey.rawId,
      coordinates: {
        x: onchainPasskey.coordinateX,
        y: onchainPasskey.coordinateY,
      },
    } as PasskeyArgType;

    // TRACE - DEBUG
    // console.log(passkey);
    return passkey;
  }

  // Search onchain
  // If delete broswer data, will check onchain and will retrieve passkey data if exists
  // If calculated fingerprint is equal to the one onchain, we retrieve passkey data from SC BUT a new passkey is created in Google or the device.
  async function checkUserOnchain(username: string) {
    openPopup(`Looking for your wallet ${username}`);
    let overwrite = false;
    let exists = false;

    const authKey = generateAuthKey(username);
    // TRACE - DEBUG
    // console.log(authKey);

    const fingerprint = generateFingerprint(authKey);
    // TRACE - DEBUG
    // console.log(fingerprint);

    try {
      if (await existsPasskey(fingerprint)) {
        const passkey = await formatPasskey(fingerprint);
        // setUserAuthKey(authKey);

        if (await load(passkey)) {
          // If user removes broswer data BUT still in the same device or Google synced.
          // TRACE - DEBUG
          // console.log("Exists in device");
          localStorage.setItem(username, fingerprint);
          exists = true;
        } else {
          //TODO
          // VERY IMPORTANT. ASK USER BEFORE CONTINUE BECAUSE WILL OVERWRITE ONCHAIN REGISTRY.
          // The user has changed device or deleted passkey from the device.
          // And I don't know if is worth to store again in SC overwriting the existing.
          exists = true;
          overwrite = true;
          setPopupMessage(
            "If you are the owner of this wallet, please load it in the correct device",
          );
          // TRACE - DEBUG
          // console.log(
          //   "Exists onchain but NOT exists in device, create new passkey",
          // );
          throw new Error("Exists onchain but NOT exists in device");
        }
      } else {
        // New user or same user with different platform (anyway don't matter because will create a new passkey)
        // TRACE - DEBUG
        // console.log("NOT exists onchain, create new passkey");
      }
    } catch (e) {
      console.error(e);
    }

    return {
      exists: exists,
      overwrite: overwrite,
    };
  }

  async function createOrLoad(username: string, external: boolean) {
    // TRACE - DEBUG
    // console.log("External provider", external);
    let passkey;
    let fingerprint = localStorage.getItem(username);
    setUsername(username);

    if (!fingerprint) {
      // TRACE - DEBUG
      // console.log("No fingerprint detected");

      // Check if user exists onchain and not locally
      const { exists, overwrite } = await checkUserOnchain(username);
      try {
        if (exists) {
          if (!overwrite) {
            // Retrieve data and load wallet.
            fingerprint = localStorage.getItem(username);
            // TRACE - DEBUG
            // console.log(fingerprint);
            passkey = await formatPasskey(fingerprint!);
            // TRACE - DEBUG
            // console.log("Retrieved passkey from onchain: ", passkey);
            await handleWalletInit(passkey);
          }
        } else {
          // New user
          // TRACE - DEBUG
          // console.log("New user, creating passkey...");
          openPopup("Creating new passkey");
          ({ fingerprint, passkey } = await handleCreatePasskey(
            username,
            external,
          ));

          if (fingerprint && passkey.rawId !== "") {
            const wallet = await handleWalletInit(passkey);
            await handleStore(fingerprint!, passkey, wallet);
          } else {
            openPopup(
              "Your wallet cannot be created. Try again or change browser/device.",
            );
          }
        }
      } catch (e) {
        console.error(e);
      }
    } else {
      openPopup(`Looking for your wallet ${username}`);

      if (!(await existsPasskey(fingerprint))) {
        openPopup(
          "Something goes wrong. If you just deployed your wallet, please try again later.",
        );
        throw new Error("Not exists onchain");
      } else {
        passkey = await formatPasskey(fingerprint);
        // TRACE - DEBUG
        // console.log("Retrieved passkey from onchain: ", passkey);
        if (await load(passkey)) {
          // TRACE - DEBUG
          // console.log("Everything OK");
          await handleWalletInit(passkey);
        } else {
          // TRACE - DEBUG
          // console.log("Onchain exists, storage exists but not in your device.");
          openPopup("Passkey could not be loaded in your device.");
          throw new Error("Not exists in device");
        }
      }
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
          <LoginWithPasskey createOrLoad={createOrLoad} />
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
