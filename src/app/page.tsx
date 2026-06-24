"use client";
import { useState, useEffect, useRef, useCallback } from "react";
import { CircularProgress } from "@mui/material";
import { createPasskey, loadFromDevice } from "@/lib/passkeys";
import LoginWithPasskey from "@/components/LoginWithPasskey";
import styles from "./page.module.css";
import Image from "next/image";
import { safeClientFromOwner } from "@/lib/client";
import { setDirectoryEntry } from "@/lib/deploy";
import {
  derivePQKeysFromPRF,
  deriveOwnerKey,
  scanStealthPayments,
  STEALTH_SCAN_DEFAULT_BLOCKS,
} from "@/lib/stealth";
import {
  readDirectory,
  directoryEnabled,
  deriveDirectoryKeys,
  encodeDirectoryPayload,
  sealDirectoryEntry,
  hasDirectoryEntry,
} from "@/lib/registry-v2";
import { saveWalletCredential, getWalletCredential } from "@/lib/credstore";
import { Address } from "viem";
import { Safe4337Pack } from "@safe-global/relay-kit";
import { PasskeyResponseType } from "@/types";
import AccountDetails from "@/components/AccountDetails";
import { log } from "@/lib/common";
import {
  setWalletMeta,
  getWalletMeta,
  getStealthUTXOs,
  saveStealthScan,
  getLastScannedBlock,
  saveMetaAddress,
  getMetaAddress,
  getDirectoryMark,
  setDirectoryMark,
  getCachedPoolZk,
  hydrateStealthStore,
} from "@/lib/localstorage";
import { beginScan, endScan } from "@/lib/scanState";
import { LOCAL_LAST_USER, DIRECTORY_ADDRESS } from "@/app/constants";
import Popup from "@/components/Popup";
import { useThemeMode } from "@/components/ThemeRegistry";
import PrivateView from "@/components/PrivateView";

