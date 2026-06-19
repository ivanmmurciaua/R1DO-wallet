import React, { useState, useEffect, useCallback } from "react";
import {
  Button,
  Stack,
  Box,
  Typography,
  CircularProgress,
  IconButton,
} from "@mui/material";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import RefreshIcon from "@mui/icons-material/Refresh";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import AddIcon from "@mui/icons-material/Add";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CheckIcon from "@mui/icons-material/Check";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import { SendEth } from "./SendEth";
import { SpendStealthUTXO } from "./SpendStealthUTXO";
import { ReceivePrivate } from "./ReceivePrivate";
import { QrCode } from "./QrCode";
import { GlitchText } from "./GlitchText";
import Popup from "./Popup";
import { Safe4337Pack } from "@safe-global/relay-kit";
import { formatUnits, createPublicClient } from "viem";
import { sepoliaTransport } from "@/app/constants";
import { activeChain, activeChainId, networkName, explorerTxUrl } from "@/lib/networks";
import { getStealthBalances } from "@/lib/balances";
import { getLastBlock } from "@/lib/client";
import { getDecimals, getSymbol, getStealthUTXOs, getWalletMeta, saveStealthScan, getLastScannedBlock, patchStealthUTXO, getHideBalance, setHideBalance } from "@/lib/localstorage";
import { getWalletCredential } from "@/lib/credstore";
import { loadFromDevice } from "@/lib/passkeys";
import { derivePQKeysFromPRF, scanStealthPayments, type StealthUTXO } from "@/lib/stealth";

type UserMenuProps = {
  wallet: Safe4337Pack;
  username: string;
  balance: number;
  address: string; // public Safe address — shown/copied in public Receive
};

type Transaction = {
  id: string;
  type: "sent" | "received" | "private";
  amount: number;
  proportion?: number;
  stealthAddress?: string;
  weiBalance?: bigint; // exact on-chain balance (private/stealth) — spend uses this, not the rounded `amount`
};

type EtherscanTransaction = {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  from: string;
  to: string;
  value: string;
  contractAddress: string;
  input: string;
  type: string;
  gas: string;
  gasUsed: string;
  traceId: string;
  isError: string;
  errCode: string;
};

type EtherscanResponse = {
  status: string;
  message: string;
  result: EtherscanTransaction[];
};

// Compact amount formatter: 2 decimals max, K/M/B for large values
// (11105.76 → "11.11K", 12.34 → "12.34", 1.23e6 → "1.23M").
const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 });
const fmtAmount = (n: number) => compactFmt.format(n);

export const UserMenu: React.FC<UserMenuProps> = ({ wallet, username, balance, address }) => {
  const [showPopup, setShowPopup] = useState(false);
  const [popupMessage, setPopupMessage] = useState("");
  const [currentView, setCurrentView] = useState<"menu" | "sendEth" | "spendUtxo" | "receivePrivate" | "receivePublic">("menu");
  const [copied, setCopied] = useState(false);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [stealthTxs, setStealthTxs] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedUtxo, setSelectedUtxo] = useState<StealthUTXO | null>(null);
  const [selectedBalance, setSelectedBalance] = useState<number>(0);
  const [selectedWei, setSelectedWei] = useState<bigint>(0n);
  const [hideBalance, setHide] = useState<boolean>(() => getHideBalance());

  const toggleHideBalance = () => {
    setHide((h) => {
      const next = !h;
      setHideBalance(next);
      return next;
    });
  };

  const handleShowPopup = (message: string) => {
    setShowPopup(true);
    setPopupMessage(message);
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        setShowPopup(false);
        resolve();
      }, 2000);
    });
  };

  const handleSendEth = () => {
    setCurrentView("sendEth");
  };

  const handleReceive = () => {
    setCurrentView(privacy ? "receivePrivate" : "receivePublic");
  };

