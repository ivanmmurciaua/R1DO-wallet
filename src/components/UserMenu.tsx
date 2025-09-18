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
import DiamondIcon from "@mui/icons-material/Diamond";
import ArrowForwardIcon from "@mui/icons-material/ArrowForward";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import RefreshIcon from "@mui/icons-material/Refresh";
import { SendEth } from "./SendEth";
import Popup from "./Popup";
import { Safe4337Pack } from "@safe-global/relay-kit";
import { getLastBlock } from "@/lib/client";

type UserMenuProps = {
  wallet: Safe4337Pack;
};

type Transaction = {
  id: string;
  type: "sent" | "received";
  amount: number;
  proportion?: number;
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

export const UserMenu: React.FC<UserMenuProps> = ({ wallet }) => {
  const [showPopup, setShowPopup] = useState(false);
  const [popupMessage, setPopupMessage] = useState("");
  const [currentView, setCurrentView] = useState<"menu" | "sendDiamonds">(
    "menu",
  );
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);

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

  const handleSendDiamonds = () => {
    setCurrentView("sendDiamonds");
  };

  const handleEarnMoreDiamonds = () => {
    // TODO: Implement
    handleShowPopup("Easy there, cowboy—this'll be implemented soon 🐴");
  };

  const handleBackToMenu = (message: string = "") => {
    if (message !== "") {
      handleShowPopup(message);
    }
    setCurrentView("menu");
  };

  const fetchTransactions = useCallback(async () => {
    setLoading(true);
    try {
      const address = await wallet.protocolKit.getAddress();
      const apiKey = process.env.NEXT_PUBLIC_ETHERSCAN_API_KEY;
      const block = await getLastBlock();

      const response = await fetch(
        `https://api.etherscan.io/v2/api?chainid=421614&module=account&action=txlistinternal&address=${address}&startblock=0&endblock=${block}&page=1&offset=10&sort=desc&apikey=${apiKey}`,
      );

      const data: EtherscanResponse = await response.json();

      if (data.status === "1" && data.result) {
        const userAddress = address.toLowerCase();

        const filteredTransactions = data.result.filter(
          (tx) => tx.type === "call",
        );

        const amounts = filteredTransactions.map((tx) => parseInt(tx.value));
        const maxAmount = Math.max(...amounts);
        const minAmount = Math.min(...amounts);

        const mappedTransactions: Transaction[] = filteredTransactions.map(
          (tx) => {
            const amount = parseInt(tx.value);
            // Calculate proportional intensity (20% to 100% range)
            const proportion =
              maxAmount > minAmount
                ? 0.2 + (0.8 * (amount - minAmount)) / (maxAmount - minAmount)
                : 1;

            return {
              id: tx.hash,
              type: tx.from.toLowerCase() === userAddress ? "sent" : "received",
              amount: amount,
              proportion: proportion,
            };
          },
        );

        setTransactions(mappedTransactions);
      }
    } catch (error) {
      console.error("Error fetching transactions:", error);
    } finally {
      setLoading(false);
    }
  }, [wallet]);

  useEffect(() => {
    if (wallet) {
      fetchTransactions();

      const interval = setInterval(() => {
        fetchTransactions();
      }, 90000);

      return () => clearInterval(interval);
    }
  }, [wallet, fetchTransactions]);

  if (currentView === "sendDiamonds") {
    return <SendEth wallet={wallet} onBack={handleBackToMenu} />;
  }

  return (
    <Box sx={{ mt: 2, mb: -25 }}>
      <Stack
        spacing={2}
        direction="column"
        sx={{ width: "100%", maxWidth: 400, mx: "auto" }}
      >
        <Button
          variant="contained"
          color="primary"
          onClick={handleSendDiamonds}
          sx={{
            py: 1.5,
            fontSize: "1rem",
            borderRadius: 2,
          }}
        >
          Send ⧫ to your friends
        </Button>

        <Button
          variant="outlined"
          color="secondary"
          startIcon={<DiamondIcon />}
          endIcon={<DiamondIcon />}
          onClick={handleEarnMoreDiamonds}
          sx={{
            py: 1.5,
            fontSize: "1rem",
            borderRadius: 2,
          }}
        >
          Earn more
        </Button>

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
              onClick={fetchTransactions}
              disabled={loading}
              size="small"
              sx={{
                color: "primary.main",
              }}
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
              ) : transactions.length === 0 ? (
                <Box
                  sx={{
                    display: "flex",
                    justifyContent: "center",
                    p: 4,
                  }}
                >
                  <Typography variant="body2" color="text.secondary">
                    No transactions found
                  </Typography>
                </Box>
              ) : (
                transactions.map((transaction) => (
                  <ListItem
                    key={transaction.id}
                    component="a"
                    href={`https://sepolia.arbiscan.io/tx/${transaction.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    sx={{
                      py: 0.5,
                      px: 1,
                      borderBottom: "1px solid #f5f5f5",
                      "&:last-child": {
                        borderBottom: "none",
                      },
                      cursor: "pointer",
                      textDecoration: "none",
                      color: "inherit",
                      "&:hover": {
                        backgroundColor: "rgba(0, 0, 0, 0.04)",
                      },
                    }}
                  >
                    <Box
                      sx={{
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: "100%",
                        gap: 1,
                      }}
                    >
                      {transaction.type === "sent" ? (
                        <ArrowForwardIcon
                          sx={{ color: "primary.main", fontSize: "1.2rem" }}
                        />
                      ) : (
                        <ArrowBackIcon
                          sx={{ color: "secondary.main", fontSize: "1.2rem" }}
                        />
                      )}
                      <Box
                        sx={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          width: "100%",
                          maxWidth: "200px",
                          backgroundColor:
                            transaction.type === "sent"
                              ? `rgba(25, 118, 210, ${(transaction.proportion || 1) * 0.3})`
                              : `rgba(156, 39, 176, ${(transaction.proportion || 1) * 0.3})`,
                          borderRadius: 1,
                          py: 0.5,
                          px: 1,
                        }}
                      >
                        <Typography variant="body2" sx={{ fontWeight: 500 }}>
                          {transaction.amount} ⧫
                        </Typography>
                      </Box>
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
