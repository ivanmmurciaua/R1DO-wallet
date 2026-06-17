import { Safe4337Pack } from "@safe-global/relay-kit";
import { useEffect, useState } from "react";
import { Snackbar, Alert, CircularProgress } from "@mui/material";
import { formatUnits, createPublicClient } from "viem";
import { sepolia } from "viem/chains";
import { sepoliaTransport } from "@/app/constants";
import { Settings } from "./Settings";
import { UserMenu } from "./UserMenu";
import { getDecimals, getSymbol, getWalletMeta, getStealthUTXOs, getMetaAddress } from "@/lib/localstorage";

type props = {
  username: string;
  wallet: Safe4337Pack;
  address: string;
};

const COMPACT_BALANCE_THRESHOLD = 100_000;
const compactFormatter = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 2 });

const formatBalance = (value: number): string => {
  if (Math.abs(value) >= COMPACT_BALANCE_THRESHOLD) {
    return compactFormatter.format(value);
  }
  return parseFloat(value.toFixed(4)).toString();
};

export default function AccountDetails({ username, wallet, address }: props) {
  const [decimals, setDecimals] = useState<number>(13);
  const [symbol, setSymbol] = useState<string>("⧫");
  const [isLoaded, setLoaded] = useState(false);
  const [userBalance, setBalance] = useState<number>(0.0);
  const [stealthTotal, setStealthTotal] = useState<number>(0.0);
  const [showCopySuccess, setShowCopySuccess] = useState(false);
  const [copyWarning, setCopyWarning] = useState(false);

  const privacy = getWalletMeta(username)?.privacy ?? false;

  const publicClient = createPublicClient({ chain: sepolia, transport: sepoliaTransport() });

  useEffect(() => {
    if (!wallet) return;
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
  }, [wallet, isLoaded, decimals]);

  useEffect(() => {
    setDecimals(getDecimals());
    setSymbol(getSymbol());
  }, []);

  useEffect(() => {
    if (!privacy) return;
    let mounted = true;

    const fetchStealthBalances = async () => {
      const utxos = getStealthUTXOs(username);
      if (utxos.length === 0) return;

      const balances = await Promise.all(
        utxos.map(async (utxo) => {
          const raw = await publicClient.getBalance({ address: utxo.stealthAddress });
          return parseFloat(parseFloat(formatUnits(raw, decimals)).toFixed(4));
        }),
      );

      if (!mounted) return;
      setStealthTotal(balances.reduce((sum, b) => sum + b, 0));
    };

    fetchStealthBalances();
    const id = setInterval(fetchStealthBalances, 15000);
    return () => { mounted = false; clearInterval(id); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [privacy, username, decimals]);

  const handleCopyAddress = async () => {
    if (privacy) {
      // Δ1: in privacy mode the shareable identifier is the meta-address —
      // public data, distributed off-chain (no registry).
      const meta = getMetaAddress(username);
      if (!meta) {
        setCopyWarning(true);
        return;
      }
      try {
        await navigator.clipboard.writeText(meta);
        setShowCopySuccess(true);
      } catch (err) {
        console.error("Failed to copy meta-address:", err);
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(address);
      setShowCopySuccess(true);
    } catch (err) {
      console.error("Failed to copy:", err);
      const textArea = document.createElement("textarea");
      textArea.value = address;
      document.body.appendChild(textArea);
      textArea.focus();
      textArea.select();
      try {
        document.execCommand("copy");
        setShowCopySuccess(true);
      } catch { /* ignore */ }
      document.body.removeChild(textArea);
    }
  };

  return isLoaded && decimals > 0 ? (
    <div>
      {/*<h2>👋 Welcome back {username}!</h2>*/}
      <div style={{ textAlign: "center" }}>
        <h2
          onClick={handleCopyAddress}
          style={{
            cursor: "pointer",
            userSelect: "none",
            transition: "transform 0.1s ease",
          }}
          onMouseDown={(e) => (e.currentTarget.style.transform = "scale(0.95)")}
          onMouseUp={(e) => (e.currentTarget.style.transform = "scale(1)")}
          onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
          title={
            Math.abs(userBalance + stealthTotal) >= COMPACT_BALANCE_THRESHOLD
              ? `${(userBalance + stealthTotal).toFixed(4)} ${symbol} — click to copy address`
              : "Click to copy address"
          }
        >
          {formatBalance(userBalance + stealthTotal)} {symbol}
        </h2>
        <br />
        <div style={{ marginTop: "11px" }}>
          {userBalance + stealthTotal > 0.0 ? (
            <div>
              <UserMenu wallet={wallet} username={username} balance={userBalance + stealthTotal} />
            </div>
          ) : (
            <div
              style={{
                fontFamily: "var(--font-geist-mono), monospace",
                fontSize: "0.8rem",
                lineHeight: 1.7,
                opacity: 0.75,
                maxWidth: 320,
                margin: "0 auto",
              }}
            >
              <p style={{ letterSpacing: "0.04em" }}>No balance yet.</p>
              <p style={{ marginTop: "1rem" }}>Share your username to receive {symbol}:</p>
              <p
                style={{
                  marginTop: "0.5rem",
                  border: "1px solid currentColor",
                  borderRadius: "2px",
                  padding: "6px 12px",
                  display: "inline-block",
                  letterSpacing: "0.06em",
                }}
              >
                {username}
              </p>
              <p style={{ marginTop: "1rem", fontSize: "0.72rem", opacity: 0.7 }}>
                or your address — tap your balance above
              </p>
            </div>
          )}
        </div>
      </div>
      <Settings />

      <Snackbar
        open={showCopySuccess}
        autoHideDuration={2000}
        onClose={() => setShowCopySuccess(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert onClose={() => setShowCopySuccess(false)} severity="success" variant="filled">
          {privacy
            ? "Meta-address copied — share it to receive private payments!"
            : "Address copied to clipboard!"}
        </Alert>
      </Snackbar>

      <Snackbar
        open={copyWarning}
        onClose={(_e, reason) => { if (reason === "clickaway") return; }}
        anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      >
        <Alert
          onClose={() => setCopyWarning(false)}
          severity="error"
          variant="filled"
          sx={{ backgroundColor: "#c0392b" }}
        >
          Your meta-address is not available yet — log in again so it can be derived from your passkey.
        </Alert>
      </Snackbar>
    </div>
  ) : (
    <CircularProgress size={50} sx={{ alignItems: "center", mb: 2, mt: 3 }} />
  );
}
