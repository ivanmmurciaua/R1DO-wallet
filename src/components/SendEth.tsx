import React, { useState, useEffect, useMemo } from "react";
import { Box, Button, MenuItem, Select, Slider, Stack, Typography } from "@mui/material";
import SendIcon from "@mui/icons-material/Send";
import QrCodeScannerIcon from "@mui/icons-material/QrCodeScanner";
import ArrowBackIcon from "@mui/icons-material/ArrowBackIosNew";
import { QrScanner } from "./QrScanner";
import { Safe4337Pack } from "@safe-global/relay-kit";
import { smartSend, smartSendToken, getStealthTotal, quoteSendFee } from "@/lib/deploy";
import { computeFee } from "@/lib/fees";
import { readDirectory } from "@/lib/registry-v2";
import { getTokenBalances } from "@/lib/balances";
import { getSpendableUTXOs, getWalletMeta } from "@/lib/localstorage";
import { nativeAsset, activeTokens, type Asset } from "@/lib/assets";
import { parseUnits, formatUnits, zeroAddress, createPublicClient } from "viem";
import { activeChain, networkName } from "@/lib/networks";
import { sepoliaTransport } from "@/app/constants";
import { isPQMetaAddress } from "@/lib/stealth";

type SendEthProps = {
  wallet: Safe4337Pack;
  username: string;
  balance: number;
  onBack: (message: string) => void;
};

// Recipient resolved at step 1 — front-loads validation so steps 2/3 are clean.
type Resolved = {
  isPrivate: boolean;
  address: string | null; // public destination (or null/zero when pure meta-address)
  metaAddress: `0x${string}` | null;
  display: string; // human label for the review/screens
};

const shorten = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

// Pull a usable recipient out of a scanned QR. A PQ meta-address is kept whole
// (never truncate it). Otherwise extract a 20-byte 0x address if present (also
// handles EIP-681 "ethereum:0x…@chain?…"), else fall back to the raw text so a
// username QR still fills the field.
const recipientFromQr = (text: string): string => {
  const t = text.trim();
  if (isPQMetaAddress(t)) return t;
  const m = t.match(/0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/);
  return m ? m[0] : t;
};

