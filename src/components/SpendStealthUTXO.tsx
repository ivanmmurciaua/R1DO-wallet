import React, { useState } from "react";
import { Box, Button, Stack, Typography } from "@mui/material";
import SendIcon from "@mui/icons-material/Send";
import { spendStealthUTXO } from "@/lib/deploy";
import { generateFingerprint, readFromSC, loadFromDevice } from "@/lib/passkeys";
import { PasskeyOnchainResponseType } from "@/types";
import { getDecimals, getSymbol, getLocalData } from "@/lib/localstorage";
import { derivePQKeysFromPRF, type StealthUTXO } from "@/lib/stealth";
import { parseUnits, zeroAddress } from "viem";

type SpendStealthUTXOProps = {
  utxo: StealthUTXO;
  balance: number;
  username: string;
  onBack: (message: string) => void;
};

const inputStyle: React.CSSProperties = {
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
};

export const SpendStealthUTXO: React.FC<SpendStealthUTXOProps> = ({ utxo, balance, username, onBack }) => {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const symbol = getSymbol();
  const decimals = getDecimals();

  const handleCancel = (message: string = "") => {
    setRecipient("");
    setAmount("");
    onBack(message);
  };

  const resolveRecipient = async (input: string): Promise<`0x${string}` | null> => {
    const trimmed = input.trim();
    if (!trimmed) return null;

    if (trimmed.startsWith("0x") && trimmed.length === 42) {
      return trimmed as `0x${string}`;
    }

    const onchainResponse = (await readFromSC(
      "getPasskey",
      generateFingerprint(trimmed),
    )) as PasskeyOnchainResponseType;

    if (onchainResponse && onchainResponse.safeAddress !== zeroAddress) {
      return onchainResponse.safeAddress as `0x${string}`;
    }
    if (onchainResponse && onchainResponse.userAddress !== zeroAddress) {
      return onchainResponse.userAddress as `0x${string}`;
    }
    return null;
  };

  const handleSpend = async () => {
    if (!recipient.trim() || !amount.trim()) return;

    const parsedAmount = parseFloat(amount);
    if (Number.isNaN(parsedAmount) || parsedAmount <= 0) return;
    if (parsedAmount > balance) {
      handleCancel(`Amount exceeds available balance (${balance} ${symbol}).`);
      return;
    }

    let totalAmount: bigint;
    try {
      totalAmount = parseUnits(amount, decimals);
    } catch {
      handleCancel("Invalid amount.");
      return;
    }

    setIsLoading(true);
    console.log(`[SpendStealthUTXO] Spending ${amount} ${symbol} from ${utxo.stealthAddress} to ${recipient}`);

    try {
      const recipientAddress = await resolveRecipient(recipient);
      if (!recipientAddress) {
        handleCancel("Recipient not found.");
        return;
      }

      const data = getLocalData(username);
      if (!data?.passkey?.rawId) {
        handleCancel("Passkey not found on this device.");
        return;
      }

      const prf = await loadFromDevice(data.passkey.rawId);
      if (!prf || prf.length === 0) {
        handleCancel("Could not access your passkey. Try again.");
        return;
      }

      const keys = await derivePQKeysFromPRF(prf);
      const tx = await spendStealthUTXO(
        utxo,
        totalAmount.toString(),
        recipientAddress,
        keys.spendingPrivateKey,
        keys.viewingPrivateKey,
        keys.mlkemDecapsKey,
      );

      if (tx) handleCancel(`Sent ${amount} ${symbol} from your stealth balance to ${recipient}`);
      else handleCancel("Spend failed. Try again.");
    } catch (error) {
      console.error("Spend stealth UTXO error:", error);
      handleCancel(`Failed to spend ${symbol}. Please try again.`);
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
        <Typography variant="body2" sx={{ color: "text.secondary", textAlign: "center" }}>
          Spending from {utxo.stealthAddress.slice(0, 6)}…{utxo.stealthAddress.slice(-4)}
          {" — available: "}{balance} {symbol}
        </Typography>

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
            style={inputStyle}
            onFocus={(e) => (e.target.style.opacity = "1")}
            onBlur={(e) => (e.target.style.opacity = "0.7")}
          />
        </Box>

        {/* Amount input */}
        <Box>
          <Typography variant="body2" sx={{ mb: 1, color: "text.secondary" }}>
            Amount ({symbol})
          </Typography>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="0.00"
            min="0"
            step="0.01"
            style={inputStyle}
            onFocus={(e) => (e.target.style.opacity = "1")}
            onBlur={(e) => (e.target.style.opacity = "0.7")}
          />
        </Box>

        {/* Spend button */}
        <Button
          variant="outlined"
          color="primary"
          startIcon={<SendIcon />}
          onClick={handleSpend}
          disabled={isLoading || !recipient.trim() || !amount.trim()}
          sx={{ py: 1.5, fontSize: "1rem", borderRadius: 2, mt: 3 }}
        >
          {isLoading ? "Sending..." : `Send ${amount || "0"} ${symbol}`}
        </Button>

        {/* Cancel button */}
        <Button
          variant="text"
          color="secondary"
          onClick={() => handleCancel()}
          sx={{ py: 1, fontSize: "0.9rem" }}
        >
          Cancel
        </Button>
      </Stack>
    </Box>
  );
};
