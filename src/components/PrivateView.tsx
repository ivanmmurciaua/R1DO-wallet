"use client";
import { useEffect, useState } from "react";
import {
  Box,
  Typography,
  Button,
  Stack,
  Paper,
  CircularProgress,
  Slider,
  TextField,
  Snackbar,
  Alert,
  Switch,
  FormControlLabel,
  IconButton,
  Popover,
} from "@mui/material";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CheckIcon from "@mui/icons-material/Check";
import QrCodeScannerIcon from "@mui/icons-material/QrCodeScanner";
import { formatUnits, parseUnits } from "viem";
import type { Safe4337Pack } from "@safe-global/relay-kit";
import { getWalletCredential } from "@/lib/credstore";
import { loadFromDevice } from "@/lib/passkeys";
import { ensureZkInDirectory, resolvePoolAddress } from "@/lib/registry-v2";
import { getDecimals, getSymbol, getCachedPoolZk, setCachedPoolZk, getWalletMeta, getMetaAddress, addStealthUTXO, getHideBalance, setHideBalance } from "@/lib/localstorage";
import { QrCode } from "./QrCode";
import { GlitchText } from "./GlitchText";
import { QrScanner } from "./QrScanner";
import type { PoolBalances } from "@/lib/pool/railgun";
import { protocolName } from "@/lib/pool/protocols";
import { generateStealthPayment, type StealthUTXO, type StealthPayment } from "@/lib/stealth";

type Coin = { utxo: StealthUTXO; balance: bigint };

/* 影 · Private view.
   Locked → checking registration → Enable/Unlock (one passkey tap derives the
   0zk; secrets never cached, only the public 0zk address).
   Unlocked → shielded balance (tap to copy your 0zk), Deposit (public shield),
   and the background POI+balance watcher. Amounts everywhere use the
   configured symbol + decimals (same as the public side). */

type EngineStatus = "booting" | "up" | "error";

const fmt = (wei: bigint, decimals: number): string => {
  const n = parseFloat(formatUnits(wei, decimals));
  return Number.isInteger(n) ? n.toString() : parseFloat(n.toFixed(4)).toString();
};

// Compact display formatter (2 decimals, K/M/B) for headline balances — same as
// the public side. `fmt` stays for forms/fees/coin lists where precision matters.
const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
const fmtCompact = (wei: bigint, decimals: number): string => compactFmt.format(parseFloat(formatUnits(wei, decimals)));

// Railgun takes `bps` basis points (25 = 0.25%) on shield/unshield. Two views of
// the same op: gross (you move `amount`, receive amount − fee) or exact/net (you
// receive exactly `amount`, we gross-up what's moved). `moves` is always the
// operation amount handed to the SDK. When `cap` is set (the available balance)
// and the grossed-up amount would exceed it, we fall back to gross (forcedGross).
const BPS_DEN = 10_000n;
const grossUp = (net: bigint, bps: number): bigint => {
  const d = BPS_DEN - BigInt(bps);
  return (net * BPS_DEN + d - 1n) / d; // ceil(net / (1 − bps))
};
const computeFee = (
  typedWei: bigint,
  bps: number,
  exact: boolean,
  cap?: bigint,
): { moves: bigint; fee: bigint; receive: bigint; forcedGross: boolean } => {
  let moves = exact ? grossUp(typedWei, bps) : typedWei;
  let forcedGross = false;
  if (exact && cap != null && moves > cap) {
    moves = typedWei; // can't gross-up past the available balance → treat as gross
    forcedGross = true;
  }
  const fee = (moves * BigInt(bps)) / BPS_DEN;
  return { moves, fee, receive: moves - fee, forcedGross };
};

