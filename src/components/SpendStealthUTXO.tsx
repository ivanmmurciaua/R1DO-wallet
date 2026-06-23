import React, { useState } from "react";
import { Box, Button, Stack, Typography } from "@mui/material";
import SendIcon from "@mui/icons-material/Send";
import { spendStealthUTXO } from "@/lib/deploy";
import { loadFromDevice } from "@/lib/passkeys";
import { readDirectory } from "@/lib/registry-v2";
import { getDecimals, getSymbol } from "@/lib/localstorage";
import { assetByAddress } from "@/lib/assets";
import { getWalletCredential } from "@/lib/credstore";
import { derivePQKeysFromPRF, generateStealthPayment, isPQMetaAddress, type StealthUTXO } from "@/lib/stealth";
import { parseUnits, formatUnits } from "viem";

type SpendStealthUTXOProps = {
  utxo: StealthUTXO;
  balance: number;       // rounded, for display only
  balanceWei: bigint;    // exact on-chain balance — validation/MAX use this
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

export const SpendStealthUTXO: React.FC<SpendStealthUTXOProps> = ({ utxo, balance, balanceWei, username, onBack }) => {
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  // Token UTXOs (tagged at discovery) spend in the token's own symbol/decimals;
  // native UTXOs use the themeable ⧫/13 globals. Drives parse, validation and MAX.
  const tokenAsset = utxo.asset ? assetByAddress(utxo.asset) : undefined;
  const symbol = tokenAsset?.symbol ?? getSymbol();
  const decimals = tokenAsset?.decimals ?? getDecimals();

  const handleCancel = (message: string = "") => {
    setRecipient("");
    setAmount("");
    onBack(message);
  };

  // v2: usernames resolve through the Argon2id-encrypted directory (~1s).
  const resolveRecipient = async (
    input: string,
  ): Promise<{ address: `0x${string}` | null; metaAddress: `0x${string}` | null }> => {
    const trimmed = input.trim();
    if (!trimmed) return { address: null, metaAddress: null };

    if (trimmed.startsWith("0x") && trimmed.length === 42) {
      return { address: trimmed as `0x${string}`, metaAddress: null };
    }

    const entry = await readDirectory(trimmed);
    if (!entry) return { address: null, metaAddress: null };
    return { address: entry.safeAddress, metaAddress: entry.metaAddress };
  };

  const handleSpend = async () => {
    if (!recipient.trim() || !amount.trim()) return;

    const parsedAmount = parseFloat(amount);
    if (Number.isNaN(parsedAmount) || parsedAmount <= 0) return;

    let totalAmount: bigint;
    try {
      totalAmount = parseUnits(amount, decimals);
    } catch {
      handleCancel("Invalid amount.");
      return;
    }
    // Compare in exact wei (the displayed balance is rounded and can sit ABOVE
    // the true balance → spending it would overspend and revert in simulation).
    if (totalAmount <= 0n) return;
    if (totalAmount > balanceWei) {
      handleCancel(`Amount exceeds available balance (${formatUnits(balanceWei, decimals)} ${symbol}).`);
      return;
    }

    setIsLoading(true);
    console.log(`[SpendStealthUTXO] Spending ${amount} ${symbol} from ${utxo.stealthAddress} to ${recipient}`);

    try {
      const trimmed = recipient.trim();

      // Δ1: a meta-address recipient gets a fresh stealth destination and the
      // delivery blob rides on the transfer itself (private chained spend).
      // v2: a username whose directory entry carries a meta-address gets the
      // same private treatment automatically.
      let metaAddress: `0x${string}` | null = isPQMetaAddress(trimmed)
        ? (trimmed as `0x${string}`)
        : null;
      let recipientAddress: `0x${string}` | null = null;
      let calldataBlob: `0x${string}` | undefined;

      if (!metaAddress) {
        const resolved = await resolveRecipient(trimmed);
        metaAddress = resolved.metaAddress;
        recipientAddress = resolved.address;
      }
      if (metaAddress) {
        const payment = await generateStealthPayment(metaAddress);
        recipientAddress = payment.stealthAddress;
        calldataBlob = payment.calldataBlob;
      }
      if (!recipientAddress) {
        handleCancel("Recipient not found.");
        return;
      }

      const cred = await getWalletCredential(username).catch(() => null);
      if (!cred) {
        handleCancel("Passkey not found on this device.");
        return;
      }

      const prf = await loadFromDevice(cred.rawId);
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
        calldataBlob,
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
          <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1 }}>
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              Amount ({symbol})
            </Typography>
            <Button
              variant="text"
              color="primary"
              size="small"
              onClick={() => setAmount(formatUnits(balanceWei, decimals))}
              disabled={isLoading || balanceWei <= 0n}
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