const handleBackToMenu = (message: string = "") => {
    if (message !== "") {
      handleShowPopup(message);
    }
    setCurrentView("menu");
  };

  const handleOpenSpend = (transaction: Transaction) => {
    if (transaction.type !== "private" || !transaction.stealthAddress) return;
    const utxo = getStealthUTXOs(username).find((u) => u.stealthAddress === transaction.stealthAddress);
    if (!utxo) return;
    setSelectedUtxo(utxo);
    setSelectedBalance(transaction.amount);
    setSelectedWei(transaction.weiBalance ?? 0n);
    setCurrentView("spendUtxo");
  };

  const privacy = getWalletMeta(username)?.privacy ?? false;
  const symbol = getSymbol();

  // Headline balance for the wallet-home card: stealth total in a privacy wallet
  // (summed from the already-fetched UTXOs — no extra RPC), else the public Safe.
  const shownBalance = privacy
    ? Number(formatUnits(stealthTxs.reduce((s, t) => s + (t.weiBalance ?? 0n), 0n), getDecimals()))
    : balance;

  const fetchTransactions = useCallback(async () => {
    if (privacy) return; // private wallet — no Etherscan
    setLoading(true);
    try {
      const address = await wallet.protocolKit.getAddress();
      const apiKey = process.env.NEXT_PUBLIC_ETHERSCAN_API_KEY;
      const block = await getLastBlock();

      const response = await fetch(
        `https://api.etherscan.io/v2/api?chainid=${activeChainId()}&module=account&action=txlistinternal&address=${address}&startblock=0&endblock=${block}&page=1&offset=10&sort=desc&apikey=${apiKey}`,
      );

      const data: EtherscanResponse = await response.json();

      if (data.status === "1" && data.result) {
        const userAddress = address.toLowerCase();
        const decimals = getDecimals();
        const filteredTransactions = data.result.filter((tx) => tx.type === "call");
        const amounts = filteredTransactions.map((tx) => parseFloat(formatUnits(BigInt(tx.value), decimals)));
        const maxAmount = Math.max(...amounts);
        const minAmount = Math.min(...amounts);

        setTransactions(filteredTransactions.map((tx) => {
          const amount = parseFloat(formatUnits(BigInt(tx.value), decimals));
          const proportion = maxAmount > minAmount
            ? 0.2 + (0.8 * (amount - minAmount)) / (maxAmount - minAmount)
            : 1;
          return {
            id: tx.hash,
            type: tx.from.toLowerCase() === userAddress ? "sent" : "received",
            amount,
            proportion,
          };
        }));
      }
    } catch (error) {
      console.error("Error fetching transactions:", error);
    } finally {
      setLoading(false);
    }
  }, [wallet, privacy]);

  useEffect(() => {
    if (wallet) {
      fetchTransactions();
      const interval = setInterval(fetchTransactions, 90000);
      return () => clearInterval(interval);
    }
  }, [wallet, fetchTransactions]);

  const fetchStealthBalances = useCallback(async () => {
    const utxos = getStealthUTXOs(username);
    if (utxos.length === 0) return;
    const decimals = getDecimals();
    const pub = createPublicClient({ chain: activeChain(), transport: sepoliaTransport() });
    const balances = await getStealthBalances(pub, utxos.map((u) => u.stealthAddress));
    const rows = utxos.map((utxo, i) => {
      const raw = balances[i];
      // Displayed amount is rounded; sub-dust (e.g. 1 wei) rounds to 0 and is
      // treated as "no funds" — both for the list and the received stamp.
      const amount = parseFloat(parseFloat(formatUnits(raw, decimals)).toFixed(4));
      return { utxo, raw, amount };
    });

    // Stamp first-funding once (sequential → no read-modify-write race). This is
    // the persistent "received" signal the ReceivePrivate list reads, so status
    // never needs its own balance fetch.
    for (const { utxo, amount } of rows) {
      if (amount > 0 && !utxo.receivedAt) patchStealthUTXO(username, utxo.stealthAddress, { receivedAt: Date.now() });
    }

    setStealthTxs(
      rows
        .filter((r) => r.amount > 0)
        .map(({ utxo, raw, amount }) => ({
          id: utxo.stealthAddress,
          type: "private" as const,
          amount,
          stealthAddress: utxo.stealthAddress,
          weiBalance: raw, // exact — spend clamps to this, never the rounded `amount`
        })),
    );
  }, [username]);

  const handleBackFromSpend = (message: string = "") => {
    setSelectedUtxo(null);
    handleBackToMenu(message);
    fetchStealthBalances();
  };

  const refreshPrivate = useCallback(async () => {
    const cred = await getWalletCredential(username).catch(() => null);
    if (!cred) return;
    setLoading(true);
    try {
      const prf = await loadFromDevice(cred.rawId);
      if (!prf || prf.length === 0) {
        await fetchStealthBalances();
        return;
      }
      const keys = await derivePQKeysFromPRF(prf);
      const lastBlock = getLastScannedBlock(username);
      const pub = createPublicClient({ chain: activeChain(), transport: sepoliaTransport() });
      const fromBlock = lastBlock ?? (await pub.getBlockNumber() - 21600n);
      const { utxos: newUtxos, latestBlock } = await scanStealthPayments(
        keys.spendingPrivateKey,
        keys.viewingPrivateKey,
        keys.mlkemDecapsKey,
        fromBlock,
      );
      const existing = getStealthUTXOs(username);
      const merged = [
        ...existing,
        ...newUtxos.filter(u => !existing.some(e => e.stealthAddress === u.stealthAddress)),
      ];
      saveStealthScan(username, merged, latestBlock);
      await fetchStealthBalances();
    } catch (e) {
      console.error("[refreshPrivate] error:", e);
      await fetchStealthBalances();
    } finally {
      setLoading(false);
    }
  }, [username, fetchStealthBalances]);

  useEffect(() => {
    if (!privacy) return;
    fetchStealthBalances();
    // The login-time scan (runStealthScan) writes new UTXOs to localStorage in
    // the background — poll so the list picks them up once it lands, instead
    // of staying frozen at whatever was there when this component mounted.
    const id = setInterval(fetchStealthBalances, 15000);
    return () => clearInterval(id);
  }, [privacy, fetchStealthBalances]);

  if (currentView === "sendEth") {
    return <SendEth wallet={wallet} username={username} balance={balance} onBack={handleBackToMenu} />;
  }

  if (currentView === "spendUtxo" && selectedUtxo) {
    return (
      <SpendStealthUTXO
        utxo={selectedUtxo}
        balance={selectedBalance}
        balanceWei={selectedWei}
        username={username}
        onBack={handleBackFromSpend}
      />
    );
  }

  if (currentView === "receivePrivate") {
    return <ReceivePrivate username={username} onBack={handleBackFromSpend} />;
  }

  if (currentView === "receivePublic") {
    const copyAddress = () => {
      navigator.clipboard?.writeText(address ?? "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    };
    return (
      <Box sx={{ pb: 4 }}>
        {/* Header */}
        <Box sx={{ display: "flex", alignItems: "center", maxWidth: 400, mx: "auto", mb: 1 }}>
          <IconButton onClick={() => setCurrentView("menu")} size="small" aria-label="Back">
            <ArrowBackIcon fontSize="small" />
          </IconButton>
          <Typography sx={{ flex: 1, textAlign: "center", fontWeight: 600, letterSpacing: "0.02em", mr: 4 }}>
            Receive
          </Typography>
        </Box>

        <Stack spacing={2.5} direction="column" alignItems="center" sx={{ width: "100%", maxWidth: 400, mx: "auto" }}>
          {/* QR */}
          <Box sx={{ display: "flex", justifyContent: "center", mt: 1 }}>
            <QrCode value={address ?? ""} size={232} />
          </Box>

          <Typography variant="body2" sx={{ color: "text.secondary", textAlign: "center", lineHeight: 1.6, maxWidth: 300 }}>
            Scan to send {symbol}, or copy your address below.
          </Typography>

          {/* Address card — whole row copies */}
          <Box
            onClick={copyAddress}
            title="Tap to copy your address"
            sx={{
              width: "100%",
              border: "1px solid",
              borderColor: copied ? "success.main" : "divider",
              borderRadius: 2,
              px: 1.75,
              py: 1.5,
              cursor: "pointer",
              transition: "border-color 0.15s",
              "&:hover": { borderColor: "primary.main" },
            }}
          >
            <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1, mb: 0.75 }}>
              <Typography sx={{ fontSize: "0.62rem", opacity: 0.6, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                Your address
              </Typography>
              <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, color: copied ? "success.main" : "primary.main" }}>
                {copied ? <CheckIcon sx={{ fontSize: "0.95rem" }} /> : <ContentCopyIcon sx={{ fontSize: "0.95rem" }} />}
                <Typography sx={{ fontSize: "0.68rem", letterSpacing: "0.04em" }}>
                  {copied ? "copied" : "copy"}
                </Typography>
              </Box>
            </Box>
            <Typography sx={{ fontFamily: "var(--font-geist-mono), monospace", fontSize: "0.82rem", wordBreak: "break-all", lineHeight: 1.5 }}>
              {address}
            </Typography>
          </Box>

          <Typography sx={{ fontFamily: "var(--font-geist-mono), monospace", fontSize: "0.62rem", opacity: 0.5, letterSpacing: "0.06em", textAlign: "center" }}>
            {networkName()}
          </Typography>
        </Stack>
      </Box>
    );
  }

  return (
    <Box sx={{ mt: 2 }}>
      <Stack
        spacing={2}
        direction="column"
        sx={{ width: "100%", maxWidth: 400, mx: "auto" }}
      >
        {/* Wallet-home balance card */}
        <Box
          sx={{
            border: "1px solid", borderColor: "divider", borderRadius: "2px", p: 2, textAlign: "left",
          }}
        >
          <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1, mb: 0.5 }}>
            <Typography sx={{ fontSize: "0.62rem", opacity: 0.6, letterSpacing: "0.1em", textTransform: "uppercase" }}>
              Your balance
            </Typography>
            <IconButton
              onClick={toggleHideBalance}
              size="small"
              aria-label={hideBalance ? "Show balance" : "Hide balance"}
              title={hideBalance ? "Show balance" : "Hide balance"}
              sx={{ p: 0.25 }}
            >
              {hideBalance ? <VisibilityOffIcon sx={{ fontSize: "1rem" }} /> : <VisibilityIcon sx={{ fontSize: "1rem" }} />}
            </IconButton>
          </Box>
          <Typography sx={{ fontFamily: "var(--font-geist-mono), monospace", fontSize: "2rem", lineHeight: 1.1, fontWeight: 500, wordBreak: "break-all" }}>
            {hideBalance ? <GlitchText length={7} /> : fmtAmount(shownBalance)} {symbol}
          </Typography>
          <Typography sx={{ fontFamily: "var(--font-geist-mono), monospace", fontSize: "0.7rem", opacity: 0.6, mt: 0.75, letterSpacing: "0.04em" }}>
            {username} · {privacy ? "private" : "public"} · light
          </Typography>
        </Box>

        <div>
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              mt: 3,
              mb: 2,
              gap: 1,
            }}
          >
            <Typography
              sx={{
                fontWeight: 500,
              }}
            >
              Recent Transactions
            </Typography>
            <IconButton
              onClick={privacy ? refreshPrivate : fetchTransactions}
              disabled={loading}
              size="small"
              sx={{ color: "primary.main" }}
            >
              <RefreshIcon fontSize="small" />
            </IconButton>
          </Box>

          {loading ? (
            <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
              <CircularProgress size={24} />
            </Box>
          ) : (privacy ? stealthTxs : transactions).length === 0 ? (
            <Box sx={{ display: "flex", justifyContent: "center", p: 3 }}>
              <Typography variant="body2" color="text.secondary">
                No transactions found
              </Typography>
            </Box>
          ) : (
            <Stack spacing={0.75} sx={{ maxHeight: 240, overflowY: "auto", pr: 0.5, maxWidth: 300, mx: "auto" }}>
              {(privacy ? stealthTxs : transactions).map((transaction) => (
                <Box
                  key={transaction.id}
                  component={transaction.type !== "private" ? "a" : "div"}
                  href={transaction.type !== "private" ? (explorerTxUrl(transaction.id) ?? undefined) : undefined}
                  target={transaction.type !== "private" ? "_blank" : undefined}
                  rel={transaction.type !== "private" ? "noopener noreferrer" : undefined}
                  onClick={transaction.type === "private" ? () => handleOpenSpend(transaction) : undefined}
                  title={transaction.type === "private" ? "Tap to spend from this stealth balance" : undefined}
                  sx={{
                    display: "flex", alignItems: "center", gap: 1,
                    border: "1px solid", borderColor: "divider", borderRadius: "2px",
                    px: 1.25, py: 0.75,
                    cursor: "pointer", textDecoration: "none", color: "inherit",
                    "&:hover": { borderColor: "primary.main" },
                  }}
                >
                  {transaction.type === "sent" ? (
                    <ArrowForwardIcon sx={{ color: "primary.main", fontSize: "1.1rem", flexShrink: 0 }} />
                  ) : transaction.type === "received" ? (
                    <ArrowBackIcon sx={{ color: "secondary.main", fontSize: "1.1rem", flexShrink: 0 }} />
                  ) : (
                    <Typography sx={{ fontSize: "1rem", fontFamily: "var(--font-geist-mono), monospace", opacity: 0.6, lineHeight: 1, flexShrink: 0 }}>
                      ◈
                    </Typography>
                  )}
                  <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", flex: 1, gap: 1, minWidth: 0, fontFamily: "var(--font-geist-mono), monospace" }}>
                    {transaction.type === "private" && (
                      <Typography variant="caption" sx={{ fontFamily: "inherit", letterSpacing: "0.04em", opacity: 0.7 }}>
                        {transaction.stealthAddress?.slice(0, 6)}…{transaction.stealthAddress?.slice(-4)}
                      </Typography>
                    )}
                    <Typography variant="body2" sx={{ fontFamily: "inherit", letterSpacing: "0.04em", fontWeight: 500, ml: "auto" }}>
                      {hideBalance ? <GlitchText length={4} /> : fmtAmount(transaction.amount)} {symbol}
                    </Typography>
                  </Box>
                </Box>
              ))}
            </Stack>
          )}
        </div>
        {showPopup && popupMessage && <Popup popupMessage={popupMessage} />}
      </Stack>

      {/* Fixed bottom action bar (wallet-home). Renders only on the menu view
          since the sub-views return earlier. Sits at the bottom over the footer. */}
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
            { key: "send", label: "Send", icon: <ArrowUpwardIcon fontSize="small" />, onClick: handleSendEth, disabled: false },
            { key: "receive", label: "Receive", icon: <ArrowDownwardIcon fontSize="small" />, onClick: handleReceive, disabled: false },
            { key: "soon", label: "soon", icon: <AddIcon fontSize="small" />, onClick: undefined, disabled: true },
          ].map((slot) => (
            <Button
              key={slot.key}
              onClick={slot.onClick}
              disabled={slot.disabled}
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
              {slot.icon}
              <Typography sx={{ fontSize: "0.6rem", letterSpacing: "0.08em", textTransform: "uppercase" }}>
                {slot.label}
              </Typography>
            </Button>
          ))}
        </Stack>
      </Box>
    </Box>
  );
};
