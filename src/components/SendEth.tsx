import React, { useState, useEffect } from "react";
import { Box, Button, Stack, Typography } from "@mui/material";
import SendIcon from "@mui/icons-material/Send";
import { Safe4337Pack } from "@safe-global/relay-kit";
import { smartSend, getStealthTotal } from "@/lib/deploy";
import { readDirectory } from "@/lib/registry-v2";
import { getDecimals, getSymbol } from "@/lib/localstorage";
import { parseUnits, formatUnits, zeroAddress } from "viem";
import { isPQMetaAddress } from "@/lib/stealth";

type SendEthProps = {
  wallet: Safe4337Pack;
  username: string;
  balance: number;
  onBack: (message: string) => void;
};

type PrivacyStatus = "unknown" | "checking" | "private" | "public";

export const SendEth: React.FC<SendEthProps> = ({ wallet, username, onBack }) => {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [privacyStatus, setPrivacyStatus] = useState<PrivacyStatus>("unknown");
  // Exact spendable in wei (main Safe + stealth UTXOs) — MAX/validation use this,
  // never the rounded `balance` prop (which can sit above the true balance).
  const [availableWei, setAvailableWei] = useState<bigint | null>(null);
  const symbol = getSymbol();

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const mainWei = BigInt((await wallet.protocolKit.getBalance()).toString());
        const stealthWei = await getStealthTotal(username);
        if (alive) setAvailableWei(mainWei + stealthWei);
      } catch (e) {
        console.warn("[SendEth] could not load exact balance:", e);
      }
    })();
    return () => {
      alive = false;
    };
  }, [wallet, username]);

  const handleBackToMenu = (message: string = "") => {
    setRecipient("");
    setAmount("");
    setPrivacyStatus("unknown");
    onBack(message);
  };

  // v2: usernames resolve through the Argon2id-encrypted directory (~1s).
  // If the entry carries a PQ meta-address, the send turns private for free.
  const resolveRecipient = async (
    input: string,
  ): Promise<{ address: string | null; metaAddress: `0x${string}` | null }> => {
    const trimmed = input.trim();
    if (!trimmed) return { address: null, metaAddress: null };

    if (trimmed.startsWith("0x") && trimmed.length === 42) {
      return { address: trimmed, metaAddress: null };
    }

    const entry = await readDirectory(trimmed);
    if (!entry) return { address: null, metaAddress: null };
    return { address: entry.safeAddress, metaAddress: entry.metaAddress };
  };

  // Δ1: no registry lookup — a payment is private when the recipient field
  // holds a PQ meta-address (1251 bytes, shared off-chain). Username/address
  // inputs are public sends.
  useEffect(() => {
    const trimmed = recipient.trim();
    if (!trimmed) {
      setPrivacyStatus("unknown");
      return;
    }
    setPrivacyStatus(isPQMetaAddress(trimmed) ? "private" : "public");
  }, [recipient]);

  const handleSendTransaction = async () => {
    if (!wallet || !recipient.trim() || !amount.trim() || parseFloat(amount) <= 0) return;

    let totalAmount: bigint;
    try {
      totalAmount = parseUnits(amount, getDecimals());
    } catch {
      handleBackToMenu("Invalid amount.");
      return;
    }
    // Compare in exact wei (the rounded `balance` can sit above the real one).
    if (availableWei != null && totalAmount > availableWei) {
      handleBackToMenu(`Amount exceeds your balance (${formatUnits(availableWei, getDecimals())} ${symbol}).`);
      return;
    }

    setIsLoading(true);

    try {
      const trimmed = recipient.trim();

      let metaAddress: `0x${string}` | null = isPQMetaAddress(trimmed)
        ? (trimmed as `0x${string}`)
        : null;
      let recipientAddress: string | null = zeroAddress;

      if (!metaAddress) {
        const resolved = await resolveRecipient(trimmed);
        if (resolved.metaAddress) {
          // Directory entry carries a meta-address → pay privately by name
          metaAddress = resolved.metaAddress;
        } else {
          recipientAddress = resolved.address;
          if (!recipientAddress) {
            handleBackToMenu("Recipient not found.");
            return;
          }
        }
      }

      const isPrivate = !!metaAddress;
      // The typing-time hint only knows about pasted meta-addresses; the
      // directory resolution above is what actually decides the mode.
      setPrivacyStatus(isPrivate ? "private" : "public");
      console.log(`[SendEth] Sending ${amount} ${symbol} to ${trimmed} | private: ${isPrivate}`);

      const result = await smartSend(
        wallet,
        recipientAddress as `0x${string}`,
        totalAmount,
        username,
        metaAddress,
      );

      const recipientLabel = isPrivate
        ? isPQMetaAddress(trimmed)
          ? `${trimmed.slice(0, 10)}…(meta-address)`
          : `${trimmed} (private)`
        : recipient;
      if (result.success) {
        handleBackToMenu(`Sent ${amount} ${symbol}${metaAddress ? " privately" : ""} to ${recipientLabel}`);
      } else if (result.sentAmount > 0n) {
        const sentFormatted = formatUnits(result.sentAmount, getDecimals());
        handleBackToMenu(`Sent ${sentFormatted} of ${amount} ${symbol} to ${recipientLabel} — try again to send the rest.`);
      } else {
        handleBackToMenu(result.error ?? `Failed to send ${amount} ${symbol} to ${recipientLabel}. Try again later`);
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
            Recipient (Username, Address or Meta-address)
          </Typography>
          <input
            type="text"
            value={recipient}
            onChange={(e) => setRecipient(e.target.value)}
            placeholder="_ username, 0x address or 0x00… meta-address"
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
          <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1 }}>
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              Amount ({symbol})
            </Typography>
            <Button
              variant="text"
              color="primary"
              size="small"
              onClick={() => availableWei != null && setAmount(formatUnits(availableWei, getDecimals()))}
              disabled={isLoading || availableWei == null || availableWei <= 0n}
              sx={{ minWidth: 0, px: 1, fontSize: "0.7rem" }}
            >
              MAX
            </Button>
          </Box>
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