export default function Home() {
  const { isPrivate, toggleView, exitPublic } = useThemeMode();
  const [username, setUsername] = useState("");
  const [deployed, setDeployed] = useState(false);
  const [address, setAddress] = useState<Address | null>(null);
  const [userWallet, setWallet] = useState<Safe4337Pack | null>(null);
  const [showPopup, setShowPopup] = useState(false);
  const [popupMessage, setPopupMessage] = useState("");
  // const [recovery, setRecovery] = useState(false);

  // Stealth UTXO store hydrated (idb → in-memory cache) for the logged-in user.
  // Gates the wallet render so every sync read of UTXOs is valid (see localstorage).
  const [storeReady, setStoreReady] = useState(false);

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

  // Hydrate the stealth UTXO store (idb → cache) before the wallet renders, so
  // sync reads in the wallet subtree are valid. Re-runs per user (F5, switch).
  useEffect(() => {
    if (!(username && deployed)) {
      setStoreReady(false);
      return;
    }
    let active = true;
    setStoreReady(false);
    hydrateStealthStore(username).finally(() => { if (active) setStoreReady(true); });
    return () => { active = false; };
  }, [username, deployed]);

  // No silent session restore on F5. The login screen shows a "Welcome back"
  // card for this device's primary wallet (LoginWithPasskey) and the user taps
  // Unlock — so the passkey gesture is always DELIBERATE, never auto-fired
  // mid-load (which felt like the prompt "jumped" at you). LOCAL_LAST_USER is
  // still written on login but no longer triggers an automatic re-entry.

  // v2: the wallet derives from the PRF-derived owner key — no coordinates,
  // no on-chain reads needed to reconstruct the Safe.
  async function handleWalletInit(
    ownerKey: `0x${string}`,
  ): Promise<Safe4337Pack> {
    const wallet = await safeClientFromOwner(ownerKey);
    setWallet(wallet);

    const safeAddress: Address = (await wallet.protocolKit.getAddress()) as Address;
    setAddress(safeAddress);

    const isSafeDeployed = await wallet.protocolKit.isSafeDeployed();
    console.log(`[handleWalletInit] Safe: ${safeAddress} | deployed on-chain: ${isSafeDeployed}`);

    return wallet;
  }

  // Publishes the encrypted directory entry once per (user, directory
  // address). Idempotent and non-fatal: login/registration never depend on
  // it. If the entry already exists on-chain it only records the mark.
  async function ensureDirectoryEntry(
    wallet: Safe4337Pack,
    username: string,
    rawId: string,
    metaAddress: `0x${string}` | null,
  ) {
    if (!directoryEnabled()) return;
    if (getDirectoryMark(username) === DIRECTORY_ADDRESS) return;
    try {
      const { fp, encKey } = await deriveDirectoryKeys(username);
      if (await hasDirectoryEntry(fp)) {
        encKey.fill(0);
        setDirectoryMark(username, DIRECTORY_ADDRESS);
        return;
      }
      const safeAddress = (await wallet.protocolKit.getAddress()) as `0x${string}`;
      const blob = sealDirectoryEntry(
        encKey,
        // Include the 0zk rail if it's already been derived (user entered the
        // private world before making findable) — so a private user who opts in
        // gets the shielded pay-by-nick rail in the same entry.
        encodeDirectoryPayload({ rawId, safeAddress, metaAddress, zkAddress: getCachedPoolZk(username) }),
      );
      encKey.fill(0);
      const tx = await setDirectoryEntry(wallet, fp, blob);
      setDirectoryMark(username, DIRECTORY_ADDRESS);
      console.log(`[directory] ✓ Entry published: ${tx}`);
    } catch (e: unknown) {
      console.warn("[directory] publish failed (non-fatal):", e);
      await log("ensureDirectoryEntry", e);
    }
  }

  async function loginWithPrf(
    username: string,
    rawId: string,
    prf: Uint8Array,
    privacyHint?: boolean,
  ) {
    const ownerKey = deriveOwnerKey(prf);
    await handleWalletInit(ownerKey);

    // Respect the privacy choice made at registration: stored flag, then a
    // hint from the directory entry. Wallets unknown to this device (e.g. a
    // tools passkey logging in here for the first time) default to privacy.
    const privacy = getWalletMeta(username)?.privacy ?? privacyHint ?? true;
    setWalletMeta(username, privacy);
    // Mirror into the shared R1DOToolsDB so the rest of the suite sees it
    saveWalletCredential(username, rawId).catch((e) =>
      console.warn("[credstore] mirror failed (non-fatal):", e),
    );

    console.log(`[login] privacy: ${privacy}`);
    setDeployed(true); // logged in — counterfactual address is already usable
    closePopup();
    if (privacy) {
      runStealthScan(username, prf);
    }
    // NOTE: NO automatic directory publish here. Becoming findable is a
    // deliberate opt-in (makeFindable), so logging in never spends sponsored
    // gas on its own — the only sponsored on-chain action is the user's
    // explicit "Make me findable" tap.
  }

  // Deliberate opt-in: publish the encrypted directory entry so others can pay
  // this wallet by username. It's the ONLY sponsored on-chain action of a fresh
  // wallet (it also deploys the counterfactual Safe), kept OFF the registration
  // path so a never-funded wallet never costs the paymaster anything — which is
  // what makes sponsored registration safe on a real-gas chain. Returns true
  // once findable.
  const makeFindable = useCallback(async (): Promise<boolean> => {
    if (!userWallet || !username || !directoryEnabled()) return false;
    if (getDirectoryMark(username) === DIRECTORY_ADDRESS) return true;
    const cred = await getWalletCredential(username).catch(() => null);
    if (!cred) return false;
    await ensureDirectoryEntry(
      userWallet,
      username,
      cred.rawId,
      getMetaAddress(username),
    );
    return getDirectoryMark(username) === DIRECTORY_ADDRESS;
  }, [userWallet, username]);

  async function registerNewUser(
    username: string,
    rawId: string,
    prf: Uint8Array,
    privacy?: boolean,
  ) {
    const ownerKey = deriveOwnerKey(prf);
    await handleWalletInit(ownerKey);

    if (privacy) {
      const keys = await derivePQKeysFromPRF(prf);
      saveMetaAddress(username, keys.pqMetaAddress);
      console.log("[registerNewUser] ✓ Meta-address cached for off-chain sharing");
    }

    setWalletMeta(username, !!privacy);
    saveWalletCredential(username, rawId).catch((e) =>
      console.warn("[credstore] mirror failed (non-fatal):", e),
    );

    // Registration is now 100% counterfactual — ZERO on-chain, ZERO sponsored
    // gas. Publishing to the directory (becoming findable for pay-by-username)
    // is a separate opt-in the user triggers later (makeFindable), so spamming
    // registrations costs the paymaster nothing — safe on a real-gas chain.
    setDeployed(true);
    closePopup();
    if (privacy) {
      // fresh=true → scan from "now" (no wasteful 3-day sweep that 429s the RPC
      // and blocks the Make-findable publish right after registering).
      runStealthScan(username, prf, true);
    }
  }

  async function createOrLoad(username: string, external: boolean, privacy?: boolean) {
    setUsername(username);
    openPopup(`Looking for your wallet`);

    try {
      // 1) Credential known on this device? (shared R1DOToolsDB — the same
      //    store the whole R1DO suite uses)
      let rawId: string | null =
        (await getWalletCredential(username).catch(() => null))?.rawId ?? null;
      let privacyHint: boolean | undefined;
      console.log(`[createOrLoad] username=${username} | local rawId: ${rawId ? "✓" : "✗"}`);

      // 2) Cross-device fallback: the encrypted directory (Argon2id, ~1s)
      if (!rawId && directoryEnabled()) {
        openPopup("Deriving your directory key…");
        const entry = await readDirectory(username);
        if (entry) {
          rawId = entry.rawId;
          // The directory's `hasMeta` byte IS the original privacy choice:
          // a private wallet always carries a metaAddress, a public one never
          // does. Read it as an explicit boolean so a recovered PUBLIC wallet
          // resolves to privacy=false instead of falling through to the
          // default-private. (Without this, deleting a public wallet's local
          // meta and re-recovering it would silently flip it private forever.)
          privacyHint = !!entry.metaAddress;
          if (entry.metaAddress) {
            saveMetaAddress(username, entry.metaAddress);
          }
          console.log(`[createOrLoad] ✓ Credential recovered from the encrypted directory (privacy=${privacyHint})`);
        }
      }

      if (rawId) {
        const prf = await loadFromDevice(rawId);
        if (!prf) {
          openPopup("Your passkey could not be loaded on this device.");
          const e = "Credential known but not usable on this device";
          await log("createOrLoad", e);
          throw new Error(e);
        }
        if (prf.length === 0) {
          openPopup("This authenticator does not support the PRF extension — the wallet key cannot be derived.");
          throw new Error("PRF not supported on login");
        }
        await loginWithPrf(username, rawId, prf, privacyHint);
        return;
      }

      // 3) New user → create the passkey. `external` picks Storage Type:
      //    true = resident/synced (provider), false = non-resident/device-bound.
      openPopup("Creating new passkey");
      const { rawId: newRawId, prfOutput } = await handleCreatePasskey(username, external);

      if (!newRawId) {
        openPopup("Your wallet could not be created. Try again or change browser/device");
        return;
      }

      // Some authenticators only evaluate PRF on get(), not on create().
      // Nothing has been persisted yet, so aborting here leaves no trace.
      const prf =
        prfOutput && prfOutput.length > 0
          ? prfOutput
          : await loadFromDevice(newRawId);
      if (!prf || prf.length === 0) {
        openPopup("This authenticator does not support the PRF extension — R1DO v2 requires it.");
        return;
      }

      // New R1DO wallets are private by default
      await registerNewUser(username, newRawId, prf, privacy ?? true);
    } catch (e: unknown) {
      await log("createOrLoad", e);
      console.error(e);
      throw e;
    }
  }

  // `fresh` = brand-new registration. Such a wallet CANNOT have stealth history
  // (its meta-address didn't exist yet, nobody could pay it), so we start the
  // cursor at the current block instead of sweeping ~3 days back — that sweep
  // finds 0 UTXOs every time yet hammers the public RPCs (429), starving the
  // Make-findable publish that runs right after. Future payments are still
  // caught: every later scan goes from the cursor forward, and you only become
  // payable AFTER registering.
  async function runStealthScan(username: string, prfOutput: Uint8Array, fresh = false) {
    beginScan();
    try {
      await hydrateStealthStore(username); // ensure the cache is loaded before read/merge
      console.log("[stealthScan] Deriving PQ keys from PRF...");
      const keys = await derivePQKeysFromPRF(prfOutput);
      // Keep the shareable meta-address cached (public data, deterministic)
      saveMetaAddress(username, keys.pqMetaAddress);

      const lastBlock = getLastScannedBlock(username);
      const existing  = getStealthUTXOs(username);

      // No previous scan: a fresh wallet starts at "now" (nothing to find); a
      // normal first scan (e.g. recovered on a new device) looks back ~3 days.
      const fromBlock = lastBlock ?? (await (async () => {
        const { createPublicClient, http, fallback } = await import("viem");
        const { activeChain } = await import("@/lib/networks");
        const { RPC_URLS } = await import("@/app/constants");
        const c = createPublicClient({ chain: activeChain(), transport: fallback(RPC_URLS.map((u) => http(u))) });
        const latest = await c.getBlockNumber();
        if (fresh) return latest;
        return latest > STEALTH_SCAN_DEFAULT_BLOCKS ? latest - STEALTH_SCAN_DEFAULT_BLOCKS : 0n;
      })());

      console.log(`[stealthScan] From block: ${fromBlock} | existing UTXOs: ${existing.length}`);

      const { utxos: newUtxos, latestBlock } = await scanStealthPayments(
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
    } finally {
      endScan();
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
    exitPublic(); // always return to the public world on logout
    // Clear all Railgun pool state so the next account never inherits the
    // previous 0zk / balances / watcher.
    import("@/lib/pool/railgun")
      .then((m) => m.resetPool())
      .catch(() => {});
    closePopup();
  }

  const inWallet = !!(userWallet && username && address && deployed);

  return (
    <div className={`${styles.page}${inWallet ? ` ${styles.inWallet}` : ""}`}>
      {/* Threshold: cross into the private world (shadow) or back to the
          public one (light). Only visible inside the wallet — the private
          world belongs to your account. (This step only changes the look;
          Railgun is not started yet.) */}
      {deployed && address && (
        <button
          onClick={toggleView}
          title={isPrivate ? "Back to the light (public)" : "Enter the shadow (private)"}
          aria-label={isPrivate ? "Exit private mode" : "Enter private mode"}
          style={{
            position: "fixed",
            top: 16,
            right: 16,
            zIndex: 999,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "transparent",
            border: "1px solid currentColor",
            color: "currentColor",
            padding: 8,
            lineHeight: 0,
            borderRadius: isPrivate ? 2 : 10,
            cursor: "pointer",
            opacity: 0.65,
            transition: "opacity 0.15s, border-radius 0.3s",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.65")}
        >
          {isPrivate ? (
            // sun → back to the light
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M19.1 4.9l-1.4 1.4M6.3 17.7l-1.4 1.4" />
            </svg>
          ) : (
            // moon → enter the shadow
            <svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z" />
            </svg>
          )}
        </button>
      )}

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
            color: "currentColor",
            fontFamily: "var(--font-geist-mono), monospace",
            fontSize: "0.7rem",
            letterSpacing: "0.12em",
            padding: "6px 11px",
            borderRadius: isPrivate ? 2 : 10,
            cursor: "pointer",
            opacity: 0.65,
            transition: "opacity 0.15s, border-radius 0.3s",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = "1")}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.65")}
        >
          LOGOUT
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
          !storeReady ? (
            <CircularProgress size={50} sx={{ mt: 3 }} />
          ) : isPrivate ? (
            <PrivateView username={username} wallet={userWallet} />
          ) : (
            <AccountDetails
              username={username}
              wallet={userWallet}
              address={address}
              makeFindable={makeFindable}
            />
          )
        ) : (
          <LoginWithPasskey createOrLoad={createOrLoad} />
        )}
        {showPopup && popupMessage && <Popup popupMessage={popupMessage} />}
      </main>

      {/* Footer lives only on the login screen — inside the wallet the bottom
          belongs to the fixed action bar, which the footer was colliding with. */}
      {!(userWallet && username && address && deployed) && (
        <footer className={styles.footer}>
          <a
            href="https://ethereum.org"
            target="_blank"
            rel="noopener noreferrer"
          >
            <Image
              aria-hidden
              src={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}/ethereum-badge.svg`}
              alt="Powered by Ethereum"
              width={77}
              height={33}
            />
          </a>
          <div>
            <p>Made with ❤️ in pursuit of digital financial 🗽</p>
          </div>
        </footer>
      )}
    </div>
  );
}
