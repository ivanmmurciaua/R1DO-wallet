import React, { useState, useEffect, useRef } from "react";
import { Box, Button, Stack, Typography } from "@mui/material";
import SendIcon from "@mui/icons-material/Send";
import { Safe4337Pack } from "@safe-global/relay-kit";
import { smartSend } from "@/lib/deploy";
import { generateFingerprint, readFromSC } from "@/lib/passkeys";
import { PasskeyOnchainResponseType } from "@/types";
import { getDecimals, getSymbol } from "@/lib/localstorage";
import { parseUnits, formatUnits, zeroAddress } from "viem";
import { getStealthMetaAddress } from "@/lib/stealth";

type SendEthProps = {
  wallet: Safe4337Pack;
  username: string;
  balance: number;
  onBack: (message: string) => void;
};

type PrivacyStatus = "unknown" | "checking" | "private" | "public";

export const SendEth: React.FC<SendEthProps> = ({ wallet, username, balance, onBack }) => {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [privacyStatus, setPrivacyStatus] = useState<PrivacyStatus>("unknown");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const symbol = getSymbol();

  const handleBackToMenu = (message: string = "") => {
    setRecipient("");
    setAmount("");
    setPrivacyStatus("unknown");
    onBack(message);
  };

  // Resolve recipient to Safe address
  const resolveRecipient = async (input: string): Promise<string | null> => {
    const trimmed = input.trim();
    if (!trimmed) return null;

    if (trimmed.startsWith("0x") && trimmed.length === 42) {
      return trimmed;
    }

    const onchainResponse = (await readFromSC(
      "getPasskey",
      generateFingerprint(trimmed),
    )) as PasskeyOnchainResponseType;

    if (onchainResponse && onchainResponse.safeAddress !== zeroAddress) {
      return onchainResponse.safeAddress;
    }
    if (onchainResponse && onchainResponse.userAddress !== zeroAddress) {
      return onchainResponse.userAddress;
    }
    return null;
  };

  // Check privacy status after user stops typing
  useEffect(() => {
    if (!recipient.trim()) {
      setPrivacyStatus("unknown");
      return;
    }

    if (debounceRef.current) clearTimeout(debounceRef.current);

    debounceRef.current = setTimeout(async () => {
      setPrivacyStatus("checking");
      try {
        const addr = await resolveRecipient(recipient);
        if (!addr) { setPrivacyStatus("public"); return; }
        const meta = await getStealthMetaAddress(addr);
        setPrivacyStatus(meta ? "private" : "public");
      } catch {
        setPrivacyStatus("public");
      }
    }, 600);

    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipient]);

  const handleSendTransaction = async () => {
    if (!wallet || !recipient.trim() || !amount.trim() || parseFloat(amount) <= 0) return;

    if (parseFloat(amount) > balance) {
      handleBackToMenu(`Amount exceeds your balance (${balance} ${symbol}).`);
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
    console.log(`[SendEth] Sending ${amount} ${symbol} to ${recipient} | privacy: ${privacyStatus}`);

    try {
      const recipientAddress = await resolveRecipient(recipient);
      if (!recipientAddress) {
        handleBackToMenu("Recipient not found.");
        return;
      }

      const metaAddress = privacyStatus === "private" ? await getStealthMetaAddress(recipientAddress) : null;

      const result = await smartSend(
        wallet,
        recipientAddress as `0x${string}`,
        totalAmount,
        username,
        metaAddress,
      );

      if (result.success) {
        handleBackToMenu(`Sent ${amount} ${symbol}${metaAddress ? " privately" : ""} to ${recipient}`);
      } else if (result.sentAmount > 0n) {
        const sentFormatted = formatUnits(result.sentAmount, getDecimals());
        handleBackToMenu(`Sent ${sentFormatted} of ${amount} ${symbol} to ${recipient} — try again to send the rest.`);
      } else {
        handleBackToMenu(result.error ?? `Failed to send ${amount} ${symbol} to ${recipient}. Try again later`);
      }
    } catch (error) {
      console.error("Send transaction error:", error);
      handleBackToMenu(`Failed to send ${symbol}. Please try again.`);
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
            Amount ({symbol})
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
          disabled={isLoading || !recipient.trim() || !amount.trim() || privacyStatus === "checking"}
          sx={{ py: 1.5, fontSize: "1rem", borderRadius: 2, mt: 3 }}
        >
          {isLoading
            ? "Sending..."
            : privacyStatus === "private"
              ? `Send ${amount || "0"} ${symbol} privately`
              : `Send ${amount || "0"} ${symbol}`}
        </Button>

        {/* Cancel button */}
        <Button
          variant="text"
          color="secondary"
          onClick={() => handleBackToMenu()}
          sx={{ py: 1, fontSize: "0.9rem" }}
        >
          Cancel
        </Button>
      </Stack>
    </Box>
  );
};
