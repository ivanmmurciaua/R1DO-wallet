"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import {
  createPasskey,
  generateFingerprint,
  loadFromDevice,
  readFromSC,
} from "@/lib/passkeys";
import { PasskeyArgType } from "@safe-global/protocol-kit";
import LoginWithPasskey from "@/components/LoginWithPasskey";
import styles from "./page.module.css";
import Image from "next/image";
import { safeClient } from "@/lib/client";
import { PACKED_VERIFIERS_HEX } from "@/app/constants";
import { registerPasskey, registerStealthKeys } from "@/lib/deploy";
import { isStealthRegistered, derivePQKeysFromPRF, scanAnnouncements, STEALTH_SCAN_DEFAULT_BLOCKS } from "@/lib/stealth";
import { Address } from "viem";
import { Safe4337Pack } from "@safe-global/relay-kit";
import { PasskeyOnchainResponseType, PasskeyResponseType } from "@/types";
import AccountDetails from "@/components/AccountDetails";
import { log } from "@/lib/common";
import {
  getLocalData,
  removeLocalData,
  // setLocalData,
  updateLocalData,
  getStealthUTXOs,
  saveStealthScan,
  getLastScannedBlock,
} from "@/lib/localstorage";
import { LOCAL_LAST_USER } from "@/app/constants";
import Popup from "@/components/Popup";
import { useThemeMode } from "@/components/ThemeRegistry";