export const SendEth: React.FC<SendEthProps> = ({ wallet, username, onBack }) => {
  const privacy = getWalletMeta(username)?.privacy ?? false;
  const [step, setStep] = useState<1 | 2 | 3>(1);

  const [recipient, setRecipient] = useState("");
  const [resolved, setResolved] = useState<Resolved | null>(null);
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState("");

  const [amount, setAmount] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [scanning, setScanning] = useState(false);
  // Fee estimate for the Review (reads the real gas): the actual fee charged is
  // max(0.1%, gas). `estimatedFee` null until it returns (we fall back to the
  // plain 0.1% margin meanwhile). `gasSponsored` = the 0.1% covers the gas →
  // show the "Gas: Sponsored" row.
  const [estimatedFee, setEstimatedFee] = useState<bigint | null>(null);
  const [gasSponsored, setGasSponsored] = useState<boolean | null>(null);

  // Selected asset (native ⧫ or a curated ERC20). Drives symbol/decimals and the
  // send path. Default = native.
  const [asset, setAsset] = useState<Asset>(() => nativeAsset());
  // Exact spendable in raw units, keyed per asset. Native = main Safe + stealth
  // UTXOs (those hold only native); ERC20 = main Safe only (stealth ERC20 is a
  // later phase). Loaded once on open. Key: token address (lowercased) or "native".
  const [assetBalances, setAssetBalances] = useState<Map<string, bigint>>(new Map());

  const keyOf = (a: Asset) => a.address?.toLowerCase() ?? "native";

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const client = createPublicClient({ chain: activeChain(), transport: sepoliaTransport() });
        const safe = (await wallet.protocolKit.getAddress()) as `0x${string}`;
        const mainWei = BigInt((await wallet.protocolKit.getBalance()).toString());
        // Only a private wallet holds stealth funds — a public one never scans, so
        // skip the stealth store entirely (no needless reads, no impression of it).
        const stealthWei = privacy ? await getStealthTotal(username) : 0n;

        const map = new Map<string, bigint>();
        map.set("native", mainWei + stealthWei);

        // Per token, read over the main Safe + the stealth addresses TAGGED with
        // that token (so private holdings are detected and shown), and sum. The
        // tag narrows each read to the right addresses.
        const stealthUtxos = privacy ? getSpendableUTXOs(username) : [];
        const tokens = activeTokens();
        await Promise.all(
          tokens.map(async (t) => {
            const tokenAddr = t.address as `0x${string}`;
            const addrs = [
              safe,
              ...stealthUtxos.filter((u) => u.asset?.toLowerCase() === tokenAddr.toLowerCase()).map((u) => u.stealthAddress),
            ];
            const bals = await getTokenBalances(client, tokenAddr, addrs);
            map.set(tokenAddr.toLowerCase(), bals.reduce((s, b) => s + b, 0n));
          }),
        );
        if (alive) setAssetBalances(map);
      } catch (e) {
        console.warn("[SendEth] could not load asset balances:", e);
      }
    })();
    return () => {
      alive = false;
    };
  }, [wallet, username, privacy]);

  const symbol = asset.symbol;
  const decimals = asset.decimals;
  // Exact spendable of the selected asset (MAX/slider/validation use this, never
  // a rounded display string). null until balances load.
  const availableWei = assetBalances.has(keyOf(asset)) ? assetBalances.get(keyOf(asset))! : null;

  // Assets the user can actually send: balance > 0. Native goes first. For a
  // PRIVATE recipient only the native asset is offered (ERC20 to a stealth Safe
  // is a later phase) — we never silently downgrade a private send to public.
  const fundedAssets = useMemo(() => {
    const all = [nativeAsset(), ...activeTokens()];
    return all.filter((a) => (assetBalances.get(a.address?.toLowerCase() ?? "native") ?? 0n) > 0n);
  }, [assetBalances]);
  const selectable = fundedAssets;

  // Keep the selected asset valid for the resolved recipient: if the current
  // pick isn't selectable (e.g. recipient turned out private), snap to the first
  // available and reset the amount (decimals/scale differ between assets).
  useEffect(() => {
    if (step !== 2 || selectable.length === 0) return;
    if (!selectable.some((a) => keyOf(a) === keyOf(asset))) {
      setAsset(selectable[0]);
      setAmount("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, selectable]);

  const handleBackToMenu = (message: string = "") => {
    onBack(message);
  };

  // ── helpers ───────────────────────────────────────────────────────────────

  const amountToWei = (a: string): bigint | null => {
    const t = a.trim();
    if (!t) return null;
    try {
      return parseUnits(t, decimals);
    } catch {
      return null;
    }
  };

  const amtWei = amountToWei(amount);
  const amountValid =
    amtWei != null && amtWei > 0n && (availableWei == null || amtWei <= availableWei);
  const overBalance = amtWei != null && availableWei != null && amtWei > availableWei;

  // Display-only formatting (grouped thousands). Exact value always stays in wei
  // (amtWei / availableWei) — the send never uses these rounded strings.
  const fmtDisplay = (n: number, maximumFractionDigits: number) =>
    new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(n);
  const availDisplay =
    availableWei != null ? fmtDisplay(Number(formatUnits(availableWei, decimals)), 4) : "…";
  const amountDisplay = amount ? fmtDisplay(Number(amount), 8) : amount;
  const fmtAmt = (wei: bigint) => fmtDisplay(Number(formatUnits(wei, decimals)), 8);

  // Fee shown in the Review: the plain 0.1% margin (exact, synchronous) until the
  // real-gas estimate returns, then max(0.1%, gas). The breakdown ALWAYS shows —
  // something is always charged (the 0.1% or the gas).
  const marginWei = amtWei != null && amtWei > 0n ? computeFee({ op: "send", asset, amount: amtWei, gasWei: 0n }).fee : 0n;
  const feeWei = estimatedFee ?? marginWei;
  const netWei = amtWei != null ? amtWei - feeWei : null;
  // The fee (gas, on small sends) eats the whole amount → nothing reaches the
  // recipient. Block it: you can't send less than it costs to move.
  const feeTooBig = netWei != null && netWei <= 0n;
  // While the real-gas estimate is in flight the fee shown is the provisional
  // 0.1% margin — block Send so the user never confirms on a not-yet-final fee.
  const estimatingFee = estimatedFee === null;

  // At the Review step, estimate the real fee (reads the gas via a no-submit
  // build): fee = max(0.1%, gas), and whether the 0.1% covers the gas.
  useEffect(() => {
    if (step !== 3 || !resolved || amtWei == null || amtWei <= 0n) return;
    let alive = true;
    setEstimatedFee(null);
    setGasSponsored(null);
    (async () => {
      const q = await quoteSendFee(
        wallet,
        asset.address ? (asset.address as `0x${string}`) : null,
        amtWei,
        (resolved.address ?? zeroAddress) as `0x${string}`,
        resolved.metaAddress,
      );
      if (alive) {
        setEstimatedFee(q.fee);
        setGasSponsored(q.coversGas);
      }
    })();
    return () => {
      alive = false;
    };
  }, [step, resolved, amtWei, asset, wallet]);

  // Slider as a % of the available balance (derived from the typed amount).
  const pct =
    availableWei && availableWei > 0n && amtWei != null
      ? Math.min(100, Number((amtWei * 10000n) / availableWei) / 100)
      : 0;

  const setPct = (p: number) => {
    if (!availableWei || availableWei <= 0n) return;
    const bips = BigInt(Math.round(Math.max(0, Math.min(100, p)) * 100)); // 0..10000
    const wei = (availableWei * bips) / 10000n;
    setAmount(formatUnits(wei, decimals));
  };

  // v2: usernames resolve through the Argon2id-encrypted directory (~1s). If the
  // entry carries a PQ meta-address, the send turns private for free.
  const resolveStep1 = async (
    input: string,
  ): Promise<{ ok: true; res: Resolved } | { ok: false; error: string }> => {
    const t = input.trim();
    if (!t) return { ok: false, error: "Enter a recipient" };

    if (isPQMetaAddress(t)) {
      return {
        ok: true,
        res: { isPrivate: true, address: zeroAddress, metaAddress: t as `0x${string}`, display: `${t.slice(0, 10)}…` },
      };
    }
    if (t.startsWith("0x") && t.length === 42) {
      return { ok: true, res: { isPrivate: false, address: t, metaAddress: null, display: shorten(t) } };
    }

    const entry = await readDirectory(t);
    if (!entry) return { ok: false, error: "Recipient not found" };
    if (entry.metaAddress) {
      return { ok: true, res: { isPrivate: true, address: entry.safeAddress, metaAddress: entry.metaAddress, display: t } };
    }
    return { ok: true, res: { isPrivate: false, address: entry.safeAddress, metaAddress: null, display: `${t} → ${shorten(entry.safeAddress)}` } };
  };

  const continueFromRecipient = async () => {
    setResolving(true);
    setResolveError("");
    try {
      const r = await resolveStep1(recipient);
      if (!r.ok) {
        setResolveError(r.error);
        return;
      }
      setResolved(r.res);
      setStep(2);
    } finally {
      setResolving(false);
    }
  };

  const handleConfirm = async () => {
    if (!resolved || amtWei == null) return;
    if (availableWei != null && amtWei > availableWei) {
      handleBackToMenu(`Amount exceeds your balance (${formatUnits(availableWei, decimals)} ${symbol}).`);
      return;
    }
    setIsLoading(true);
    try {
      // ERC20 — one path for public and private: draws from the main Safe and,
      // if short, drains stealth UTXOs tagged with this token (private derives a
      // one-time stealth destination + blob). Mirrors the native smartSend.
      if (asset.kind === "erc20") {
        const result = await smartSendToken(
          wallet,
          asset.address as `0x${string}`,
          (resolved.address ?? zeroAddress) as `0x${string}`,
          amtWei,
          username,
          resolved.metaAddress,
        );
        const priv = resolved.isPrivate ? " privately" : "";
        if (result.success) {
          handleBackToMenu(`Sent ${amount} ${symbol}${priv} to ${resolved.display}`);
        } else if (result.sentAmount > 0n) {
          const sentFormatted = formatUnits(result.sentAmount, decimals);
          handleBackToMenu(`Sent ${sentFormatted} of ${amount} ${symbol} to ${resolved.display} — try again to send the rest.`);
        } else {
          handleBackToMenu(result.error ?? `Failed to send ${amount} ${symbol} to ${resolved.display}. Try again later`);
        }
        return;
      }

      const result = await smartSend(
        wallet,
        (resolved.address ?? zeroAddress) as `0x${string}`,
        amtWei,
        username,
        resolved.metaAddress,
      );
      const priv = resolved.isPrivate ? " privately" : "";
      if (result.success) {
        handleBackToMenu(`Sent ${amount} ${symbol}${priv} to ${resolved.display}`);
      } else if (result.sentAmount > 0n) {
        const sentFormatted = formatUnits(result.sentAmount, decimals);
        handleBackToMenu(`Sent ${sentFormatted} of ${amount} ${symbol} to ${resolved.display} — try again to send the rest.`);
      } else {
        handleBackToMenu(result.error ?? `Failed to send ${amount} ${symbol} to ${resolved.display}. Try again later`);
      }
    } catch (error) {
      console.error("Send transaction error:", error);
      handleBackToMenu(`Failed to send ${symbol}. Please try again.`);
    } finally {
      setIsLoading(false);
    }
  };

  // ── UI ──────────────────────────────────────────────────────────────────

  const PrivacyChip = ({ isPrivate }: { isPrivate: boolean }) => (
    <Box
      component="span"
      sx={{
        fontSize: "0.62rem",
        letterSpacing: "0.12em",
        px: 0.9,
        py: 0.25,
        borderRadius: "2px",
        border: "1px solid currentColor",
        color: isPrivate ? "primary.main" : "text.secondary",
        opacity: 0.85,
        whiteSpace: "nowrap",
      }}
    >
      {isPrivate ? "PRIVATE" : "PUBLIC"}
    </Box>
  );

  return (
    <Box>
      {scanning && (
        <QrScanner
          onResult={(text) => {
            setRecipient(recipientFromQr(text));
            setResolved(null);
            setResolveError("");
            setScanning(false);
          }}
          onClose={() => setScanning(false)}
        />
      )}

      <Stack spacing={1.7} direction="column" sx={{ width: "100%", maxWidth: 400, mx: "auto" }}>
        {/* Step indicator */}
        <Stack direction="row" spacing={1} sx={{ alignItems: "center", justifyContent: "center", mb: 0.5 }}>
          {(["Recipient", "Amount", "Review"] as const).map((label, i) => {
            const n = (i + 1) as 1 | 2 | 3;
            const active = step === n;
            const done = step > n;
            return (
              <React.Fragment key={label}>
                {i > 0 && <Box sx={{ width: 18, height: "1px", bgcolor: "text.secondary", opacity: 0.4 }} />}
                <Typography
                  variant="caption"
                  sx={{
                    fontSize: "0.7rem",
                    letterSpacing: "0.04em",
                    color: active ? "primary.main" : "text.secondary",
                    opacity: active ? 1 : done ? 0.8 : 0.45,
                    fontWeight: active ? 700 : 400,
                  }}
                >
                  {done ? "✓ " : `${n}. `}
                  {label}
                </Typography>
              </React.Fragment>
            );
          })}
        </Stack>

        {/* ── STEP 1 — Recipient ── */}
        {step === 1 && (
          <>
            <Box>
              <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1 }}>
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  To (username or address)
                </Typography>
                <Button
                  variant="text"
                  color="primary"
                  size="small"
                  startIcon={<QrCodeScannerIcon sx={{ fontSize: "1rem" }} />}
                  onClick={() => setScanning(true)}
                  disabled={resolving}
                  sx={{ minWidth: 0, px: 1, fontSize: "0.7rem" }}
                >
                  Scan
                </Button>
              </Box>
              <input
                type="text"
                value={recipient}
                onChange={(e) => {
                  setRecipient(e.target.value);
                  setResolved(null);
                  setResolveError("");
                }}
                placeholder="_ username or 0x address"
                style={inputStyle}
                onFocus={(e) => (e.target.style.opacity = "1")}
                onBlur={(e) => (e.target.style.opacity = "0.7")}
              />
              {resolveError && (
                <Typography variant="caption" sx={{ color: "error.main", mt: 0.8, display: "block" }}>
                  {resolveError}
                </Typography>
              )}
            </Box>

            <Button
              variant="outlined"
              color="primary"
              onClick={continueFromRecipient}
              disabled={resolving || !recipient.trim()}
              sx={{ py: 1.5, fontSize: "1rem", borderRadius: 2, mt: 2 }}
            >
              {resolving ? "Resolving…" : "Continue"}
            </Button>
            <Button variant="text" color="secondary" onClick={() => handleBackToMenu()} sx={{ py: 1, fontSize: "0.9rem" }}>
              Cancel
            </Button>
          </>
        )}

        {/* ── STEP 2 — Amount ── */}
        {step === 2 && resolved && (
          <>
            <Stack direction="row" spacing={1} sx={{ alignItems: "center", mb: 0.5 }}>
              <Typography variant="body2" sx={{ color: "text.secondary", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                To {resolved.display}
              </Typography>
              <PrivacyChip isPrivate={resolved.isPrivate} />
            </Stack>

            {/* Asset selector — only assets the user actually holds (>0). A single
                holding renders as a fixed label (nothing to switch to). */}
            <Box>
              <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1 }}>
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  Asset
                </Typography>
                {selectable.length > 1 ? (
                  <Select
                    value={keyOf(asset)}
                    onChange={(e) => {
                      const next = selectable.find((a) => keyOf(a) === e.target.value);
                      if (next) {
                        setAsset(next);
                        setAmount("");
                      }
                    }}
                    size="small"
                    variant="standard"
                    sx={{
                      fontFamily: "var(--font-geist-mono), monospace",
                      fontSize: "0.9rem",
                      letterSpacing: "0.04em",
                      minWidth: 120,
                    }}
                  >
                    {selectable.map((a) => (
                      <MenuItem key={keyOf(a)} value={keyOf(a)} sx={{ fontFamily: "var(--font-geist-mono), monospace", fontSize: "0.85rem" }}>
                        {a.symbol}
                      </MenuItem>
                    ))}
                  </Select>
                ) : (
                  <Typography
                    sx={{ fontFamily: "var(--font-geist-mono), monospace", fontSize: "0.9rem", letterSpacing: "0.04em" }}
                  >
                    {(selectable[0] ?? asset).symbol}
                  </Typography>
                )}
              </Box>
            </Box>

            <Box>
              <Typography variant="body2" sx={{ color: "text.secondary", mb: 1 }}>
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
              <Typography
                variant="caption"
                sx={{
                  color: overBalance ? "error.main" : "text.secondary",
                  display: "block",
                  mt: 0.8,
                  letterSpacing: "0.03em",
                  opacity: 0.85,
                }}
              >
                Available: {availDisplay} {symbol}
              </Typography>
            </Box>

            {/* Balance slider + quick percentages */}
            <Box sx={{ px: 0.5 }}>
              <Slider
                value={pct}
                onChange={(_, v) => setPct(v as number)}
                disabled={!availableWei || availableWei <= 0n}
                marks={[0, 25, 50, 75, 100].map((v) => ({ value: v }))}
                step={1}
                min={0}
                max={100}
                size="small"
                sx={{ color: "primary.main" }}
              />
              <Stack direction="row" spacing={1} sx={{ justifyContent: "space-between", mt: 0.5 }}>
                {[25, 50, 75, 100].map((p) => (
                  <Button
                    key={p}
                    variant="text"
                    size="small"
                    onClick={() => setPct(p)}
                    disabled={!availableWei || availableWei <= 0n}
                    sx={{ minWidth: 0, px: 1, fontSize: "0.7rem", flex: 1 }}
                  >
                    {p === 100 ? "MAX" : `${p}%`}
                  </Button>
                ))}
              </Stack>
            </Box>

            <Button
              variant="outlined"
              color="primary"
              onClick={() => setStep(3)}
              disabled={!amountValid}
              sx={{ py: 1.5, fontSize: "1rem", borderRadius: 2, mt: 2 }}
            >
              {overBalance ? "Exceeds balance" : "Review"}
            </Button>
            <Button
              variant="text"
              color="secondary"
              startIcon={<ArrowBackIcon sx={{ fontSize: "0.8rem" }} />}
              onClick={() => setStep(1)}
              sx={{ py: 1, fontSize: "0.9rem" }}
            >
              Back
            </Button>
          </>
        )}

        {/* ── STEP 3 — Review ── */}
        {step === 3 && resolved && (
          <>
            <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 2, p: 2 }}>
              <ReviewRow
                label="Type"
                value={
                  <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                    <PrivacyChip isPrivate={resolved.isPrivate} />
                    <Typography variant="body2" sx={{ color: "text.secondary" }}>
                      · {networkName()}
                    </Typography>
                  </Box>
                }
              />
              <ReviewRow label="To" value={resolved.display} />
              <ReviewRow label="You send" value={`${amountDisplay} ${symbol}`} />
              <ReviewRow label="Service fee" value={`${fmtAmt(feeWei)} ${symbol}`} />
              {gasSponsored === true && <ReviewRow label="Gas" value="Sponsored" />}
              <ReviewRow
                label="Recipient receives"
                value={feeTooBig ? "—" : netWei != null ? `${fmtAmt(netWei)} ${symbol}` : "…"}
                last
              />
            </Box>

            {feeTooBig && (
              <Typography variant="caption" sx={{ color: "error.main", display: "block", mt: 1, letterSpacing: "0.03em" }}>
                Amount too small — the network fee ({fmtAmt(feeWei)} {symbol}) exceeds it. Send more.
              </Typography>
            )}

            <Button
              variant="outlined"
              color="primary"
              startIcon={<SendIcon />}
              onClick={handleConfirm}
              disabled={isLoading || feeTooBig || estimatingFee}
              sx={{ py: 1.5, fontSize: "1rem", borderRadius: 2, mt: 2 }}
            >
              {isLoading
                ? "Sending…"
                : estimatingFee
                  ? "Estimating fee…"
                  : feeTooBig
                    ? "Amount too small"
                    : "Confirm & Send"}
            </Button>
            <Button
              variant="text"
              color="secondary"
              startIcon={<ArrowBackIcon sx={{ fontSize: "0.8rem" }} />}
              onClick={() => setStep(2)}
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
    {typeof value === "string" ? (
      <Typography variant="body2" sx={{ textAlign: "right", wordBreak: "break-word", ml: 2 }}>
        {value}
      </Typography>
    ) : (
      value
    )}
  </Box>
);

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
