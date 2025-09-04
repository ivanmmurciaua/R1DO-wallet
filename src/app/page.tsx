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

export default function Home() {
  // const [userPasskey, setPasskey] = useState<PasskeyArgType | null>(null);
  // const [code, setCode] = useState(["", "", "", "", "", ""]);
  // const [stored, setStored] = useState(false);
  // const [user, setUser] = useState("");
  // const [userAuthKey, setUserAuthKey] = useState("");
  const [deployed, setDeployed] = useState(false);
  const [address, setAddress] = useState<Address | null>(null);
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

  // Not needed yet. If I need to do something everytime userPasskey changes.
  // useEffect(() => {
  //   if (userPasskey) {
  //     console.log("userPasskey updated:", userPasskey);
  //   }
  // }, [userPasskey]);
  //
  // const handleCodeChange = (index: number, value: string) => {
  //   if (value.length <= 1 && /^\d*$/.test(value)) {
  //     const newCode = [...code];
  //     newCode[index] = value;
  //     setCode(newCode);

  //     // Automatically move to the next input
  //     if (value && index < 5) {
  //       const nextInput = document.getElementById(`code-${index + 1}`);
  //       nextInput?.focus();
  //     }

  //     // Move to the previous input when deleted
  //     if (!value && index > 0) {
  //       const prevInput = document.getElementById(`code-${index - 1}`);
  //       prevInput?.focus();
  //     }
  //   }
  // };

  // const handleSubmitCode = () => {
  //   const fullCode = code.join("");
  //   if (fullCode.length === 6) {
  //     closePopup();
  //     const fingerprint = localStorage.getItem(user);

  //     console.log("Fingerprint: ", fingerprint);
  //     console.log("Secret code:", fullCode);

  //     if (fingerprint) {
  //       if (!stored) {
  //         handleStore(fingerprint, fullCode);
  //       } else {
  //         handleRetrieveData(fingerprint, fullCode);
  //       }
  //     }
  //   }
  // };

  // async function checkCode(code: string): Promise<void> {
  //   // Retrieved passkey from SC
  //   const passkey: PasskeyArgType = {
  //     rawId:
  //       "0122e512aa15bec1470d60821e41e85e58090b5415e2b2d9d0eec154400e6064f04c546f7148a59defd79da1aad8f983e167209a34db8debf788e3acb29dee07d9",
  //     coordinates: {
  //       x: "0x561070a71210358b76f1322300d238aed71dfebd7fc36e8edc40d833c1dba0cd",
  //       y: "0x7ec5e0d2bb995ee8523f5fbdf7bb72f341d96cf59dd2a73f869cc2298c5c8032",
  //     },
  //   };
  //   const wallet = await safeClient(passkey);
  //   console.log(code);
  //   // const encryptedCode = keccak256(toHex(code));
  //   const message = wallet.protocolKit.createMessage(code);
  //   const signedMessage = await wallet.protocolKit.signMessage(
  //     message,
  //     "ETH_SIGN",
  //   );
  //   console.log("Signed message:");
  //   console.log(signedMessage);
  // }

  async function handleStore(
    fingerprint: string,
    passkey: PasskeyArgType,
    wallet: Safe4337Pack,
  ) {
    openPopup("Deploying your wallet...");
    if (!fingerprint || !passkey || !wallet) {
      throw new Error("Missing data");
    }

    // CHECK: TEST MSG.SENDER
    const tx = await registerPasskey(
      wallet,
      fingerprint,
      passkey.rawId,
      passkey.coordinates.x,
      passkey.coordinates.y,
    );

    // TRACE - DEBUG
    console.log(tx);

    // If everything is ok:
    setDeployed(true);

    closePopup();

    // setStored(true);
  }

  //3
  async function handleWalletInit(
    passkey: PasskeyArgType,
  ): Promise<Safe4337Pack> {
    openPopup(`Loading your wallet...`);
    const wallet = await safeClient(passkey);
    setWallet(wallet);

    const safeAddress: Address =
      (await wallet.protocolKit.getAddress()) as Address;
    setAddress(safeAddress);

    const isSafeDeployed = await wallet.protocolKit.isSafeDeployed();
    setDeployed(isSafeDeployed);

    closePopup();

    return wallet;

    // // TRACE - DEBUG
    // console.log("Safe address:", safeAddress);

    // if (!isSafeDeployed) {
    //   return false;
    // }

    // return true;

    // if (!isSafeDeployed) {
    //   if (!fingerprint || !userAuthKey || !userPasskey) {
    //     throw new Error("Missing data");
    //   }

    //   // Change deploy to store data
    //   // const tx = await deploy(wallet);
    //   // console.log(tx);
    //   // if tx ok
    //   // setIsDeployed(true);
    // } else {
    //   console.log("Safe already deployed");
    // }
  }

  // Same as chackUserOnchain
  // async function handleRetrieveData(fingerprint: string) {
  //   if (!fingerprint) {
  //     // || !userAuthKey) {
  //     throw new Error("Missing data");
  //   }

  //   // console.log(code);
  //   // console.log(userAuthKey);

  //   const result = await getPasskey(fingerprint);
  //   console.log(result);

  //   //TYPE
  //   if (result) {
  //     console.log(result.rawId);
  //     console.log(result.coordinateX);
  //     console.log(result.coordinateY);
  //   }

  //   if (result) {
  //     const passkey: PasskeyArgType = {
  //       rawId: result.rawId,
  //       coordinates: {
  //         x: result.coordinateX,
  //         y: result.coordinateY,
  //       },
  //     };

  //     // const wallet = await safeClient(passkey);
  //     // await deploy(wallet);
  //     console.log(await load(passkey));
  //     // handleWalletInit(passkey);
  //   }
  // }
  //
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
    console.log(passkey);

    // setPasskey(passkey);
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
    console.log(authKey);

    const fingerprint = generateFingerprint(authKey);
    // TRACE - DEBUG
    console.log(fingerprint);

    try {
      if (await existsPasskey(fingerprint)) {
        const passkey = await formatPasskey(fingerprint);
        // setUserAuthKey(authKey);

        if (await load(passkey)) {
          // If user removes broswer data BUT still in the same device or Google synced.
          // TRACE - DEBUG
          console.log("Exists in device");
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
          console.log(
            "Exists onchain but NOT exists in device, create new passkey",
          );
          throw new Error("Exists onchain but NOT exists in device");
        }
      } else {
        // New user or same user with different platform (anyway don't matter because will create a new passkey)
        // TRACE - DEBUG
        console.log("NOT exists onchain, create new passkey");
      }
    } catch (e) {
      console.error(e);
    }

    return {
      exists: exists,
      overwrite: overwrite,
    };
  }

  //1
  async function createOrLoad(username: string, external: boolean) {
    // TRACE - DEBUG
    console.log("External provider", external);
    let passkey;
    // setUser(username);

    let fingerprint = localStorage.getItem(username);

    if (!fingerprint) {
      // TRACE - DEBUG
      console.log("No fingerprint detected");

      // Check if user exists onchain and not locally
      const { exists, overwrite } = await checkUserOnchain(username);
      try {
        if (exists) {
          if (!overwrite) {
            // Retrieve data and load wallet.
            fingerprint = localStorage.getItem(username);
            // TRACE - DEBUG
            console.log(fingerprint);
            passkey = await formatPasskey(fingerprint!);
            // TRACE - DEBUG
            console.log("Retrieved passkey from onchain: ", passkey);
            await handleWalletInit(passkey);
          }
        } else {
          // New user
          // TRACE - DEBUG
          console.log("New user, creating passkey...");
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
      // setStored(true);

      // Load from fingerprint
      // TRACE - DEBUG
      console.log("Fingerprint detected: ", fingerprint);

      // Onchain check. If exists, load. If not, ERROR.

      // === MOCK ===
      // const passkey = {}
      // setPasskey(passkey);

      // await handleStore(fingerprint);
      // === MOCK ===

      // TRACE - DEBUG
      console.log("Exists onchain?");

      if (!(await existsPasskey(fingerprint))) {
        openPopup(
          "Something goes wrong. If you just deployed your wallet, please try again later.",
        );
        throw new Error("Not exists onchain");
      } else {
        passkey = await formatPasskey(fingerprint);
        // TRACE - DEBUG
        console.log("Retrieved passkey from onchain: ", passkey);
        if (await load(passkey)) {
          // TRACE - DEBUG
          console.log("Everything OK");
          await handleWalletInit(passkey);
        } else {
          // TRACE - DEBUG
          console.log("Onchain exists, storage exists but not in your device.");
          openPopup("Passkey could not be loaded in your device.");
          throw new Error("Not exists in device");
        }
      }
    }
  }

  /**
   *
   *
   if (await existsPasskey(passkey.fingerprint)) {
     console.log("EXISTS");
   } else {
     // const wallet = await safeClient(passkey.passkey);

     // const safeAddress = await wallet.protocolKit.getAddress();
     // const isSafeDeployed = await wallet.protocolKit.isSafeDeployed();

     // const code = handleSubmitCode();

     // const signedMessage = await wallet.protocolKit.signMessage(fullCode);

     // console.log(safeAddress);
     // console.log(isSafeDeployed);
     console.log("DOES NOT EXIST");
     // Code popup
     setShowPopup(true);
   }
   */

  //2
  async function handleCreatePasskey(
    username: string,
    external: boolean,
  ): Promise<PasskeyResponseType> {
    const response = await createPasskey(username, external);
    // setPasskey(response.passkey);
    // setUserAuthKey(userAuthKey);
    return response;
  }

  return (
    <div className={styles.page}>
      <main className={styles.main}>
        {!showPopup && userWallet && address && deployed ? (
          // <AccountDetails wallet={userWallet} address={address} />
          <AccountDetails address={address} />
        ) : (
          <LoginWithPasskey createOrLoad={createOrLoad} />
        )}

        {showPopup && popupMessage && (
          <div className={styles.popupOverlay}>
            <div className={styles.popup}>
              <h3>{popupMessage}</h3>
              {/*<div className={styles.codeInputs}>
                {code.map((digit, index) => (
                  <input
                    key={index}
                    id={`code-${index}`}
                    type="password"
                    maxLength={1}
                    value={digit}
                    onChange={(e) => handleCodeChange(index, e.target.value)}
                    className={styles.codeInput}
                  />
                ))}
              </div>*/}
              {/*<div className={styles.popupButtons}>
                <button onClick={closePopup}>Cancel</button>
                <button onClick={handleSubmitCode}>OK</button>
              </div>*/}
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
