import type { SafeWallet } from "@/lib/aa-client";
import { useEffect, useState } from "react";
import { CircularProgress } from "@mui/material";
import { formatUnits, createPublicClient } from "viem";
import { activeChain } from "@/lib/networks";
import { getStealthBalances } from "@/lib/balances";
import { sepoliaTransport, DIRECTORY_ADDRESS } from "@/app/constants";
import { directoryEnabled } from "@/lib/registry-v2";
import { Settings } from "./Settings";
import { UserMenu } from "./UserMenu";
import { getDecimals, getWalletMeta, getSpendableUTXOs, applyStealthCleanup, getDirectoryMark, getFindableNudgeDismissed, setFindableNudgeDismissed, DEFAULT_DECIMALS } from "@/lib/localstorage";
import { useScanning, useScanProgress } from "@/lib/scanState";
import { ProgressBar } from "./ProgressBar";

type props = {
  username: string;
  wallet: SafeWallet;
  address: string;
  // Opt-in publish to the encrypted directory (pay-by-username). The only
  // sponsored on-chain action of a fresh wallet — deliberately user-triggered.
  makeFindable: () => Promise<boolean>;
};

export default function AccountDetails({ username, wallet, address, makeFindable }: props) {
  const [decimals, setDecimals] = useState<number>(DEFAULT_DECIMALS);
  const [isLoaded, setLoaded] = useState(false);
  const [userBalance, setBalance] = useState<number>(0.0);
  const [stealthTotal, setStealthTotal] = useState<number>(0.0);
  // symbol lives in UserMenu now (it owns the balance display); AccountDetails
  // no longer renders it directly.
  // Findable = published to the directory (so others can pay by username).
  // Opt-in and non-blocking: the wallet is fully usable without it (Receive
  // shares the address directly). Seeded from the local mark; flips on publish.
  const [findable, setFindable] = useState(
    () => getDirectoryMark(username) === DIRECTORY_ADDRESS,
  );
  const [publishing, setPublishing] = useState(false);
  // The nudge is dismissible (persisted) so it never nags — the action stays
  // available forever from Settings.
  const [nudgeDismissed, setNudgeDismissed] = useState(
    () => getFindableNudgeDismissed(username),
  );
  const privacy = getWalletMeta(username)?.privacy ?? false;
  const scanning = useScanning();
  const scanProgress = useScanProgress();

  const handleMakeFindable = async () => {
    setPublishing(true);
    try {
      if (await makeFindable()) setFindable(true);
    } finally {
      setPublishing(false);
    }
  };

  const dismissNudge = () => {
    setNudgeDismissed(true);
    setFindableNudgeDismissed(username);
  };

  const publicClient = createPublicClient({ chain: activeChain(), transport: sepoliaTransport() });

  // Public balance polling is part of the "normal" balance flow that starts
  // ONLY once the UTXO scan has finished (the `scanning` gate). Running it during
  // the scan would have both hammer the same rate-limited public RPCs — and 429
  // the user's Make-findable publish.
  useEffect(() => {
    if (!wallet || scanning) return;
    let mounted = true;

    const fetchBalance = async () => {
      try {
        const bal = await wallet.protocolKit.getBalance();
        if (!mounted) return;
        setBalance(
          parseFloat(
            parseFloat(formatUnits(BigInt(bal.toString()), decimals)).toFixed(
              2,
            ),
          ),
        );
      } catch (err) {
        console.error("fetchBalance error", err);
      }
      if (!isLoaded) setLoaded(true);
    };

    fetchBalance();
    const id = setInterval(fetchBalance, 7000);

    return () => {
      mounted = false;
      clearInterval(id);
    };
  }, [wallet, isLoaded, decimals, scanning]);

  useEffect(() => {
    setDecimals(getDecimals());
  }, []);

  // Keep the view mounted (showing the "Scanning…" indicator) while the UTXO
  // scan runs, even though balances haven't polled yet — otherwise gating the
  // balance poll on `scanning` would flash a bare spinner first.
  useEffect(() => {
    if (scanning) setLoaded(true);
  }, [scanning]);

  useEffect(() => {
    // Stealth balance analysis reads the UTXOs the scan produces, so it also
    // waits until the scan finishes — both for correctness and to avoid RPC
    // contention with the scan.
    if (!privacy || scanning) return;
    let mounted = true;

    const fetchStealthBalances = async () => {
      const utxos = getSpendableUTXOs(username).filter((u) => !u.asset); // native headline
      if (utxos.length === 0) return;

      const raws = await getStealthBalances(publicClient, utxos.map((u) => u.stealthAddress));
      const balances = raws.map((raw) => parseFloat(parseFloat(formatUnits(raw, decimals)).toFixed(4)));

      // Tombstone a native address that was funded (receivedAt) and now reads 0:
      // it's been spent, so it drops out of future reads. Confirmed 0 only: a
      // thrown read never reaches here. Never funded → leave it (a Courier receive
      // awaiting funds reads 0 too, but that's "pending", not "spent").
      utxos.forEach((u, i) => {
        if (raws[i] === 0n && u.receivedAt) applyStealthCleanup(username, u.stealthAddress);
      });

      if (!mounted) return;
      setStealthTotal(balances.reduce((sum, b) => sum + b, 0));
    };

    fetchStealthBalances();
    const id = setInterval(fetchStealthBalances, 15000);
    return () => { mounted = false; clearInterval(id); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [privacy, username, decimals, scanning]);

  return isLoaded && decimals > 0 ? (
    <div>
      {scanning && (
        <div style={{ marginBottom: 16 }}>
          <ProgressBar
            done={scanProgress?.done ?? 0}
            total={scanProgress?.total ?? 0}
            label="Scanning the chain for your private payments…"
          />
        </div>
      )}
      {/* Findable nudge — opt-in & non-blocking. Becoming findable is the only
          sponsored on-chain action; skip it and the wallet still works (Receive
          shares the address). Hidden once findable or if the directory is off. */}
      {directoryEnabled() && !findable && !nudgeDismissed && (
        <div
          style={{
            position: "relative",
            maxWidth: 400,
            margin: "0 auto 16px",
            border: "1px solid currentColor",
            borderRadius: "2px",
            padding: "14px 16px",
            fontFamily: "var(--font-geist-mono), monospace",
            fontSize: "0.78rem",
            lineHeight: 1.6,
            opacity: 0.9,
            textAlign: "center",
          }}
        >
          <button
            onClick={dismissNudge}
            aria-label="Dismiss"
            title="Dismiss"
            style={{
              position: "absolute",
              top: 4,
              right: 6,
              background: "transparent",
              border: "none",
              color: "inherit",
              opacity: 0.5,
              cursor: "pointer",
              fontSize: "0.95rem",
              lineHeight: 1,
              padding: 4,
            }}
          >
            ✕
          </button>
          <p style={{ letterSpacing: "0.04em" }}>
            Want to be paid by username? Make yourself findable so anyone can
            send to <b>{username}</b>.
          </p>
          <button
            onClick={handleMakeFindable}
            disabled={publishing || scanning}
            style={{
              marginTop: "10px",
              width: "100%",
              padding: "10px 14px",
              fontFamily: "var(--font-geist-mono), monospace",
              fontSize: "0.8rem",
              letterSpacing: "0.06em",
              border: "1px solid currentColor",
              borderRadius: "2px",
              background: "transparent",
              color: "inherit",
              cursor: publishing || scanning ? "default" : "pointer",
              opacity: publishing || scanning ? 0.6 : 1,
            }}
          >
            {scanning
              ? "Finishing scan…"
              : publishing
                ? "Making you findable…"
                : "Make me findable"}
          </button>
          <p style={{ marginTop: "10px", fontSize: "0.68rem", opacity: 0.6 }}>
            Optional & one-time — and you can do it anytime from Settings ⚙.
            Don’t want to? You can still receive: just hit <b>Receive</b> below
            to share your address.
          </p>
        </div>
      )}
      <div style={{ textAlign: "center" }}>
        <UserMenu wallet={wallet} username={username} balance={userBalance + stealthTotal} address={address} />
      </div>
      <Settings
        privacy={privacy}
        username={username}
        findable={findable}
        publishing={publishing}
        scanning={scanning}
        onMakeFindable={directoryEnabled() ? handleMakeFindable : undefined}
      />
    </div>
  ) : (
    <CircularProgress size={50} sx={{ alignItems: "center", mb: 2, mt: 3 }} />
  );
}