export default function PrivateView({
  username,
  wallet,
}: {
  username: string;
  wallet: Safe4337Pack;
}) {
  const [engine, setEngine] = useState<EngineStatus>("booting");
  const [zk, setZk] = useState<string | null>(null); // 0zk derived THIS session (unlocked)
  const [registeredZk, setRegisteredZk] = useState<string | null | undefined>(undefined); // undefined=checking
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [balances, setBalances] = useState<PoolBalances | null>(null);
  const [decimals, setDecimals] = useState(13);
  const [symbol, setSymbol] = useState("⧫");
  // Deposit (shield) state. Source coin: stealth total (privacy) or the public
  // Safe balance (public). privacy-by-default → smartShield from stealth UTXOs.
  const isPrivacy = getWalletMeta(username)?.privacy ?? false;
  // Active privacy protocol (RAILGUN for now; no switcher yet).
  const proto = protocolName();
  const [depositOpen, setDepositOpen] = useState(false);
  const [depositAmt, setDepositAmt] = useState("");
  const [sourceBalance, setSourceBalance] = useState<bigint | null>(null); // the source "coin" total
  const [shielding, setShielding] = useState(false);
  // B advanced — coin-control (privacy only)
  const [coinMode, setCoinMode] = useState<"amount" | "coins">("amount");
  const [coins, setCoins] = useState<Coin[] | null>(null); // null = loading
  const [selectedCoins, setSelectedCoins] = useState<Set<string>>(new Set());
  // Transfer (private 0zk → 0zk) state — 3-step wizard (Recipient → Amount → Review)
  const [sendOpen, setSendOpen] = useState(false);
  const [sendStep, setSendStep] = useState<1 | 2 | 3>(1);
  const [sendTo, setSendTo] = useState("");
  const [sendToZk, setSendToZk] = useState(""); // recipient resolved to a 0zk at step 1
  const [sendDisplay, setSendDisplay] = useState(""); // human label for steps 2/3
  const [sendResolving, setSendResolving] = useState(false);
  const [sendResolveError, setSendResolveError] = useState("");
  const [sendAmt, setSendAmt] = useState("");
  const [sendStage, setSendStage] = useState<"idle" | "resolving" | "proving" | "submitting">("idle");
  const [proveProgress, setProveProgress] = useState(0);
  // Unshield (private 0zk → public address) state
  const [unshieldOpen, setUnshieldOpen] = useState(false);
  const [unshieldTo, setUnshieldTo] = useState("");
  const [unshieldAmt, setUnshieldAmt] = useState("");
  const [unshieldStage, setUnshieldStage] = useState<"idle" | "proving" | "submitting">("idle");
  const [unshieldProgress, setUnshieldProgress] = useState(0);
  // Railgun protocol fees (basis points), read live in bootEngine. The "exact"
  // toggles let the user gross-up so the net received equals the typed amount.
  const [fees, setFees] = useState<{ shieldBps: number; unshieldBps: number }>({ shieldBps: 25, unshieldBps: 25 });
  const [shieldExact, setShieldExact] = useState(false);
  const [unshieldExact, setUnshieldExact] = useState(false);
  // Privacy-mode unshield destination: a fresh one-time stealth address we own.
  // `unshieldAnnounce` ON = emit the Δ1 blob on-chain (recoverable by scan, any
  // device); OFF = ghost (no blob → max privacy, but spendable from this device
  // only via the local note).
  const [unshieldStealth, setUnshieldStealth] = useState<StealthPayment | null>(null);
  const [unshieldAnnounce, setUnshieldAnnounce] = useState(true);
  // Info popover (Announce/Ghost explainer) — click-to-open, mobile-friendly.
  const [infoAnchor, setInfoAnchor] = useState<HTMLElement | null>(null);
  // POI activity (finalizing a spent-POI) — surfaced to warn the user
  const [poolActivity, setPoolActivity] = useState<{ finalizing: boolean; generatingProof: boolean; proofProgress: number }>({
    finalizing: false,
    generatingProof: false,
    proofProgress: 0,
  });
  const [toast, setToast] = useState<{ msg: string; sev: "success" | "error" | "info" } | null>(null);
  const [bootAttempt, setBootAttempt] = useState(0); // bump → retry the boot
  // Balance privacy — shared pref with the public side (one toggle rules both
  // worlds). Masks the headline + pending amounts with the Matrix glitch.
  const [hideBalance, setHide] = useState<boolean>(() => getHideBalance());
  const [zkCopied, setZkCopied] = useState(false); // copy feedback on the 0zk receive card
  const [scanning, setScanning] = useState(false); // QR scanner overlay (private transfer "To")

  const toggleHideBalance = () =>
    setHide((h) => {
      const next = !h;
      setHideBalance(next);
      return next;
    });

  useEffect(() => {
    setDecimals(getDecimals());
    setSymbol(getSymbol());
  }, []);

  // Check registration on entering: cached 0zk first (instant), else an
  // on-chain directory read (~1s Argon2id). Decides Unlock vs Enable.
  useEffect(() => {
    let alive = true;
    (async () => {
      const cached = getCachedPoolZk(username);
      if (cached) {
        if (alive) setRegisteredZk(cached);
        console.log("[private] registration: cached 0zk → registered");
        return;
      }
      try {
        console.log("[private] checking directory registration (Argon2id ~1s)…");
        const zkAddr = await resolvePoolAddress(username);
        if (!alive) return;
        setRegisteredZk(zkAddr);
        if (zkAddr) {
          setCachedPoolZk(username, zkAddr);
          console.log("[private] registered ✓ — 0zk recovered from directory");
        } else {
          console.log("[private] not registered yet");
        }
      } catch (e) {
        console.warn("[private] registration check failed:", e);
        if (alive) setRegisteredZk(null);
      }
    })();
    return () => {
      alive = false;
    };
  }, [username]);

  // Boot the engine on entering (heavy SDK loaded lazily). Subscribe to
  // balances; resume + restart the watcher if the 0zk was derived this session.
  useEffect(() => {
    let alive = true;
    setEngine("booting");
    console.log("[private] entered the shadow — loading pool adapter (lazy import)…");
    (async () => {
      try {
        const mod = await import("@/lib/pool/railgun");
        console.log("[private] adapter loaded — booting engine…");
        // bootEngine HARD-GATES on the POI health-check: it throws if no POI
        // node responds → we land in the catch → engine "error" → red + blocked.
        await mod.bootEngine();
        if (!alive) return;
        setEngine("up");
        console.log("[private] engine ready ✓");
        setFees(mod.getPoolFees()); // live Railgun fees (basis points)
        mod.onPoolBalances((b) => {
          if (alive) setBalances(b);
        });
        mod.onPoolActivity((a) => {
          if (alive) setPoolActivity(a);
        });
        const existing = mod.getPoolWallet(username);
        if (existing) {
          setZk(existing.railgunAddress);
          mod.startWatcher();
        }
      } catch (e) {
        console.error("[private] engine boot failed:", e);
        if (alive) setEngine("error");
      }
    })();
    return () => {
      alive = false;
      import("@/lib/pool/railgun").then((m) => m.stopWatcher());
      console.log("[private] left the shadow — watcher stopped");
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bootAttempt]);

  // Enable (first time) / Unlock (already registered): re-auth (passkey) →
  // derive the 0zk → start the watcher. Publishes the 0zk to the directory if
  // missing (idempotent, best-effort). The tap gives WebAuthn a fresh gesture.
  const unlock = async () => {
    setError(null);
    setWorking(true);
    let prf: Uint8Array | null = null;
    try {
      console.log(`[private] ${registeredZk ? "unlocking" : "enabling"} shielded account — re-authenticating…`);
      const cred = await getWalletCredential(username).catch(() => null);
      if (!cred?.rawId) throw new Error("no credential found for this user");
      prf = await loadFromDevice(cred.rawId);
      if (!prf || prf.length === 0) throw new Error("PRF unavailable on this device");
      const mod = await import("@/lib/pool/railgun");
      const { railgunAddress } = await mod.createPoolWallet(prf, username);
      setZk(railgunAddress);
      setRegisteredZk(railgunAddress);
      setCachedPoolZk(username, railgunAddress);
      mod.startWatcher();
      console.log("[private] shielded account ready ✓");

      // Publish the 0zk into the directory so others can pay you by nick via
      // RAILGUN. Best-effort: the pool works without it, so never block on it.
      ensureZkInDirectory(wallet, username, railgunAddress)
        .then((r) => console.log(`[private] directory 0zk: ${r}`))
        .catch((e) => console.warn("[private] directory 0zk publish failed (non-fatal):", e));
    } catch (e) {
      console.error("[private] unlock failed:", e);
      setError(e instanceof Error ? e.message : "could not open shielded account");
    } finally {
      prf?.fill(0); // wipe PRF material from memory
      setWorking(false);
    }
  };

  // Copy your 0zk from the Receive card (the balance click is freed for the
  // hide toggle). Inline check feedback on the card.
  const copyZk = async () => {
    if (!zk) return;
    try {
      await navigator.clipboard.writeText(zk);
      setZkCopied(true);
      setTimeout(() => setZkCopied(false), 1600);
    } catch {
      setToast({ msg: "could not copy", sev: "error" });
    }
  };

  // Surface the source "coin" total: stealth UTXOs (privacy) or the main Safe.
  const fetchSourceBalance = async () => {
    try {
      if (isPrivacy) {
        const { getStealthTotal } = await import("@/lib/deploy");
        setSourceBalance(await getStealthTotal(username));
      } else {
        setSourceBalance(BigInt((await wallet.protocolKit.getBalance()).toString()));
      }
    } catch (e) {
      console.warn("[private] source balance fetch failed:", e);
    }
  };

  const openDeposit = () => {
    setSendOpen(false);
    setUnshieldOpen(false);
    setDepositAmt("");
    setSourceBalance(null);
    setCoinMode("amount");
    setSelectedCoins(new Set());
    setDepositOpen(true);
    fetchSourceBalance();
  };

  // Switch to coin-control: load the user's stealth UTXOs as selectable coins.
  const enterCoinMode = async () => {
    setCoinMode("coins");
    setCoins(null);
    setSelectedCoins(new Set());
    try {
      const { getStealthCoins } = await import("@/lib/deploy");
      setCoins(await getStealthCoins(username));
    } catch (e) {
      console.warn("[private] coin list fetch failed:", e);
      setCoins([]);
    }
  };

  const toggleCoin = (addr: string) =>
    setSelectedCoins((prev) => {
      const next = new Set(prev);
      if (next.has(addr)) next.delete(addr);
      else next.add(addr);
      return next;
    });

  // Coin-control shield: shield the SELECTED stealth UTXOs whole (inlinkable).
  const doShieldCoins = async () => {
    if (!coins || selectedCoins.size === 0) return;
    const selected = coins.filter((c) => selectedCoins.has(c.utxo.stealthAddress)).map((c) => c.utxo);
    setShielding(true);
    try {
      console.log(`[private] shield ${selected.length} selected coin(s) → pool…`);
      const mod = await import("@/lib/pool/railgun");
      const { shieldCoins } = await import("@/lib/deploy");
      const res = await shieldCoins(selected, username, (a) => mod.populateShieldTx(a));
      if (!res.success) throw new Error(res.error ?? "shield failed");
      console.log(`[private] ✓ shielded ${res.txHashes.length} coin(s)`);
      setToast({
        msg: "Shielded — validating, your balance updates shortly",
        sev: "success",
      });
      setDepositOpen(false);
    } catch (e) {
      console.error("[private] coin shield failed:", e);
      setToast({ msg: e instanceof Error ? e.message : "shield failed", sev: "error" });
    } finally {
      setShielding(false);
    }
  };

  const selectedTotal =
    coins?.filter((c) => selectedCoins.has(c.utxo.stealthAddress)).reduce((s, c) => s + c.balance, 0n) ?? 0n;

  const openSend = () => {
    setDepositOpen(false);
    setUnshieldOpen(false);
    setSendStep(1);
    setSendTo("");
    setSendToZk("");
    setSendDisplay("");
    setSendResolveError("");
    setSendResolving(false);
    setSendAmt("");
    setSendStage("idle");
    setSendOpen(true);
  };

  // Step 1 → resolve the recipient (0zk used as-is; a nick resolves through the
  // directory) before advancing, so steps 2/3 work with a confirmed 0zk.
  const continueSendRecipient = async () => {
    const to = sendTo.trim();
    if (!to) {
      setSendResolveError("Enter a recipient");
      return;
    }
    setSendResolving(true);
    setSendResolveError("");
    try {
      let zkAddr = to;
      if (!to.toLowerCase().startsWith("0zk")) {
        const resolved = await resolvePoolAddress(to);
        if (!resolved) {
          setSendResolveError(`"${to}" has no shielded account to receive`);
          return;
        }
        zkAddr = resolved;
      }
      setSendToZk(zkAddr);
      setSendDisplay(
        to.toLowerCase().startsWith("0zk")
          ? `${to.slice(0, 10)}…${to.slice(-4)}`
          : `${to} → ${zkAddr.slice(0, 8)}…`,
      );
      setSendStep(2);
    } finally {
      setSendResolving(false);
    }
  };

  // Transfer private (0zk → 0zk). Recipient: a 0zk address or a nick (resolved
  // via the directory). Proving blocks (~9s, with %); the proven tx is relayed
  // by the main Safe (self-relay). The change's spent-POI is then finalized by
  // the watcher in the background (see the finalizing banner).
  const doSend = async () => {
    const to = sendTo.trim();
    const amt = sendAmt.trim();
    if (!to) {
      setToast({ msg: "Enter a recipient (username or 0zk)", sev: "error" });
      return;
    }
    if (!amt || Number.isNaN(Number(amt)) || Number(amt) <= 0) {
      setToast({ msg: "Enter a valid amount", sev: "error" });
      return;
    }
    let amountWei: bigint;
    try {
      amountWei = parseUnits(amt, decimals);
    } catch {
      setToast({ msg: "Enter a valid amount", sev: "error" });
      return;
    }
    if (amountWei > spendable) {
      setToast({ msg: "Amount exceeds your spendable balance", sev: "error" });
      return;
    }
    try {
      // Recipient already resolved to a 0zk at step 1 (sendToZk). Fall back to a
      // fresh resolve only if it's somehow missing.
      let zkAddr = sendToZk || to;
      if (!zkAddr.toLowerCase().startsWith("0zk")) {
        setSendStage("resolving");
        console.log(`[private] resolving recipient "${to}"…`);
        const resolved = await resolvePoolAddress(to);
        if (!resolved) throw new Error(`"${to}" has no shielded account to receive`);
        zkAddr = resolved;
      }
      setSendStage("proving");
      setProveProgress(0);
      console.log(`[private] transfer ${amt} ${symbol} → ${zkAddr.slice(0, 12)}…`);
      const mod = await import("@/lib/pool/railgun");
      const tx = await mod.populateTransferTx(zkAddr, amountWei, (p) => setProveProgress(p));
      setSendStage("submitting");
      const deploy = await import("@/lib/deploy");
      let txHash: string;
      if (isPrivacy) {
        // inlinkable: relay from a fresh ephemeral Safe (personal broadcaster)
        const relayKey = mod.getRelayKey();
        if (!relayKey) throw new Error("relay key not available");
        txHash = await deploy.relayViaEphemeralSafe(relayKey, tx);
      } else {
        txHash = await deploy.sendTxViaSafe(wallet, tx);
      }
      console.log(`[private] ✓ transfer submitted — tx: ${txHash}`);
      setToast({
        msg: "Sent — validating privately, your change will finalize shortly",
        sev: "success",
      });
      setSendOpen(false);
      setSendTo("");
      setSendAmt("");
    } catch (e) {
      console.error("[private] transfer failed:", e);
      setToast({ msg: e instanceof Error ? e.message : "transfer failed", sev: "error" });
    } finally {
      setSendStage("idle");
    }
  };

  const sendBusy = sendStage !== "idle";
  const sendLabel =
    sendStage === "resolving"
      ? "resolving recipient…"
      : sendStage === "proving"
        ? `generating proof… ${proveProgress}%`
        : sendStage === "submitting"
          ? "submitting…"
          : "Send";

  // Default the unshield destination by mode (both editable):
  //  · public  → the user's own main Safe.
  //  · privacy → a FRESH one-time stealth address we own (unlinkable); the ETH
  //    lands there and (announce ON) the blob is published / (ghost) kept local.
  const openUnshield = async () => {
    setDepositOpen(false);
    setSendOpen(false);
    setUnshieldTo("");
    setUnshieldAmt("");
    setUnshieldStage("idle");
    setUnshieldStealth(null);
    setUnshieldAnnounce(true);
    setUnshieldOpen(true);
    if (isPrivacy) {
      const meta = getMetaAddress(username);
      if (!meta) {
        console.warn("[private] no meta-address — paste a destination manually");
        return; // leave blank; the user can paste any address
      }
      try {
        const payment = await generateStealthPayment(meta);
        setUnshieldStealth(payment);
        setUnshieldTo(payment.stealthAddress);
        console.log(`[private] fresh stealth destination: ${payment.stealthAddress}`);
      } catch (e) {
        console.warn("[private] could not generate stealth destination:", e);
      }
      return;
    }
    try {
      setUnshieldTo(await wallet.protocolKit.getAddress());
    } catch {
      /* leave blank — the user can paste any address */
    }
  };

  // Unshield (0zk → public address). No nick to resolve: the destination is a
  // public 0x. Proving blocks (~9s, with %); the proven tx is relayed by the
  // main Safe (public) or a fresh ephemeral Safe (privacy). Spike insight: the
  // ETH lands on confirmation — the unshield-event's spent-POI is background
  // cleanup the watcher finalizes, so success here = on-chain confirmed.
  const doUnshield = async () => {
    const to = unshieldTo.trim();
    const amt = unshieldAmt.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(to)) {
      setToast({ msg: "Enter a valid destination address (0x…)", sev: "error" });
      return;
    }
    if (!amt || Number.isNaN(Number(amt)) || Number(amt) <= 0) {
      setToast({ msg: "Enter a valid amount", sev: "error" });
      return;
    }
    let typedWei: bigint;
    try {
      typedWei = parseUnits(amt, decimals);
    } catch {
      setToast({ msg: "Enter a valid amount", sev: "error" });
      return;
    }
    // "exact" mode grosses-up so the address receives the typed amount; capped at
    // spendable (can't unshield more than you hold → falls back to gross there).
    const { moves } = computeFee(typedWei, fees.unshieldBps, unshieldExact, spendable);
    if (moves > spendable) {
      setToast({ msg: "Amount exceeds your spendable balance", sev: "error" });
      return;
    }
    try {
      setUnshieldStage("proving");
      setUnshieldProgress(0);
      console.log(`[private] unshield ${fmt(moves, decimals)} ${symbol} (net ${amt}) → ${to}`);
      const mod = await import("@/lib/pool/railgun");
      const tx = await mod.populateUnshieldTx(to, moves, (p) => setUnshieldProgress(p));
      setUnshieldStage("submitting");
      const deploy = await import("@/lib/deploy");
      let txHash: string;
      if (isPrivacy) {
        // inlinkable submitter: relay from a fresh ephemeral Safe
        const relayKey = mod.getRelayKey();
        if (!relayKey) throw new Error("relay key not available");
        txHash = await deploy.relayViaEphemeralSafe(relayKey, tx);
      } else {
        txHash = await deploy.sendTxViaSafe(wallet, tx);
      }
      console.log(`[private] ✓ unshield submitted — tx: ${txHash}`);

      // Privacy mode, destination still the fresh stealth we generated (user
      // didn't edit it): make that one-time address discoverable/spendable.
      //  · announce ON  → publish the Δ1 blob (value-0 UserOp via ephemeral Safe)
      //                   → recoverable by scan on any device.
      //  · ghost (OFF)  → keep a local note (this device only). Also the safe
      //                   fallback if the announce tx fails (funds never lost).
      let toastMsg = "Unshielded — your funds are in your address now (POI finalizing in background)";
      if (isPrivacy && unshieldStealth && to.toLowerCase() === unshieldStealth.stealthAddress.toLowerCase()) {
        const ghostNote: StealthUTXO = {
          stealthAddress: unshieldStealth.stealthAddress,
          ephemeralPubkey: unshieldStealth.ephemeralPubkey,
          kemCiphertext: unshieldStealth.kemCiphertext,
          blockNumber: 0,
        };
        if (unshieldAnnounce) {
          try {
            const relayKey = mod.getRelayKey();
            if (!relayKey) throw new Error("relay key not available");
            const announce = await deploy.relayViaEphemeralSafe(relayKey, {
              to: unshieldStealth.stealthAddress,
              data: unshieldStealth.calldataBlob,
              value: "0",
            });
            console.log(`[private] ✓ stealth blob announced — tx: ${announce}`);
            toastMsg = "Unshielded to a fresh stealth address — yours, recoverable by scan (POI finalizing in background)";
          } catch (e) {
            // Announce failed → fall back to a local note so funds stay spendable.
            console.warn("[private] announce failed — saving ghost note locally:", e);
            addStealthUTXO(username, ghostNote);
            toastMsg = "Unshielded to a fresh stealth address — couldn't announce, saved locally (this device only)";
          }
        } else {
          addStealthUTXO(username, ghostNote);
          console.log(`[private] ghost note saved locally: ${ghostNote.stealthAddress}`);
          toastMsg = "Unshielded in ghost mode — spendable from this device only (POI finalizing in background)";
        }
      }

      setToast({ msg: toastMsg, sev: "success" });
      setUnshieldOpen(false);
      setUnshieldTo("");
      setUnshieldAmt("");
    } catch (e) {
      console.error("[private] unshield failed:", e);
      setToast({ msg: e instanceof Error ? e.message : "unshield failed", sev: "error" });
    } finally {
      setUnshieldStage("idle");
    }
  };

  const unshieldBusy = unshieldStage !== "idle";
  const unshieldLabel =
    unshieldStage === "proving"
      ? `generating proof… ${unshieldProgress}%`
      : unshieldStage === "submitting"
        ? "submitting…"
        : "Unshield";
  // Destination is still the fresh stealth we generated (user didn't edit it) →
  // the announce/ghost choice applies.
  const unshieldToSelfStealth =
    isPrivacy &&
    !!unshieldStealth &&
    unshieldTo.trim().toLowerCase() === unshieldStealth.stealthAddress.toLowerCase();

  // Deposit (shield). Amount in {symbol}+decimals (→ wei).
  //  · privacy → smartShield: drawn from stealth UTXOs (inlinkable), N UserOps.
  //  · public  → a single shield from the main Safe (linkable, the simple case).
  // Fire-and-forget — the watcher moves it ShieldPending → Spendable.
  const doShield = async () => {
    const amt = depositAmt.trim();
    if (!amt || Number.isNaN(Number(amt)) || Number(amt) <= 0) {
      setToast({ msg: "Enter a valid amount", sev: "error" });
      return;
    }
    let typedWei: bigint;
    try {
      typedWei = parseUnits(amt, decimals);
    } catch {
      setToast({ msg: "Enter a valid amount", sev: "error" });
      return;
    }
    // "exact" mode grosses-up so the pool receives the typed amount; capped at
    // the source balance (can't deposit more than you hold → falls back to gross).
    const { moves } = computeFee(typedWei, fees.shieldBps, shieldExact, sourceBalance ?? undefined);
    if (sourceBalance != null && moves > sourceBalance) {
      setToast({ msg: "Amount exceeds your available balance", sev: "error" });
      return;
    }
    setShielding(true);
    try {
      console.log(`[private] shield ${fmt(moves, decimals)} ${symbol} (net ${amt}) → pool (${isPrivacy ? "private/stealth" : "public"})…`);
      const mod = await import("@/lib/pool/railgun");
      if (isPrivacy) {
        // smart shield: each stealth UTXO shields its own balance → inlinkable
        const { smartShield } = await import("@/lib/deploy");
        const res = await smartShield(moves, username, (a) => mod.populateShieldTx(a));
        if (!res.success) throw new Error(res.error ?? "shield failed");
        console.log(`[private] ✓ smart shield: ${res.txHashes.length} tx(s)`);
      } else {
        const tx = await mod.populateShieldTx(moves);
        const { sendTxViaSafe } = await import("@/lib/deploy");
        const txHash = await sendTxViaSafe(wallet, tx);
        console.log(`[private] ✓ shield submitted — tx: ${txHash}`);
      }
      setToast({
        msg: "Shielded — validating, your balance updates shortly",
        sev: "success",
      });
      setDepositOpen(false);
      setDepositAmt("");
    } catch (e) {
      console.error("[private] shield failed:", e);
      setToast({ msg: e instanceof Error ? e.message : "deposit failed", sev: "error" });
    } finally {
      setShielding(false);
    }
  };

  const spendable = balances?.spendable ?? 0n;
  const pending =
    (balances?.missingExternal ?? 0n) +
    (balances?.missingInternal ?? 0n) +
    (balances?.shieldPending ?? 0n);

  // Transfer amount helpers (wizard step 2) — exact value stays in wei; the
  // balance slider works as a % of spendable, mirroring the public send.
  const sendAmtWei = (() => {
    const t = sendAmt.trim();
    if (!t) return null;
    try {
      return parseUnits(t, decimals);
    } catch {
      return null;
    }
  })();
  const sendOver = sendAmtWei != null && sendAmtWei > spendable;
  const sendAmtValid = sendAmtWei != null && sendAmtWei > 0n && !sendOver;
  const sendPct =
    spendable > 0n && sendAmtWei != null
      ? Math.min(100, Number((sendAmtWei * 10000n) / spendable) / 100)
      : 0;
  const setSendPct = (p: number) => {
    if (spendable <= 0n) return;
    const bips = BigInt(Math.round(Math.max(0, Math.min(100, p)) * 100));
    setSendAmt(formatUnits((spendable * bips) / 10000n, decimals));
  };
  const sendAmtDisplay = sendAmt
    ? new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 }).format(Number(sendAmt))
    : sendAmt;

  // Live fee breakdown for the shield/unshield forms (null when no valid amount).
  const previewFee = (raw: string, bps: number, exact: boolean, cap?: bigint) => {
    const n = raw.trim();
    if (!n || Number.isNaN(Number(n)) || Number(n) <= 0) return null;
    try {
      return computeFee(parseUnits(n, decimals), bps, exact, cap);
    } catch {
      return null;
    }
  };
  const shieldPreview = previewFee(depositAmt, fees.shieldBps, shieldExact, sourceBalance ?? undefined);
  const unshieldPreview = previewFee(unshieldAmt, fees.unshieldBps, unshieldExact, spendable);

  const registered = !!registeredZk;
  const btnLabel = working
    ? registered
      ? "unlocking…"
      : "enabling…"
    : registered
      ? "Unlock shielded account"
      : "Enable shielded account";

  // status dot: green up · amber booting · red error
  const dotColor =
    engine === "up" ? "success.main" : engine === "error" ? "error.main" : "warning.main";

  return (
    <Box sx={{ textAlign: "center", position: "relative" }}>
      {scanning && (
        <QrScanner
          onResult={(text) => {
            // Transfer recipient is a 0zk address or a username → use as-is.
            setSendTo(text.trim());
            setSendToZk("");
            setSendResolveError("");
            setScanning(false);
          }}
          onClose={() => setScanning(false)}
        />
      )}

      {/* 影 (shadow) watermark */}
      <Box
        aria-hidden
        sx={{
          position: "absolute",
          top: -28,
          left: "50%",
          transform: "translateX(-50%)",
          fontSize: 160,
          lineHeight: 1,
          fontFamily: "var(--font-mincho), serif",
          color: "primary.main",
          opacity: 0.05,
          pointerEvents: "none",
          userSelect: "none",
        }}
      >
        影
      </Box>

      {/* header with a real status dot (what "Private pool" is doing) */}
      <Box sx={{ display: "inline-flex", alignItems: "center", gap: 1, mb: 1 }}>
        <Box
          sx={{
            width: 7,
            height: 7,
            borderRadius: "50%",
            bgcolor: dotColor,
            animation: engine === "booting" ? "r1doPulse 1.6s ease-in-out infinite" : "none",
          }}
        />
        <Typography
          variant="body2"
          sx={{ letterSpacing: "0.22em", textTransform: "uppercase", opacity: 0.7 }}
        >
          Private pool
        </Typography>
      </Box>

      {!zk ? (
        /* ── LOCKED: checking / enable / unlock (no balance, no actions) ── */
        <Box sx={{ maxWidth: 360, mx: "auto", mt: 2 }}>
          <Typography variant="h4" sx={{ fontSize: "1.2rem", mb: 1.5 }}>
            Shielded account
          </Typography>

          {engine === "error" ? (
            /* POI/engine down — Railgun unusable. Block EVERYTHING (no green,
               no unlock/register); funds are safe, just can't open the pool. */
            <>
              <Typography variant="body2" sx={{ fontSize: "0.78rem", lineHeight: 1.7, opacity: 0.85, mb: 2.5, color: "error.main" }}>
                Can&apos;t reach the privacy network (POI). Your funds are safu,
                but the private side is unavailable until the connection is
                restored.
              </Typography>
              <Button
                variant="outlined"
                color="primary"
                fullWidth
                onClick={() => setBootAttempt((n) => n + 1)}
              >
                Retry
              </Button>
            </>
          ) : engine === "booting" || registeredZk === undefined ? (
            <Box sx={{ display: "inline-flex", alignItems: "center", gap: 1, opacity: 0.7 }}>
              <CircularProgress size={14} />
              <Typography variant="body2" sx={{ fontSize: "0.72rem", letterSpacing: "0.08em" }}>
                {engine === "booting" ? `connecting to ${proto}…` : "checking your account…"}
              </Typography>
            </Box>
          ) : (
            /* engine is up AND registration resolved → safe to enable/unlock */
            <>
              <Typography variant="body2" sx={{ fontSize: "0.78rem", lineHeight: 1.7, opacity: 0.75, mb: 3 }}>
                {registered
                  ? `Your shielded account is registered. Unlock it with your passkey to see your balance and operate through ${proto} pool.`
                  : `Enable your shielded account to send and receive privately through ${proto} pool. One tap derives your private identity — nothing leaves your device.`}
              </Typography>

              <Button
                variant="contained"
                color="primary"
                fullWidth
                disabled={working}
                onClick={unlock}
                startIcon={working ? <CircularProgress size={14} /> : undefined}
              >
                {btnLabel}
              </Button>
              {error && (
                <Typography color="error" sx={{ fontSize: "0.64rem", mt: 1.5, letterSpacing: "0.04em" }}>
                  {error}
                </Typography>
              )}
            </>
          )}
        </Box>
      ) : (
        /* ── UNLOCKED: operational UI ── */
        <>
          {/* shielded balance (click freed — copy lives on the Receive card now) */}
          <Typography
            variant="h2"
            sx={{ fontSize: "2.6rem", color: "text.primary", mt: 1, userSelect: "none" }}
          >
            {hideBalance ? <GlitchText length={7} /> : fmtCompact(spendable, decimals)}{" "}
            <Box component="span" sx={{ color: "primary.main" }}>{symbol}</Box>
          </Typography>

          <Box sx={{ display: "inline-flex", alignItems: "center", gap: 0.5, mt: 0.5 }}>
            <Typography
              variant="body2"
              sx={{ fontSize: "0.7rem", opacity: 0.55, letterSpacing: "0.08em" }}
            >
              shielded balance
            </Typography>
            <IconButton
              onClick={toggleHideBalance}
              size="small"
              aria-label={hideBalance ? "Show balance" : "Hide balance"}
              title={hideBalance ? "Show balance" : "Hide balance"}
              sx={{ p: 0.25 }}
            >
              {hideBalance ? <VisibilityOffIcon sx={{ fontSize: "0.95rem" }} /> : <VisibilityIcon sx={{ fontSize: "0.95rem" }} />}
            </IconButton>
          </Box>

          {/* "validating in the background" — only when something is pending POI. */}
          {pending > 0n && (
            <Box sx={{ mt: 2.5 }}>
              <Box
                sx={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 1,
                  px: 1.5,
                  py: 0.5,
                  border: "1px solid",
                  borderColor: "divider",
                  borderRadius: "2px",
                }}
              >
                <Box
                  sx={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    bgcolor: "primary.main",
                    animation: "r1doPulse 1.6s ease-in-out infinite",
                  }}
                />
                <Typography variant="body2" sx={{ fontSize: "0.68rem", letterSpacing: "0.1em" }}>
                  {hideBalance ? <GlitchText length={4} /> : fmtCompact(pending, decimals)} {symbol} validating
                </Typography>
              </Box>
            </Box>
          )}

          {/* finalizing: SEPARATE badge — shows "stay on this screen" and switches
              to "generating proof… %" while a proof is actively generating. */}
          {(poolActivity.finalizing || pending > 0n) && (
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                gap: 1,
                mt: 1.5,
                mx: "auto",
                maxWidth: 360,
                px: 1.5,
                py: 1,
                border: "1px solid",
                borderColor: "primary.main",
                borderRadius: "2px",
              }}
            >
              <Box
                sx={{
                  width: 6,
                  height: 6,
                  borderRadius: "50%",
                  bgcolor: "primary.main",
                  animation: "r1doPulse 1.6s ease-in-out infinite",
                  flexShrink: 0,
                }}
              />
              <Typography variant="body2" sx={{ fontSize: "0.62rem", letterSpacing: "0.03em", textAlign: "left", lineHeight: 1.5 }}>
                {poolActivity.generatingProof
                  ? `Generating proof… ${poolActivity.proofProgress}%. Keep this screen open to finish now.`
                  : "Finalizing your private transfer — stay on this screen so it completes now. If you leave, no worries: it resumes next time you unlock your private balance."}
              </Typography>
            </Box>
          )}

          {/* actions — Deposit (shield) is live; Send/Withdraw still mockup */}
          <Stack spacing={1.25} sx={{ mt: 3, maxWidth: 360, mx: "auto" }}>
            {depositOpen ? (
              /* Deposit = pick a source coin (here: your public balance) → amount in {symbol} */
              <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: "2px", p: 1.5, textAlign: "left" }}>
                <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1.25 }}>
                  <Typography variant="body2" sx={{ fontSize: "0.62rem", opacity: 0.6, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                    Shield
                  </Typography>
                  <Button
                    variant="text"
                    color="primary"
                    onClick={() => setDepositOpen(false)}
                    disabled={shielding}
                    sx={{ minWidth: 0, px: 1, fontSize: "0.9rem", lineHeight: 1 }}
                    aria-label="Cancel shield"
                  >
                    ✕
                  </Button>
                </Box>

                {/* Advanced switch (privacy only): off = by amount (seamless),
                    on = coin-control (pick specific stealth UTXOs) */}
                {isPrivacy && (
                  <FormControlLabel
                    sx={{ ml: 0, mb: 1 }}
                    control={
                      <Switch
                        size="small"
                        checked={coinMode === "coins"}
                        disabled={shielding}
                        onChange={(e) => (e.target.checked ? enterCoinMode() : setCoinMode("amount"))}
                      />
                    }
                    label={
                      <Typography variant="body2" sx={{ fontSize: "0.62rem", opacity: 0.7, letterSpacing: "0.06em" }}>
                        Advanced · choose coins
                      </Typography>
                    }
                  />
                )}

                {isPrivacy && coinMode === "coins" ? (
                  /* ── coin-control: pick specific stealth UTXOs (shielded whole) ── */
                  <>
                    {coins === null ? (
                      <Box sx={{ display: "inline-flex", alignItems: "center", gap: 1, opacity: 0.7, my: 1.5 }}>
                        <CircularProgress size={14} />
                        <Typography variant="body2" sx={{ fontSize: "0.66rem" }}>loading your coins…</Typography>
                      </Box>
                    ) : coins.length === 0 ? (
                      <Typography variant="body2" sx={{ fontSize: "0.7rem", opacity: 0.6, my: 1.5 }}>
                        No stealth coins to shield.
                      </Typography>
                    ) : (
                      <Stack spacing={0.75} sx={{ mb: 1.25, maxHeight: 220, overflowY: "auto" }}>
                        {coins.map((c) => {
                          const sel = selectedCoins.has(c.utxo.stealthAddress);
                          return (
                            <Paper
                              key={c.utxo.stealthAddress}
                              elevation={0}
                              onClick={() => !shielding && toggleCoin(c.utxo.stealthAddress)}
                              sx={{
                                p: 1,
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "space-between",
                                cursor: "pointer",
                                border: "1px solid",
                                borderColor: sel ? "primary.main" : "divider",
                                bgcolor: sel ? "rgba(91,141,184,0.08)" : "transparent",
                              }}
                            >
                              <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                                <Box
                                  sx={{
                                    width: 14,
                                    height: 14,
                                    borderRadius: "2px",
                                    border: "1px solid",
                                    borderColor: "primary.main",
                                    display: "flex",
                                    alignItems: "center",
                                    justifyContent: "center",
                                    fontSize: "0.6rem",
                                    lineHeight: 1,
                                    bgcolor: sel ? "primary.main" : "transparent",
                                    color: "#0C0D0F",
                                  }}
                                >
                                  {sel ? "✓" : ""}
                                </Box>
                                <Typography sx={{ fontFamily: "var(--font-geist-mono), monospace", fontSize: "0.64rem", opacity: 0.8 }}>
                                  {c.utxo.stealthAddress.slice(0, 6)}…{c.utxo.stealthAddress.slice(-4)}
                                </Typography>
                              </Box>
                              <Typography variant="body2" sx={{ fontSize: "0.68rem", fontWeight: 700 }}>
                                {fmt(c.balance, decimals)} {symbol}
                              </Typography>
                            </Paper>
                          );
                        })}
                      </Stack>
                    )}

                    <Button
                      variant="contained"
                      color="primary"
                      fullWidth
                      onClick={doShieldCoins}
                      disabled={shielding || selectedCoins.size === 0}
                      startIcon={shielding ? <CircularProgress size={14} /> : undefined}
                    >
                      {shielding
                        ? "shielding…"
                        : selectedCoins.size === 0
                          ? "Select coins to shield"
                          : `Shield ${selectedCoins.size} coin${selectedCoins.size > 1 ? "s" : ""} · ${fmt(selectedTotal, decimals)} ${symbol}`}
                    </Button>
                  </>
                ) : (
                  /* ── by amount (seamless) ── */
                  <>
                    {/* source coin: stealth total (privacy) or public balance */}
                    <Paper
                      elevation={0}
                      sx={{ p: 1, mb: 1.25, display: "flex", alignItems: "center", justifyContent: "space-between", border: "1px solid", borderColor: "primary.main" }}
                    >
                      <Typography variant="body2" sx={{ fontSize: "0.66rem", opacity: 0.8 }}>
                        {isPrivacy ? "Private balance" : "Public balance"}
                      </Typography>
                      <Typography variant="body2" sx={{ fontSize: "0.72rem", fontWeight: 700 }}>
                        {sourceBalance == null ? "…" : `${fmt(sourceBalance, decimals)} ${symbol}`}
                      </Typography>
                    </Paper>

                    {isPrivacy && (
                      <Typography variant="body2" sx={{ fontSize: "0.58rem", opacity: 0.5, mb: 1, lineHeight: 1.5 }}>
                        Shielded straight from your stealth balance — each coin from its own
                        one-time address, unlinkable.
                      </Typography>
                    )}

                    <TextField
                      fullWidth
                      size="small"
                      type="number"
                      placeholder="0"
                      label={`Amount (${symbol})`}
                      value={depositAmt}
                      onChange={(e) => setDepositAmt(e.target.value)}
                      disabled={shielding}
                      InputProps={{
                        endAdornment: (
                          <Button
                            variant="text"
                            color="primary"
                            size="small"
                            disabled={shielding || sourceBalance == null}
                            onClick={() => sourceBalance != null && setDepositAmt(formatUnits(sourceBalance, decimals))}
                            sx={{ minWidth: 0, px: 1, fontSize: "0.7rem" }}
                          >
                            MAX
                          </Button>
                        ),
                      }}
                      sx={{ mb: 0.5 }}
                    />

                    <FormControlLabel
                      control={
                        <Switch
                          size="small"
                          checked={shieldExact}
                          onChange={(e) => setShieldExact(e.target.checked)}
                          disabled={shielding}
                        />
                      }
                      label="Receive the exact amount (cover the fee)"
                      sx={{ ".MuiFormControlLabel-label": { fontSize: "0.62rem", opacity: 0.7 }, mb: 0.5 }}
                    />

                    <Typography variant="body2" sx={{ fontSize: "0.58rem", opacity: 0.5, mb: 1.25, lineHeight: 1.5 }}>
                      {shieldPreview ? (
                        <>
                          {proto} fee {fees.shieldBps / 100}% · moves {fmt(shieldPreview.moves, decimals)} {symbol} →
                          pool gets {fmt(shieldPreview.receive, decimals)} {symbol}
                          {shieldExact && shieldPreview.forcedGross ? " · capped to your balance (fee not covered)" : ""}
                        </>
                      ) : (
                        <>{proto} charges a {fees.shieldBps / 100}% fee on each shield.</>
                      )}
                    </Typography>

                    <Button
                      variant="contained"
                      color="primary"
                      fullWidth
                      onClick={doShield}
                      disabled={shielding}
                      startIcon={shielding ? <CircularProgress size={14} /> : undefined}
                    >
                      {shielding ? "shielding…" : "Confirm shield"}
                    </Button>
                  </>
                )}
              </Box>
            ) : sendOpen ? (
              /* ── Send private (0zk → 0zk) — wizard ── */
              <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: "2px", p: 1.5, textAlign: "left" }}>
                <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1.25 }}>
                  <Typography variant="body2" sx={{ fontSize: "0.62rem", opacity: 0.6, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                    Send private
                  </Typography>
                  <Button
                    variant="text"
                    color="primary"
                    onClick={() => setSendOpen(false)}
                    disabled={sendBusy}
                    sx={{ minWidth: 0, px: 1, fontSize: "0.9rem", lineHeight: 1 }}
                    aria-label="Cancel send"
                  >
                    ✕
                  </Button>
                </Box>

                {/* step indicator */}
                <Stack direction="row" spacing={1} sx={{ alignItems: "center", justifyContent: "center", mb: 1.5 }}>
                  {(["Recipient", "Amount", "Review"] as const).map((label, i) => {
                    const n = (i + 1) as 1 | 2 | 3;
                    const active = sendStep === n;
                    const done = sendStep > n;
                    return (
                      <Box key={label} sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                        {i > 0 && <Box sx={{ width: 14, height: "1px", bgcolor: "text.secondary", opacity: 0.4 }} />}
                        <Typography
                          variant="caption"
                          sx={{
                            fontSize: "0.62rem",
                            letterSpacing: "0.04em",
                            color: active ? "primary.main" : "text.secondary",
                            opacity: active ? 1 : done ? 0.8 : 0.45,
                            fontWeight: active ? 700 : 400,
                          }}
                        >
                          {done ? "✓ " : `${n}. `}
                          {label}
                        </Typography>
                      </Box>
                    );
                  })}
                </Stack>

                {/* STEP 1 — Recipient */}
                {sendStep === 1 && (
                  <>
                    <TextField
                      fullWidth
                      size="small"
                      placeholder="username or 0zk…"
                      label="To"
                      value={sendTo}
                      onChange={(e) => {
                        setSendTo(e.target.value);
                        setSendToZk("");
                        setSendResolveError("");
                      }}
                      disabled={sendResolving}
                      error={!!sendResolveError}
                      helperText={sendResolveError || undefined}
                      InputProps={{
                        endAdornment: (
                          <IconButton
                            size="small"
                            onClick={() => setScanning(true)}
                            disabled={sendResolving}
                            aria-label="Scan a QR address"
                            title="Scan a QR address"
                            sx={{ p: 0.5 }}
                          >
                            <QrCodeScannerIcon sx={{ fontSize: "1.1rem" }} />
                          </IconButton>
                        ),
                      }}
                      sx={{ mb: 1.5 }}
                    />
                    <Button
                      variant="contained"
                      color="primary"
                      fullWidth
                      onClick={continueSendRecipient}
                      disabled={sendResolving || !sendTo.trim()}
                      startIcon={sendResolving ? <CircularProgress size={14} /> : undefined}
                    >
                      {sendResolving ? "Resolving…" : "Continue"}
                    </Button>
                  </>
                )}

                {/* STEP 2 — Amount */}
                {sendStep === 2 && (
                  <>
                    <Typography variant="body2" sx={{ fontSize: "0.62rem", opacity: 0.7, mb: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      To {sendDisplay}
                    </Typography>
                    <TextField
                      fullWidth
                      size="small"
                      type="number"
                      placeholder="0"
                      label={`Amount (${symbol})`}
                      value={sendAmt}
                      onChange={(e) => setSendAmt(e.target.value)}
                      sx={{ mb: 0.5 }}
                    />
                    <Box sx={{ px: 0.5 }}>
                      <Slider
                        value={sendPct}
                        onChange={(_, v) => setSendPct(v as number)}
                        disabled={spendable <= 0n}
                        marks={[0, 25, 50, 75, 100].map((v) => ({ value: v }))}
                        step={1}
                        min={0}
                        max={100}
                        size="small"
                        sx={{ color: "primary.main" }}
                      />
                      <Stack direction="row" spacing={1} sx={{ justifyContent: "space-between", mt: 0.25 }}>
                        {[25, 50, 75, 100].map((p) => (
                          <Button
                            key={p}
                            variant="text"
                            size="small"
                            onClick={() => setSendPct(p)}
                            disabled={spendable <= 0n}
                            sx={{ minWidth: 0, px: 1, fontSize: "0.7rem", flex: 1 }}
                          >
                            {p === 100 ? "MAX" : `${p}%`}
                          </Button>
                        ))}
                      </Stack>
                    </Box>
                    <Typography variant="body2" sx={{ fontSize: "0.58rem", color: sendOver ? "error.main" : "text.secondary", opacity: sendOver ? 1 : 0.6, mt: 0.75, mb: 1.25, lineHeight: 1.5 }}>
                      Spendable: {fmt(spendable, decimals)} {symbol}. First send downloads ~50MB (one-time).
                    </Typography>
                    <Button
                      variant="contained"
                      color="primary"
                      fullWidth
                      onClick={() => setSendStep(3)}
                      disabled={!sendAmtValid}
                      sx={{ mb: 0.75 }}
                    >
                      {sendOver ? "Exceeds balance" : "Review"}
                    </Button>
                    <Button variant="text" color="primary" fullWidth onClick={() => setSendStep(1)} sx={{ fontSize: "0.8rem" }}>
                      ‹ Back
                    </Button>
                  </>
                )}

                {/* STEP 3 — Review */}
                {sendStep === 3 && (
                  <>
                    <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: "2px", p: 1.25, mb: 1.25 }}>
                      {[
                        ["To", sendDisplay],
                        ["Amount", `${sendAmtDisplay} ${symbol}`],
                        ["Type", `Private · ${proto}`],
                        ["Fee", "Free · gas sponsored"],
                      ].map(([label, value], idx, arr) => (
                        <Box
                          key={label}
                          sx={{
                            display: "flex",
                            justifyContent: "space-between",
                            gap: 1,
                            py: 0.75,
                            borderBottom: idx < arr.length - 1 ? "1px solid" : "none",
                            borderColor: "divider",
                          }}
                        >
                          <Typography variant="body2" sx={{ fontSize: "0.62rem", opacity: 0.6 }}>
                            {label}
                          </Typography>
                          <Typography variant="body2" sx={{ fontSize: "0.62rem", textAlign: "right", wordBreak: "break-word" }}>
                            {value}
                          </Typography>
                        </Box>
                      ))}
                    </Box>
                    <Button
                      variant="contained"
                      color="primary"
                      fullWidth
                      onClick={doSend}
                      disabled={sendBusy}
                      startIcon={sendBusy ? <CircularProgress size={14} /> : undefined}
                      sx={{ mb: 0.75 }}
                    >
                      {sendBusy ? sendLabel : "Confirm & Send"}
                    </Button>
                    <Button variant="text" color="primary" fullWidth onClick={() => setSendStep(2)} disabled={sendBusy} sx={{ fontSize: "0.8rem" }}>
                      ‹ Back
                    </Button>
                  </>
                )}
              </Box>
            ) : unshieldOpen ? (
              /* ── Unshield (0zk → public address) ── */
              <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: "2px", p: 1.5, textAlign: "left" }}>
                <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1.25 }}>
                  <Typography variant="body2" sx={{ fontSize: "0.62rem", opacity: 0.6, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                    Unshield
                  </Typography>
                  <Button
                    variant="text"
                    color="primary"
                    onClick={() => setUnshieldOpen(false)}
                    disabled={unshieldBusy}
                    sx={{ minWidth: 0, px: 1, fontSize: "0.9rem", lineHeight: 1 }}
                    aria-label="Cancel unshield"
                  >
                    ✕
                  </Button>
                </Box>

                <TextField
                  fullWidth
                  size="small"
                  placeholder="0x…"
                  label={isPrivacy ? "To address (fresh stealth)" : "To address"}
                  value={unshieldTo}
                  onChange={(e) => setUnshieldTo(e.target.value)}
                  disabled={unshieldBusy}
                  sx={{ mb: 0.75 }}
                />

                <Typography variant="body2" sx={{ fontSize: "0.58rem", opacity: 0.5, mb: unshieldToSelfStealth ? 0.5 : 1.25, lineHeight: 1.5 }}>
                  {isPrivacy
                    ? "Goes to a brand-new one-time stealth address you own — unlinkable. Edit to send anywhere."
                    : "Defaults to your own Safe. Sending to a fresh address you control breaks the link to your public identity — better privacy."}
                </Typography>

                {unshieldToSelfStealth && (
                  <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, mb: 1.25 }}>
                    <FormControlLabel
                      control={
                        <Switch
                          size="small"
                          checked={unshieldAnnounce}
                          onChange={(e) => setUnshieldAnnounce(e.target.checked)}
                          disabled={unshieldBusy}
                        />
                      }
                      label={unshieldAnnounce ? "Announce on-chain" : "Ghost mode"}
                      sx={{ ".MuiFormControlLabel-label": { fontSize: "0.62rem", opacity: 0.7 }, mr: 0.25 }}
                    />
                    <IconButton
                      size="small"
                      onClick={(e) => setInfoAnchor(e.currentTarget)}
                      sx={{
                        p: 0.25,
                        color: (theme) =>
                          theme.palette.mode === "dark" ? "#fff" : "inherit",
                      }}
                      aria-label="More info"
                    >
                      <InfoOutlinedIcon fontSize="small" />
                    </IconButton>
                    <Popover
                      open={Boolean(infoAnchor)}
                      anchorEl={infoAnchor}
                      onClose={() => setInfoAnchor(null)}
                      anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
                    >
                      <Box
                        p={2}
                        maxWidth={250}
                        sx={{
                          fontSize: "0.7rem",
                          lineHeight: 1.5,
                          backgroundColor: (theme) =>
                            theme.palette.mode === "dark" ? "#222" : "#3B3B3B",
                          color: "#fff",
                        }}
                      >
                        <b>On — Announce:</b> publishes a one-time pointer on-chain so this payment is
                        <b> 100% always recoverable</b> by scanning, on any device.
                        <br />
                        <br />
                        <b>Off — Ghost:</b> nothing is published — <b>maximum privacy</b>, hardest to
                        detect — but it&apos;s spendable <b>only from this device</b>. Clear this browser&apos;s
                        data and it&apos;s gone.
                      </Box>
                    </Popover>
                  </Box>
                )}

                <TextField
                  fullWidth
                  size="small"
                  type="number"
                  placeholder="0"
                  label={`Amount (${symbol})`}
                  value={unshieldAmt}
                  onChange={(e) => setUnshieldAmt(e.target.value)}
                  disabled={unshieldBusy}
                  InputProps={{
                    endAdornment: (
                      <Button
                        variant="text"
                        color="primary"
                        size="small"
                        disabled={unshieldBusy}
                        onClick={() => setUnshieldAmt(formatUnits(spendable, decimals))}
                        sx={{ minWidth: 0, px: 1, fontSize: "0.7rem" }}
                      >
                        MAX
                      </Button>
                    ),
                  }}
                  sx={{ mb: 0.5 }}
                />

                <FormControlLabel
                  control={
                    <Switch
                      size="small"
                      checked={unshieldExact}
                      onChange={(e) => setUnshieldExact(e.target.checked)}
                      disabled={unshieldBusy}
                    />
                  }
                  label="Receive the exact amount (cover the fee)"
                  sx={{ ".MuiFormControlLabel-label": { fontSize: "0.62rem", opacity: 0.7 }, mb: 0.5 }}
                />

                <Typography variant="body2" sx={{ fontSize: "0.58rem", opacity: 0.5, mb: 1.25, lineHeight: 1.5 }}>
                  {unshieldPreview ? (
                    <>
                      {proto} fee {fees.unshieldBps / 100}% · unshields {fmt(unshieldPreview.moves, decimals)} {symbol} →
                      you receive {fmt(unshieldPreview.receive, decimals)} {symbol}
                      {unshieldExact && unshieldPreview.forcedGross ? " · capped to spendable (fee not covered)" : ""}
                      . Funds land on confirmation; the POI finalizes in the background.
                    </>
                  ) : (
                    <>{proto} charges a {fees.unshieldBps / 100}% fee. Funds land on confirmation; the POI finalizes in the background.</>
                  )}
                </Typography>

                <Button
                  variant="contained"
                  color="primary"
                  fullWidth
                  onClick={doUnshield}
                  disabled={unshieldBusy}
                  startIcon={unshieldBusy ? <CircularProgress size={14} /> : undefined}
                >
                  {unshieldLabel}
                </Button>
              </Box>
            ) : (
              /* ── idle: Receive privately (your 0zk QR) — fills the space the
                   public side gives to Recent Transactions ── */
              <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: "2px", p: 2, textAlign: "center" }}>
                <Typography sx={{ fontSize: "0.62rem", opacity: 0.6, letterSpacing: "0.1em", textTransform: "uppercase", mb: 1.5 }}>
                  Receive privately
                </Typography>
                <Box sx={{ display: "flex", justifyContent: "center", mb: 1.5 }}>
                  <QrCode value={zk} size={196} />
                </Box>
                <Typography variant="body2" sx={{ fontSize: "0.62rem", opacity: 0.55, lineHeight: 1.6, mb: 1.25 }}>
                  Share your 0zk to receive a private transfer.
                </Typography>
                <Box
                  onClick={copyZk}
                  title="Tap to copy your 0zk"
                  sx={{
                    border: "1px solid",
                    borderColor: zkCopied ? "success.main" : "divider",
                    borderRadius: "2px",
                    px: 1.25,
                    py: 1,
                    cursor: "pointer",
                    transition: "border-color 0.15s",
                    "&:hover": { borderColor: "primary.main" },
                  }}
                >
                  <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1, mb: 0.5 }}>
                    <Typography sx={{ fontSize: "0.58rem", opacity: 0.6, letterSpacing: "0.08em", textTransform: "uppercase" }}>
                      Your 0zk
                    </Typography>
                    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, color: zkCopied ? "success.main" : "primary.main" }}>
                      {zkCopied ? <CheckIcon sx={{ fontSize: "0.85rem" }} /> : <ContentCopyIcon sx={{ fontSize: "0.85rem" }} />}
                      <Typography sx={{ fontSize: "0.62rem", letterSpacing: "0.04em" }}>
                        {zkCopied ? "copied" : "copy"}
                      </Typography>
                    </Box>
                  </Box>
                  <Typography sx={{ fontFamily: "var(--font-geist-mono), monospace", fontSize: "0.66rem", wordBreak: "break-all", lineHeight: 1.5, textAlign: "left" }}>
                    {zk}
                  </Typography>
                </Box>
              </Box>
            )}
          </Stack>

          {/* Fixed bottom action bar (shadow world). Hidden while a form is open
              so the form has full room — mirrors the public side's sub-views. */}
          {!(depositOpen || sendOpen || unshieldOpen) && (
            <Box
              sx={{
                position: "fixed",
                bottom: 0,
                left: 0,
                right: 0,
                zIndex: 1100,
                bgcolor: "background.default",
                borderTop: "1px solid",
                borderColor: "divider",
                pb: "env(safe-area-inset-bottom)",
              }}
            >
              <Stack direction="row" sx={{ width: "100%", maxWidth: 460, mx: "auto" }}>
                {[
                  { key: "shield", glyph: "☗", label: "Shield", onClick: openDeposit },
                  { key: "transfer", glyph: "⇄", label: "Transfer", onClick: openSend },
                  { key: "unshield", glyph: "☖", label: "Unshield", onClick: openUnshield },
                ].map((slot) => (
                  <Button
                    key={slot.key}
                    onClick={slot.onClick}
                    sx={{
                      flex: 1,
                      minWidth: 0,
                      flexDirection: "column",
                      gap: 0.25,
                      py: 1.25,
                      borderRadius: 0,
                      color: "text.primary",
                    }}
                  >
                    <Box component="span" sx={{ fontSize: "1.2rem", lineHeight: 1 }}>{slot.glyph}</Box>
                    <Typography sx={{ fontSize: "0.6rem", letterSpacing: "0.08em", textTransform: "uppercase" }}>
                      {slot.label}
                    </Typography>
                  </Button>
                ))}
              </Stack>
            </Box>
          )}
        </>
      )}

      <Snackbar
        open={!!toast}
        autoHideDuration={5000}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        {toast ? (
          <Alert variant="filled" severity={toast.sev} onClose={() => setToast(null)}>
            {toast.msg}
          </Alert>
        ) : undefined}
      </Snackbar>
    </Box>
  );
}