export default function Home() {
  const { isDark, toggleTheme } = useThemeMode();
  const [username, setUsername] = useState("");
  const [deployed, setDeployed] = useState(false);
  const [address, setAddress] = useState<Address | null>(null);
  const [userWallet, setWallet] = useState<Safe4337Pack | null>(null);
  const [showPopup, setShowPopup] = useState(false);
  const [popupMessage, setPopupMessage] = useState("");
  const [isRestoring, setIsRestoring] = useState(false);
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

  // Persist active session so F5 restores it
  useEffect(() => {
    if (deployed && address && username) {
      localStorage.setItem(LOCAL_LAST_USER, username);
    }
  }, [deployed, address, username]);

  // Restore session on mount
  const sessionRestored = useRef(false);
  useEffect(() => {
    if (sessionRestored.current) return;
    sessionRestored.current = true;

    const lastUser = localStorage.getItem(LOCAL_LAST_USER);
    if (!lastUser) return;

    const data = getLocalData(lastUser);
    if (!data?.fingerprint || !data?.passkey?.rawId) {
      localStorage.removeItem(LOCAL_LAST_USER);
      return;
    }

    setIsRestoring(true);
    handleWalletInit(data.passkey as PasskeyArgType, true)
      .then(() => {
        setUsername(lastUser);
        setDeployed(true);
        closePopup();
      })
      .catch((e: unknown) => {
        console.error("[restore] error:", e);
        localStorage.removeItem(LOCAL_LAST_USER);
        closePopup();
      })
      .finally(() => setIsRestoring(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleStore(
    username: string,
    fingerprint: string,
    passkey: PasskeyArgType,
    wallet: Safe4337Pack,
    prfOutput?: Uint8Array,
    privacy?: boolean,
  ) {
    if (!fingerprint || !passkey || !wallet) {
      throw new Error("Missing data");
    }

    try {
      const safeAddress = await wallet.protocolKit.getAddress();
      const isDeployed = await wallet.protocolKit.isSafeDeployed();
      console.log(`[handleStore] Safe: ${safeAddress} | deployed: ${isDeployed}`);
      console.log(`[handleStore] Fingerprint: ${fingerprint}`);
      console.log(`[handleStore] verifierAddress (packed): ${passkey.verifierAddress}`);
      console.log("[handleStore] Sending UserOp — PasskeyRegistry.registerPasskey()...");

      const tx = await registerPasskey(
        wallet,
        fingerprint,
        passkey.rawId,
        passkey.coordinates.x,
        passkey.coordinates.y,
        safeAddress,
      );

      if (tx) {
        console.log(`[handleStore] ✓ PasskeyRegistry tx confirmed: ${tx}`);

        updateLocalData(username, fingerprint, passkey);
        setDeployed(true);

        if (privacy && prfOutput) {
          try {
            console.log("[handleStore] Privacy enabled — registering stealth keys (ERC-6538 scheme 4)...");
            const deployedWallet = await safeClient(passkey);
            const stealthTx = await registerStealthKeys(deployedWallet, prfOutput);
            console.log(`[handleStore] ✓ Stealth registry tx: ${stealthTx}`);
            updateLocalData(username, fingerprint, passkey, true);
          } catch (stealthErr) {
            console.warn("[handleStore] Stealth registration failed (non-fatal):", stealthErr);
          }
        }

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
    silent = false,
  ): Promise<Safe4337Pack> {
    if (!silent) openPopup(`Loading your wallet`);
    const wallet = await safeClient(passkey);
    setWallet(wallet);

    const safeAddress: Address = (await wallet.protocolKit.getAddress()) as Address;
    setAddress(safeAddress);

    const isSafeDeployed = await wallet.protocolKit.isSafeDeployed();
    setDeployed(isSafeDeployed);

    console.log(`[handleWalletInit] Safe: ${safeAddress} | deployed: ${isSafeDeployed}`);
    console.log(`[handleWalletInit] verifierAddress (packed): ${passkey.verifierAddress}`);

    return wallet;
  }

  async function formatPasskey(fingerprint: string): Promise<PasskeyArgType> {
    const onchainPasskey = (await readFromSC(
      "getPasskey",
      fingerprint,
    )) as PasskeyOnchainResponseType | null;

    if (!onchainPasskey || !onchainPasskey.rawId) {
      throw new Error("Could not read passkey from registry");
    }

    const passkey: PasskeyArgType = {
      rawId: onchainPasskey.rawId,
      coordinates: {
        x: onchainPasskey.coordinateX,
        y: onchainPasskey.coordinateY,
      },
      verifierAddress: PACKED_VERIFIERS_HEX,
    };

    return passkey;
  }

  async function createOrLoad(username: string, external: boolean, privacy?: boolean) {
    let passkey;
    setUsername(username);

    const wallet = getLocalData(username);
    const fingerprint = wallet?.fingerprint || "";
    passkey = wallet?.passkey || {};

    console.log(`[createOrLoad] username=${username} fingerprint=${fingerprint || "(empty)"} passkeyInLS=${Object.keys(passkey).length > 0}`);

    if (fingerprint === "") {
      console.log("[createOrLoad] Path: no fingerprint in LS");

      if (Object.keys(passkey).length !== 0) {
        console.log("[createOrLoad] Path: passkey in LS but no fingerprint — checking device...");
        const prfResult = await loadFromDevice((passkey as PasskeyArgType).rawId!);
        if (prfResult) {
          console.log("[createOrLoad] Path: passkey on device — checking onchain...");
          await managePasskey(username, external, passkey as PasskeyArgType, prfResult);
        } else {
          const e =
            "Your wallet is not created. Please remove your passkey from this device";
          openPopup(e);
          removeLocalData(username);

          await log("createOrLoad - 5,6,7", e);
          throw Error(e);
        }
      } else {
        await managePasskey(username, external, null, undefined, privacy);
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
        const prfOnLogin = await loadFromDevice(passkey.rawId);
        console.log(`[login] Passkey found: ${!!prfOnLogin}, PRF output: ${prfOnLogin?.length ? `✓ (${prfOnLogin.length} bytes)` : "✗ not supported"}`);
        if (prfOnLogin) {
          const loginWallet = await handleWalletInit(passkey);
          const safeAddr = await loginWallet.protocolKit.getAddress();
          const hasPrivacy = await isStealthRegistered(safeAddr);
          updateLocalData(username, fingerprint, passkey, hasPrivacy);
          console.log(`[login] privacy (ERC-6538): ${hasPrivacy}`);
          closePopup();
          if (hasPrivacy && prfOnLogin.length > 0) {
            runStealthScan(username, prfOnLogin);
          }
        } else {
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
          exists = true;
          overwrite = true;
          const prfResult = await loadFromDevice(passkey.rawId);
          console.log(`[existsOnchain] Passkey found: ${!!prfResult}, PRF: ${prfResult?.length ? `✓ (${prfResult.length} bytes)` : "✗ not supported"}`);
          console.log(`[existsOnchain] passkey.coordinates.x: ${passkey.coordinates.x}`);
          console.log(`[existsOnchain] passkey.coordinates.y: ${passkey.coordinates.y}`);
          if (prfResult) {
            const loadedWallet = await handleWalletInit(passkey);
            const safeAddr = await loadedWallet.protocolKit.getAddress();
            const hasPrivacy = await isStealthRegistered(safeAddr);
            updateLocalData(username, fingerprint, passkey, hasPrivacy);
            console.log(`[existsOnchain] privacy (ERC-6538): ${hasPrivacy}`);
            closePopup();
            if (hasPrivacy && prfResult.length > 0) {
              runStealthScan(username, prfResult);
            }
          } else {
            openPopup("Your wallet could not be loaded");
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
    _prfOutput?: Uint8Array,
    privacy?: boolean,
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
          const fp = generateFingerprint(username);
          const { passkey: storedPasskey } = getLocalData(username)!;
          console.log(`[managePasskey] exists + !overwrite — updating fingerprint in LS: ${fp}`);
          const managedWallet = await handleWalletInit(storedPasskey);
          const safeAddr = await managedWallet.protocolKit.getAddress();
          const hasPrivacy = await isStealthRegistered(safeAddr);
          updateLocalData(username, fp, storedPasskey, hasPrivacy);
          console.log(`[managePasskey] privacy (ERC-6538): ${hasPrivacy}`);
          closePopup();
        }
        // overwrite === true: existsOnchain already loaded the wallet and closed the popup.
      } else {
        if (passkey) {
          // console.log("Not deployed");
          const fingerprint = generateFingerprint(username);
          const wallet = await handleWalletInit(passkey);
          await handleStore(username, fingerprint, passkey, wallet);
        } else {
          // New user, if not exists onchain, could exists locally ????
          openPopup("Creating new passkey");
          const { fingerprint, passkey, prfOutput } = await handleCreatePasskey(
            username,
            external,
          );

          if (passkey.rawId !== "") {
            const wallet = await handleWalletInit(passkey);
            await handleStore(username, fingerprint!, passkey, wallet, prfOutput, privacy);
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

  async function runStealthScan(username: string, prfOutput: Uint8Array) {
    try {
      console.log("[stealthScan] Deriving PQ keys from PRF...");
      const keys = await derivePQKeysFromPRF(prfOutput);

      const lastBlock = getLastScannedBlock(username);
      const existing  = getStealthUTXOs(username);

      // If no previous scan, go back ~3 days
      const fromBlock = lastBlock ?? (await (async () => {
        const { createPublicClient, http } = await import("viem");
        const { sepolia } = await import("viem/chains");
        const c = createPublicClient({ chain: sepolia, transport: http("https://sepolia.drpc.org") });
        const latest = await c.getBlockNumber();
        return latest > STEALTH_SCAN_DEFAULT_BLOCKS ? latest - STEALTH_SCAN_DEFAULT_BLOCKS : 0n;
      })());

      console.log(`[stealthScan] From block: ${fromBlock} | existing UTXOs: ${existing.length}`);

      const { utxos: newUtxos, latestBlock } = await scanAnnouncements(
        keys.spendingPrivateKey,
        keys.viewingPrivateKey,
        keys.mlkemDecapsKey,
        fromBlock,
      );

      // Merge — deduplicate by stealthAddress
      const merged = [
        ...existing,
        ...newUtxos.filter(u => !existing.some(e => e.stealthAddress === u.stealthAddress)),
      ];

      saveStealthScan(username, merged, latestBlock);
      console.log(`[stealthScan] ✓ Total UTXOs cached: ${merged.length}`);
    } catch (e) {
      console.warn("[stealthScan] Scan failed (non-fatal):", e);
    }
  }

  async function handleCreatePasskey(
    username: string,
    external: boolean,
  ): Promise<PasskeyResponseType> {
    const response = await createPasskey(username, external);
    return response;
  }

  function handleLogout() {
    localStorage.removeItem(LOCAL_LAST_USER);
    setUsername("");
    setAddress(null);
    setWallet(null);
    setDeployed(false);
    closePopup();
  }

  return (
    <div className={styles.page}>
      <button
        onClick={toggleTheme}
        title={isDark ? "Switch to light mode" : "Switch to dark mode"}
        style={{
          position: "fixed",
          top: 16,
          right: 16,
          zIndex: 999,
          background: "transparent",
          border: "1px solid currentColor",
          color: isDark ? "#4a8f5c" : "#2d6a3f",
          fontFamily: "var(--font-geist-mono), monospace",
          fontSize: "0.75rem",
          letterSpacing: "0.08em",
          padding: "5px 10px",
          cursor: "pointer",
          opacity: 0.6,
          transition: "opacity 0.15s",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
        onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.6")}
      >
        {isDark ? "[LIGHT]" : "[DARK]"}
      </button>

      {deployed && address && (
        <button
          onClick={handleLogout}
          title="Logout"
          style={{
            position: "fixed",
            top: 16,
            left: 16,
            zIndex: 999,
            background: "transparent",
            border: "1px solid currentColor",
            color: isDark ? "#4a8f5c" : "#2d6a3f",
            fontFamily: "var(--font-geist-mono), monospace",
            fontSize: "0.75rem",
            letterSpacing: "0.08em",
            padding: "5px 10px",
            cursor: "pointer",
            opacity: 0.6,
            transition: "opacity 0.15s",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.6")}
        >
          [LOGOUT]
        </button>
      )}

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

        {!showPopup && userWallet && username && address && deployed ? (
          <AccountDetails
            username={username}
            wallet={userWallet}
            address={address}
          />
        ) : (
          <LoginWithPasskey createOrLoad={createOrLoad} isRestoring={isRestoring} />
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
