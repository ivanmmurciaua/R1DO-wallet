import { Safe4337Pack } from "@safe-global/relay-kit";
import { useEffect, useState } from "react";
import { CircularProgress } from "@mui/material";
import { formatUnits, createPublicClient } from "viem";
import { activeChain } from "@/lib/networks";
import { getStealthBalances } from "@/lib/balances";
import { sepoliaTransport } from "@/app/constants";
import { Settings } from "./Settings";
import { UserMenu } from "./UserMenu";
import { getDecimals, getSymbol, getWalletMeta, getSpendableUTXOs, applyStealthCleanup, DEFAULT_DECIMALS, DEFAULT_SYMBOL } from "@/lib/localstorage";
import { useScanning } from "@/lib/scanState";

type props = {
  username: string;
  wallet: Safe4337Pack;
  address: string;
};

export default function AccountDetails({ username, wallet, address }: props) {
  const [decimals, setDecimals] = useState<number>(DEFAULT_DECIMALS);
  const [symbol, setSymbol] = useState<string>(DEFAULT_SYMBOL);
  const [isLoaded, setLoaded] = useState(false);
  const [userBalance, setBalance] = useState<number>(0.0);
  const [stealthTotal, setStealthTotal] = useState<number>(0.0);
  const privacy = getWalletMeta(username)?.privacy ?? false;
  const scanning = useScanning();

  const publicClient = createPublicClient({ chain: activeChain(), transport: sepoliaTransport() });

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
      const utxos = getSpendableUTXOs(username).filter((u) => !u.asset); // native headline
      if (utxos.length === 0) return;

      const raws = await getStealthBalances(publicClient, utxos.map((u) => u.stealthAddress));
      const balances = raws.map((raw) => parseFloat(parseFloat(formatUnits(raw, decimals)).toFixed(4)));

      // Tombstone any native address that reads 0 — it drops out of future reads
      // (the multicall above shrinks over time). Confirmed 0 only: a thrown read
      // never reaches here. TEMP backlog sweep: tombstone even without a prior
      // receivedAt (cleans up addresses spent before tombstoning existed), except
      // a Courier receive still awaiting funds (localOnly + never funded = pending).
      utxos.forEach((u, i) => {
        if (raws[i] === 0n && !(u.localOnly && !u.receivedAt)) applyStealthCleanup(username, u.stealthAddress);
      });

      if (!mounted) return;
      setStealthTotal(balances.reduce((sum, b) => sum + b, 0));
    };

    fetchStealthBalances();
    const id = setInterval(fetchStealthBalances, 15000);
    return () => { mounted = false; clearInterval(id); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [privacy, username, decimals]);

  return isLoaded && decimals > 0 ? (
    <div>
      {scanning && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 8,
            fontFamily: "var(--font-geist-mono), monospace",
            fontSize: "0.72rem",
            opacity: 0.7,
            marginBottom: 16,
          }}
        >
          <CircularProgress size={12} />
          <span>Scanning the chain for your private payments…</span>
        </div>
      )}
      <div style={{ textAlign: "center" }}>
        <div>
          {userBalance + stealthTotal > 0.0 ? (
            <div>
              <UserMenu wallet={wallet} username={username} balance={userBalance + stealthTotal} address={address} />
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
            </div>
          )}
        </div>
      </div>
      <Settings privacy={privacy} username={username} />
    </div>
  ) : (
    <CircularProgress size={50} sx={{ alignItems: "center", mb: 2, mt: 3 }} />
  );
}
