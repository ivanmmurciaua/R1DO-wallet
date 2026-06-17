import React, { useState, useEffect, useCallback } from "react";
import {
  Button,
  Stack,
  Box,
  Typography,
  Paper,
  List,
  ListItem,
  CircularProgress,
  IconButton,
} from "@mui/material";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import RefreshIcon from "@mui/icons-material/Refresh";
import { SendEth } from "./SendEth";
import { SpendStealthUTXO } from "./SpendStealthUTXO";
import Popup from "./Popup";
import { Safe4337Pack } from "@safe-global/relay-kit";
import { formatUnits, createPublicClient } from "viem";
import { sepoliaTransport } from "@/app/constants";
import { sepolia } from "viem/chains";
import { getLastBlock } from "@/lib/client";
import { getDecimals, getSymbol, getStealthUTXOs, getWalletMeta, saveStealthScan, getLastScannedBlock } from "@/lib/localstorage";
import { getWalletCredential } from "@/lib/credstore";
import { loadFromDevice } from "@/lib/passkeys";
import { derivePQKeysFromPRF, scanStealthPayments, type StealthUTXO } from "@/lib/stealth";

type UserMenuProps = {
  wallet: Safe4337Pack;
  username: string;
  balance: number;
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

export const UserMenu: React.FC<UserMenuProps> = ({ wallet, username, balance }) => {
  const [showPopup, setShowPopup] = useState(false);
  const [popupMessage, setPopupMessage] = useState("");
  const [currentView, setCurrentView] = useState<"menu" | "sendEth" | "spendUtxo">("menu");
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [stealthTxs, setStealthTxs] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedUtxo, setSelectedUtxo] = useState<StealthUTXO | null>(null);
  const [selectedBalance, setSelectedBalance] = useState<number>(0);
  const [selectedWei, setSelectedWei] = useState<bigint>(0n);

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

  const fetchTransactions = useCallback(async () => {
    if (privacy) return; // private wallet — no Etherscan
    setLoading(true);
    try {
      const address = await wallet.protocolKit.getAddress();
      const apiKey = process.env.NEXT_PUBLIC_ETHERSCAN_API_KEY;
      const block = await getLastBlock();

      const response = await fetch(
        `https://api.etherscan.io/v2/api?chainid=11155111&module=account&action=txlistinternal&address=${address}&startblock=0&endblock=${block}&page=1&offset=10&sort=desc&apikey=${apiKey}`,
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
    const pub = createPublicClient({ chain: sepolia, transport: sepoliaTransport() });
    const results = await Promise.all(
      utxos.map(async (utxo) => {
        const raw = await pub.getBalance({ address: utxo.stealthAddress });
        return {
          id: utxo.stealthAddress,
          type: "private" as const,
          amount: parseFloat(parseFloat(formatUnits(raw, decimals)).toFixed(4)),
          stealthAddress: utxo.stealthAddress,
          weiBalance: raw, // exact — spend clamps to this, never the rounded `amount`
        };
      }),
    );
    setStealthTxs(results.filter((tx) => tx.amount > 0));
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
      const pub = createPublicClient({ chain: sepolia, transport: sepoliaTransport() });
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

  return (
    <Box sx={{ mt: 2 }}>
      <Stack
        spacing={2}
        direction="column"
        sx={{ width: "100%", maxWidth: 400, mx: "auto" }}
      >
        <Button
          variant="contained"
          color="primary"
          onClick={handleSendEth}
          sx={{
            py: 1.5,
            fontSize: "1rem",
            borderRadius: 2,
          }}
        >
          Send {symbol} to your friends
        </Button>

        {/* Put yours {symbol} to work — hidden until implemented */}

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

          <Paper
            sx={{
              borderRadius: 2,
              height: 200,
              overflow: "auto",
              maxWidth: 300,
              mx: "auto",
            }}
          >
            <List sx={{ p: 1 }}>
              {loading ? (
                <Box
                  sx={{
                    display: "flex",
                    justifyContent: "center",
                    p: 4,
                  }}
                >
                  <CircularProgress size={24} />
                </Box>
              ) : (privacy ? stealthTxs : transactions).length === 0 ? (
                <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
                  <Typography variant="body2" color="text.secondary">
                    No transactions found
                  </Typography>
                </Box>
              ) : (
                (privacy ? stealthTxs : transactions).map((transaction) => (
                  <ListItem
                    key={transaction.id}
                    component={transaction.type !== "private" ? "a" : "div"}
                    href={transaction.type !== "private" ? `https://sepolia.etherscan.io/tx/${transaction.id}` : undefined}
                    target={transaction.type !== "private" ? "_blank" : undefined}
                    rel={transaction.type !== "private" ? "noopener noreferrer" : undefined}
                    onClick={transaction.type === "private" ? () => handleOpenSpend(transaction) : undefined}
                    sx={{
                      py: 0.5, px: 1,
                      borderBottom: "1px solid #f5f5f5",
                      "&:last-child": { borderBottom: "none" },
                      cursor: "pointer",
                      textDecoration: "none",
                      color: "inherit",
                      "&:hover": { backgroundColor: "rgba(0, 0, 0, 0.04)" },
                    }}
                    title={transaction.type === "private" ? "Tap to spend from this stealth balance" : undefined}
                  >
                    <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", width: "100%", gap: 1 }}>
                      {transaction.type === "sent" ? (
                        <ArrowForwardIcon sx={{ color: "primary.main", fontSize: "1.2rem" }} />
                      ) : transaction.type === "received" ? (
                        <ArrowBackIcon sx={{ color: "secondary.main", fontSize: "1.2rem" }} />
                      ) : (
                        <Typography sx={{ fontSize: "1.1rem", fontFamily: "var(--font-geist-mono), monospace", opacity: 0.6, lineHeight: 1 }}>
                          ◈
                        </Typography>
                      )}
                      {transaction.type === "private" ? (
                        <Box
                          sx={{
                            display: "flex", alignItems: "center", justifyContent: "space-between",
                            width: "100%", maxWidth: "200px",
                            background: "transparent",
                            border: "1px dashed currentColor",
                            opacity: 0.7,
                            borderRadius: "2px", py: 0.5, px: 1,
                            fontFamily: "var(--font-geist-mono), monospace",
                          }}
                        >
                          <Typography variant="caption" sx={{ fontFamily: "inherit", letterSpacing: "0.04em" }}>
                            {transaction.stealthAddress?.slice(0, 6)}…{transaction.stealthAddress?.slice(-4)}
                          </Typography>
                          <Typography variant="body2" sx={{ fontFamily: "inherit", letterSpacing: "0.04em", fontWeight: 500 }}>
                            {transaction.amount} {symbol}
                          </Typography>
                        </Box>
                      ) : (
                        <Box
                          sx={{
                            display: "flex", alignItems: "center", justifyContent: "space-between",
                            width: "100%", maxWidth: "200px",
                            backgroundColor: transaction.type === "sent"
                              ? `rgba(25, 118, 210, ${(transaction.proportion || 1) * 0.3})`
                              : `rgba(156, 39, 176, ${(transaction.proportion || 1) * 0.3})`,
                            borderRadius: 1, py: 0.5, px: 1,
                          }}
                        >
                          <Typography variant="body2" sx={{ fontWeight: 500 }}>
                            {transaction.amount} {symbol}
                          </Typography>
                        </Box>
                      )}
                    </Box>
                  </ListItem>
                ))
              )}
            </List>
          </Paper>
        </div>
        {showPopup && popupMessage && <Popup popupMessage={popupMessage} />}
      </Stack>
    </Box>
  );
};
