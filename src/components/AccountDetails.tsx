import { Safe4337Pack } from "@safe-global/relay-kit";
import { useEffect, useState } from "react";
import { CircularProgress } from "@mui/material";
import { formatUnits, createPublicClient } from "viem";
import { sepolia } from "viem/chains";
import { sepoliaTransport } from "@/app/constants";
import { Settings } from "./Settings";
import { UserMenu } from "./UserMenu";
import { getDecimals, getSymbol, getWalletMeta, getStealthUTXOs } from "@/lib/localstorage";

type props = {
  username: string;
  wallet: Safe4337Pack;
  address: string;
};

export default function AccountDetails({ username, wallet, address }: props) {
  const [decimals, setDecimals] = useState<number>(13);
  const [symbol, setSymbol] = useState<string>("⧫");
  const [isLoaded, setLoaded] = useState(false);
  const [userBalance, setBalance] = useState<number>(0.0);
  const [stealthTotal, setStealthTotal] = useState<number>(0.0);
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

  return isLoaded && decimals > 0 ? (
    <div>
      {/*<h2>👋 Welcome back {username}!</h2>*/}
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
      <Settings />
    </div>
  ) : (
    <CircularProgress size={50} sx={{ alignItems: "center", mb: 2, mt: 3 }} />
  );
}
