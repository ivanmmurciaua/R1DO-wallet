import React, { useState } from "react";
import { Box, Button, Stack, Typography } from "@mui/material";
import SendIcon from "@mui/icons-material/Send";
import { Safe4337Pack } from "@safe-global/relay-kit";
import { makeTx } from "@/lib/deploy";
import { generateFingerprint, readFromSC } from "@/lib/passkeys";
import { PasskeyOnchainResponseType } from "@/types";
import { getDecimals } from "@/lib/localstorage";
import { parseUnits, zeroAddress } from "viem";

type SendEthProps = {
  wallet: Safe4337Pack;
  onBack: (message: string) => void;
};

export const SendEth: React.FC<SendEthProps> = ({ wallet, onBack }) => {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [isLoading, setIsLoading] = useState(false);

  const handleBackToMenu = (message: string = "") => {
    setRecipient("");
    setAmount("");
    onBack(message);
  };

  const handleSendTransaction = async () => {
    if (
      !wallet ||
      !recipient.trim() ||
      !amount.trim() ||
      parseFloat(amount) <= 0
    ) {
      return;
    }

    let totalAmount: bigint;
    try {
      totalAmount = parseUnits(amount, getDecimals());
    } catch {
      handleBackToMenu("Invalid amount.");
      return;
    }

    setIsLoading(true);
    console.log(`Sending ${amount} ⧫ to ${recipient}`);

    let recipientAddress = "";

    try {
      const onchainResponse = (await readFromSC(
        "getPasskey",
        generateFingerprint(recipient),
      )) as PasskeyOnchainResponseType;

      if (onchainResponse && onchainResponse.userAddress !== zeroAddress) {
        recipientAddress = onchainResponse.userAddress;
      } else {
        // Fallback to user input (username not registered onchain)
        recipientAddress = recipient;
      }

      const tx = await makeTx(wallet, recipientAddress, totalAmount.toString());

      if (tx) {
        // console.log(tx);
        handleBackToMenu(`Successfully sent ${amount} ⧫ to ${recipient}`);
      } else {
        handleBackToMenu(
          `Failed to send ${amount} ⧫ to ${recipient}. Try again later`,
        );
      }
    } catch (error) {
      console.error("Send transaction error:", error);
      handleBackToMenu("Failed to send ⧫. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Box>
      <Stack
        spacing={1.7}
        direction="column"
        sx={{ width: "100%", maxWidth: 400, mx: "auto" }}
      >
        {/*
        <Box sx={{ display: "flex", alignItems: "center", mb: 1 }}>
          <IconButton
            onClick={handleBackToMenu}
            sx={{ mr: 1 }}
            aria-label="Back to menu"
          >
            <ArrowBackIcon />
          </IconButton>
          <Typography
            variant="h6"
            sx={{ flexGrow: 1, textAlign: "center", mr: 5 }}
          >
            Send
          </Typography>
        </Box>*/}

        {/* Recipient input */}
        <Box>
          <Typography variant="body2" sx={{ mb: 1, color: "text.secondary" }}>
            Recipient (Username or Address)
          </Typography>
          <input
            type="text"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="_ username or 0x address"
            style={{
              fontSize: "1rem",
              fontFamily: "var(--font-geist-mono), monospace",
              borderRadius: "2px",
              border: "1px solid currentColor",
              background: "transparent",
              color: "inherit",
              width: "100%",
              padding: "12px 14px",
              boxSizing: "border-box",
              outline: "none",
              letterSpacing: "0.04em",
              opacity: 0.7,
              transition: "opacity 0.15s",
            }}
            onFocus={(e) => (e.target.style.opacity = "1")}
            onBlur={(e) => (e.target.style.opacity = "0.7")}
          />
        </Box>

        {/* Amount input */}
        <Box>
          <Typography variant="body2" sx={{ mb: 1, color: "text.secondary" }}>
            Amount (⧫)
          </Typography>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            min="0"
            step="0.01"
            style={{
              fontSize: "1rem",
              fontFamily: "var(--font-geist-mono), monospace",
              borderRadius: "2px",
              border: "1px solid currentColor",
              background: "transparent",
              color: "inherit",
              width: "100%",
              padding: "12px 14px",
              boxSizing: "border-box",
              outline: "none",
              letterSpacing: "0.04em",
              opacity: 0.7,
              transition: "opacity 0.15s",
            }}
            onFocus={(e) => (e.target.style.opacity = "1")}
            onBlur={(e) => (e.target.style.opacity = "0.7")}
          />
        </Box>

        {/* Send button */}
        <Button
          variant="outlined"
          color="primary"
          startIcon={<SendIcon />}
          onClick={handleSendTransaction}
          disabled={isLoading || !recipient.trim() || !amount.trim()}
          sx={{
            py: 1.5,
            fontSize: "1rem",
            borderRadius: 2,
            mt: 3,
          }}
        >
          {isLoading ? "Sending..." : `Send ${amount || "0"} ⧫`}
        </Button>

        {/* Cancel button */}
        <Button
          variant="text"
          color="secondary"
          onClick={() => handleBackToMenu()}
          sx={{
            py: 1,
            fontSize: "0.9rem",
          }}
        >
          Cancel
        </Button>
      </Stack>
    </Box>
  );
};
