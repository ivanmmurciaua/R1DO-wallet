import React, { useState } from "react";
import { Box, Button, Stack, Typography } from "@mui/material";
import SendIcon from "@mui/icons-material/Send";
import { Safe4337Pack } from "@safe-global/relay-kit";
import { makeTx } from "@/lib/deploy";
import { generateFingerprint, readFromSC } from "@/lib/passkeys";
import { PasskeyOnchainResponseType } from "@/types";
// import { zeroAddress } from "viem";

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

    setIsLoading(true);
    console.log(`Sending ${amount} ⧫ to ${recipient}`);

    let recipientAddress = "";

    try {
      //TODO: Implement search for username or fallback to address

      const onchainResponse = (await readFromSC(
        "getPasskey",
        generateFingerprint(recipient),
      )) as PasskeyOnchainResponseType;

      if (onchainResponse) {
        recipientAddress = onchainResponse.userAddress;
      } else {
        //Fallback to user input
        recipientAddress = recipient;
      }

      // console.log(wallet);
      // console.log(recipientAddress);
      // console.log(amount);

      const tx = await makeTx(wallet, recipientAddress, amount);

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
        sx={{ width: "100%", maxWidth: 400, mx: "auto", mb: -25 }}
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
            placeholder="Enter username or wallet address"
            style={{
              fontSize: "1rem",
              borderRadius: "4px",
              border: "1px solid #555",
              width: "100%",
              padding: "11px",
              boxSizing: "border-box",
            }}
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
              borderRadius: "4px",
              border: "1px solid #555",
              width: "100%",
              padding: "11px",
              boxSizing: "border-box",
            }}
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
