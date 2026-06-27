import React, { useState } from "react";
import { Box, Button, Stack, Typography } from "@mui/material";
import SendIcon from "@mui/icons-material/Send";
import ArrowBackIcon from "@mui/icons-material/ArrowBackIosNew";
import { spendStealthUTXO, quoteStealthUTXOFee } from "@/lib/deploy";
import { getFeeRecipient } from "@/lib/feeRecipient";
import { loadFromDevice } from "@/lib/passkeys";
import { readDirectory } from "@/lib/registry-v2";
import { getDecimals, getSymbol } from "@/lib/localstorage";
import { assetByAddress, nativeAsset, type Asset } from "@/lib/assets";
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

// Everything resolved at the Review step (incl. the passkey-derived keys), so
// "Confirm & Send" reuses it WITHOUT a second passkey tap.
type Prepared = {
  totalAmount: bigint;
  recipientAddress: `0x${string}`;
  calldataBlob?: `0x${string}`;
  keys: { spendingPrivateKey: `0x${string}`; viewingPrivateKey: `0x${string}`; mlkemDecapsKey: Uint8Array };
  feeCtx?: { asset: Asset; feePay: { stealthAddress: `0x${string}`; calldataBlob: `0x${string}` } };
  fee: bigint;
  coversGas: boolean;
  display: string;
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
  const [reviewing, setReviewing] = useState(false); // building the Review (passkey + estimate)
  const [isLoading, setIsLoading] = useState(false); // sending
  const [error, setError] = useState("");
  const [prepared, setPrepared] = useState<Prepared | null>(null);

  // Token UTXOs (tagged at discovery) spend in the token's own symbol/decimals;
  // native UTXOs use the themeable ⧫/13 globals. Drives parse, validation and MAX.
  const tokenAsset = utxo.asset ? assetByAddress(utxo.asset) : undefined;
  const symbol = tokenAsset?.symbol ?? getSymbol();
  const decimals = tokenAsset?.decimals ?? getDecimals();

  const fmt = (wei: bigint) =>
    new Intl.NumberFormat(undefined, { maximumFractionDigits: 8 }).format(Number(formatUnits(wei, decimals)));

  const handleCancel = (message: string = "") => {
    setRecipient("");
    setAmount("");
    setPrepared(null);
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

  // Review: resolve recipient, ONE passkey tap → derive keys, then estimate the
  // real fee off the UTXO's Safe (max(0.1%, gas)). Everything is stored so the
  // send reuses it without a second passkey tap.
  const handleReview = async () => {
    if (!recipient.trim() || !amount.trim()) return;
    setError("");
    let totalAmount: bigint;
    try {
      totalAmount = parseUnits(amount, decimals);
    } catch {
      setError("Invalid amount.");
      return;
    }
    if (totalAmount <= 0n) return;
    if (totalAmount > balanceWei) {
      setError(`Amount exceeds available balance (${formatUnits(balanceWei, decimals)} ${symbol}).`);
      return;
    }

    setReviewing(true);
    try {
      const trimmed = recipient.trim();
      let metaAddress: `0x${string}` | null = isPQMetaAddress(trimmed) ? (trimmed as `0x${string}`) : null;
      let recipientAddress: `0x${string}` | null = null;
      let calldataBlob: `0x${string}` | undefined;
      if (!metaAddress) {
        const r = await resolveRecipient(trimmed);
        metaAddress = r.metaAddress;
        recipientAddress = r.address;
      }
      if (metaAddress) {
        const payment = await generateStealthPayment(metaAddress);
        recipientAddress = payment.stealthAddress;
        calldataBlob = payment.calldataBlob;
      }
      if (!recipientAddress) {
        setError("Recipient not found.");
        return;
      }

      const cred = await getWalletCredential(username).catch(() => null);
      if (!cred) {
        setError("Passkey not found on this device.");
        return;
      }
      const prf = await loadFromDevice(cred.rawId);
      if (!prf || prf.length === 0) {
        setError("Could not access your passkey. Try again.");
        return;
      }
      const keys = await derivePQKeysFromPRF(prf);

      const feeRecipient = await getFeeRecipient();
      const asset = tokenAsset ?? nativeAsset();
      const feeCtx = feeRecipient
        ? { asset, feePay: await generateStealthPayment(feeRecipient.metaAddress) }
        : undefined;

      let fee = 0n;
      let coversGas = true;
      if (feeCtx) {
        const q = await quoteStealthUTXOFee(
          utxo, keys.spendingPrivateKey, keys.viewingPrivateKey, keys.mlkemDecapsKey,
          recipientAddress, calldataBlob, totalAmount, feeCtx.feePay, asset,
        );
        fee = q.fee;
        coversGas = q.coversGas;
      }

      setPrepared({ totalAmount, recipientAddress, calldataBlob, keys, feeCtx, fee, coversGas, display: trimmed });
    } catch (e) {
      console.error("[SpendStealthUTXO] review failed:", e);
      setError("Could not prepare the spend. Try again.");
    } finally {
      setReviewing(false);
    }
  };

  // Confirm: reuse the prepared keys (no second passkey tap) → spend. The fee is
  // re-read from the UTXO's gas in execution, so the charge is exact.
  const handleConfirm = async () => {
    if (!prepared) return;
    setIsLoading(true);
    try {
      const tx = await spendStealthUTXO(
        utxo,
        prepared.totalAmount.toString(),
        prepared.recipientAddress,
        prepared.keys.spendingPrivateKey,
        prepared.keys.viewingPrivateKey,
        prepared.keys.mlkemDecapsKey,
        prepared.calldataBlob,
        undefined,
        prepared.feeCtx,
      );
      if (tx) handleCancel(`Sent from your stealth balance to ${prepared.display}`);
      else handleCancel("Spend failed. Try again.");
    } catch (e) {
      console.error("Spend stealth UTXO error:", e);
      handleCancel(`Failed to spend ${symbol}. Please try again.`);
    } finally {
      setIsLoading(false);
    }
  };

  const feeTooBig = prepared != null && prepared.totalAmount - prepared.fee <= 0n;

  return (
    <Box>
      <Stack spacing={1.7} direction="column" sx={{ width: "100%", maxWidth: 400, mx: "auto" }}>
        <Typography variant="body2" sx={{ color: "text.secondary", textAlign: "center" }}>
          Spending from {utxo.stealthAddress.slice(0, 6)}…{utxo.stealthAddress.slice(-4)}
          {" — available: "}{balance} {symbol}
        </Typography>

        {/* ── FORM ── */}
        {!prepared && (
          <>
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
                  disabled={reviewing || balanceWei <= 0n}
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

            {error && (
              <Typography variant="caption" sx={{ color: "error.main", display: "block", letterSpacing: "0.03em" }}>
                {error}
              </Typography>
            )}

            <Button
              variant="outlined"
              color="primary"
              onClick={handleReview}
              disabled={reviewing || !recipient.trim() || !amount.trim()}
              sx={{ py: 1.5, fontSize: "1rem", borderRadius: 2, mt: 3 }}
            >
              {reviewing ? "Reviewing…" : "Review"}
            </Button>
            <Button variant="text" color="secondary" onClick={() => handleCancel()} sx={{ py: 1, fontSize: "0.9rem" }}>
              Cancel
            </Button>
          </>
        )}

        {/* ── REVIEW ── */}
        {prepared && (
          <>
            <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 2, p: 2 }}>
              <ReviewRow label="To" value={prepared.display} />
              <ReviewRow label="You send" value={`${fmt(prepared.totalAmount)} ${symbol}`} />
              <ReviewRow label="Service fee" value={`${fmt(prepared.fee)} ${symbol}`} />
              {prepared.coversGas && <ReviewRow label="Gas" value="Sponsored" />}
              <ReviewRow
                label="Recipient receives"
                value={feeTooBig ? "—" : `${fmt(prepared.totalAmount - prepared.fee)} ${symbol}`}
                last
              />
            </Box>

            {feeTooBig && (
              <Typography variant="caption" sx={{ color: "error.main", display: "block", mt: 1, letterSpacing: "0.03em" }}>
                Amount too small — the network fee ({fmt(prepared.fee)} {symbol}) exceeds it. Send more.
              </Typography>
            )}

            <Button
              variant="outlined"
              color="primary"
              startIcon={<SendIcon />}
              onClick={handleConfirm}
              disabled={isLoading || feeTooBig}
              sx={{ py: 1.5, fontSize: "1rem", borderRadius: 2, mt: 2 }}
            >
              {isLoading ? "Sending…" : feeTooBig ? "Amount too small" : "Confirm & Send"}
            </Button>
            <Button
              variant="text"
              color="secondary"
              startIcon={<ArrowBackIcon sx={{ fontSize: "0.8rem" }} />}
              onClick={() => setPrepared(null)}
              disabled={isLoading}
              sx={{ py: 1, fontSize: "0.9rem" }}
            >
              Back
            </Button>
          </>
        )}
      </Stack>
    </Box>
  );
};

const ReviewRow = ({ label, value, last }: { label: string; value: React.ReactNode; last?: boolean }) => (
  <Box
    sx={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      py: 1,
      borderBottom: last ? "none" : "1px solid",
      borderColor: "divider",
    }}
  >
    <Typography variant="body2" sx={{ color: "text.secondary" }}>
      {label}
    </Typography>
    <Typography variant="body2" sx={{ textAlign: "right", wordBreak: "break-word", ml: 2 }}>
      {value}
    </Typography>
  </Box>
);
