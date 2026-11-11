"use client";

// FrameWalletKit: the wallet-style building blocks shared by both Hegota rail homes (FrameHome and
// FrameStealthHome). They reproduce the look and flow of the app's normal wallet (balance card,
// persistent bottom action bar, receive view with QR + tap-to-copy address card, send flow with a
// review step) without importing any 4337 logic: only generic presentational components (QrCode,
// QrScanner, GlitchText, ProgressBar) and the global hide-balance preference are reused.
//
// Rail-owned and removable like the other Frame* components.
import { useState, type ReactNode } from "react";
import { Box, Button, IconButton, Stack, Typography } from "@mui/material";
import VisibilityIcon from "@mui/icons-material/Visibility";
import VisibilityOffIcon from "@mui/icons-material/VisibilityOff";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import ArrowDownwardIcon from "@mui/icons-material/ArrowDownward";
import TuneIcon from "@mui/icons-material/Tune";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CheckIcon from "@mui/icons-material/Check";
import SendIcon from "@mui/icons-material/Send";
import QrCodeScannerIcon from "@mui/icons-material/QrCodeScanner";
import { formatEther, parseEther, isAddress } from "viem";
import { GlitchText } from "@/components/GlitchText";
import { QrCode } from "@/components/QrCode";
import { QrScanner } from "@/components/QrScanner";
import { ProgressBar } from "@/components/ProgressBar";
import FrameSection from "@/components/FrameSection";
import FrameTxView from "@/components/FrameTxView";
import { getHideBalance, setHideBalance } from "@/lib/localstorage";
import { loadFromDevice } from "@/lib/passkeys";
import { getWalletCredential } from "@/lib/credstore";
import { LOCAL_LAST_USER } from "@/app/constants";
import { HEGOTA } from "@/lib/frame/network";
import type { PqSpendResult, PqScheme } from "@/lib/frame/pqClient";

export const MONO = "var(--font-geist-mono), monospace";

/** Tiny uppercase tracking caption, the wallet's label style. */
export const captionSx = { fontSize: "0.62rem", opacity: 0.6, letterSpacing: "0.1em", textTransform: "uppercase" as const };

/** Native input style shared with the wallet's send forms. */
export const inputStyle: React.CSSProperties = {
  width: "100%",
  fontSize: "1rem",
  fontFamily: MONO,
  borderRadius: "2px",
  border: "1px solid currentColor",
  background: "transparent",
  color: "inherit",
  padding: "12px 14px",
  letterSpacing: "0.04em",
  outline: "none",
};

/** Space the fixed ActionBar takes at the bottom of every view. */
export const BAR_SPACE = "96px";

// Reads LOCAL_LAST_USER, fetches the stored credential, and taps the authenticator to get the
// 32-byte PRF root the rail derives its post-quantum keys from.
export async function tapForPrf(): Promise<Uint8Array> {
  const user = typeof localStorage !== "undefined" ? localStorage.getItem(LOCAL_LAST_USER) : null;
  if (!user) throw new Error("log in with a passkey first");
  const cred = await getWalletCredential(user);
  if (!cred?.rawId) throw new Error("no credential found for this wallet");
  const prf = await loadFromDevice(cred.rawId);
  if (!prf || prf.length !== 32) throw new Error("authenticator has no 32-byte PRF support");
  return prf;
}

/** Amount for display: up to 6 decimals, trailing zeros trimmed (testnet amounts are small). */
export function fmtAmount(wei: bigint): string {
  const n = Number(formatEther(wei));
  if (n === 0) return "0";
  if (n < 0.000001) return "<0.000001";
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 6 }).format(n);
}

export const shortAddr = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** The global hide-balance preference (the same eye as the rest of the wallet). */
export function useHideBalance(): [boolean, () => void] {
  const [hidden, setHidden] = useState<boolean>(() => {
    try {
      return getHideBalance();
    } catch {
      return false;
    }
  });
  const toggle = () => {
    const next = !hidden;
    setHidden(next);
    try {
      setHideBalance(next);
    } catch {
      /* storage unavailable: the toggle still works for this view */
    }
  };
  return [hidden, toggle];
}

/** An amount that turns into the glitch scramble when balances are hidden. */
export function Amount({ wei, hidden, length = 4 }: { wei: bigint; hidden: boolean; length?: number }) {
  return <>{hidden ? <GlitchText length={length} /> : fmtAmount(wei)} {HEGOTA.symbol}</>;
}

/** Balance card: caption + eye, big mono amount, subline. `wei` null = still reading. */
export function BalanceCard({
  wei, hidden, onToggleHide, subline, caption = "Your balance", children,
}: {
  wei: bigint | null; hidden: boolean; onToggleHide: () => void; subline: ReactNode; caption?: string; children?: ReactNode;
}) {
  return (
    <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: "2px", p: 2, textAlign: "left" }}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1, mb: 0.5 }}>
        <Box sx={captionSx}>{caption}</Box>
        <IconButton size="small" onClick={onToggleHide} aria-label={hidden ? "show balance" : "hide balance"} sx={{ p: 0.25 }}>
          {hidden ? <VisibilityOffIcon sx={{ fontSize: "1rem" }} /> : <VisibilityIcon sx={{ fontSize: "1rem" }} />}
        </IconButton>
      </Box>
      <Typography sx={{ fontFamily: MONO, fontSize: "2rem", lineHeight: 1.1, fontWeight: 500, wordBreak: "break-all", userSelect: "none" }}>
        {wei === null ? "…" : <Amount wei={wei} hidden={hidden} length={7} />}
      </Typography>
      <Box sx={{ fontFamily: MONO, fontSize: "0.7rem", opacity: 0.6, mt: 0.75, letterSpacing: "0.04em" }}>{subline}</Box>
      {children}
    </Box>
  );
}

export type BarSlot = "send" | "receive" | "details";

/** Persistent bottom action bar (fixed), like the wallet's: Send, Receive, Details. */
export function ActionBar({
  active, onSelect, sendDisabled,
}: { active: BarSlot | null; onSelect: (s: BarSlot) => void; sendDisabled?: boolean }) {
  const slots: { id: BarSlot; label: string; icon: ReactNode; disabled?: boolean }[] = [
    { id: "send", label: "Send", icon: <ArrowUpwardIcon fontSize="small" />, disabled: sendDisabled },
    { id: "receive", label: "Receive", icon: <ArrowDownwardIcon fontSize="small" /> },
    { id: "details", label: "Details", icon: <TuneIcon fontSize="small" /> },
  ];
  return (
    <Box sx={{ position: "fixed", bottom: 0, left: 0, right: 0, zIndex: 1100, bgcolor: "background.default", borderTop: "1px solid", borderColor: "divider", pb: "env(safe-area-inset-bottom)" }}>
      <Stack direction="row" sx={{ maxWidth: 460, mx: "auto" }}>
        {slots.map((s) => {
          const on = active === s.id;
          return (
            <Button
              key={s.id}
              onClick={() => onSelect(s.id)}
              disabled={s.disabled}
              sx={{ flex: 1, minWidth: 0, flexDirection: "column", gap: 0.25, py: 1.25, borderRadius: 0, color: on ? "primary.main" : "text.primary", bgcolor: on ? "action.selected" : "transparent" }}
            >
              {s.icon}
              <Typography sx={{ fontSize: "0.6rem", letterSpacing: "0.08em", textTransform: "uppercase" }}>{s.label}</Typography>
            </Button>
          );
        })}
      </Stack>
    </Box>
  );
}

/** Sub-view header: back arrow + centered title. */
export function SubHeader({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", width: "100%", maxWidth: 400, mx: "auto", mb: 1 }}>
      <IconButton onClick={onBack} aria-label="Back"><ArrowBackIcon /></IconButton>
      <Typography sx={{ flex: 1, textAlign: "center", fontWeight: 600, letterSpacing: "0.02em", mr: 4 }}>{title}</Typography>
    </Box>
  );
}

/** Tap-to-copy address card. */
export function AddressCard({ address, caption = "Your address" }: { address: string; caption?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable: the full address is shown to copy by hand */
    }
  }
  return (
    <Box
      onClick={() => void copy()}
      sx={{ width: "100%", border: "1px solid", borderColor: copied ? "success.main" : "divider", borderRadius: 2, px: 1.75, py: 1.5, cursor: "pointer", "&:hover": { borderColor: copied ? "success.main" : "primary.main" } }}
    >
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 0.5 }}>
        <Box sx={captionSx}>{caption}</Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, color: copied ? "success.main" : "primary.main" }}>
          {copied ? <CheckIcon sx={{ fontSize: "0.95rem" }} /> : <ContentCopyIcon sx={{ fontSize: "0.95rem" }} />}
          <Box component="span" sx={{ fontSize: "0.68rem" }}>{copied ? "copied" : "copy"}</Box>
        </Box>
      </Box>
      <Box sx={{ fontFamily: MONO, fontSize: "0.82rem", wordBreak: "break-all", lineHeight: 1.5 }}>{address}</Box>
    </Box>
  );
}

/** QR + caption + address card + optional footnote/children, centered. */
export function ReceiveBlock({ address, caption, footnote, children }: { address: string; caption?: string; footnote?: ReactNode; children?: ReactNode }) {
  return (
    <Stack spacing={2.5} sx={{ width: "100%", maxWidth: 400, mx: "auto", alignItems: "center" }}>
      <QrCode value={address} size={232} />
      <Typography variant="body2" sx={{ color: "text.secondary", lineHeight: 1.6, maxWidth: 300, textAlign: "center" }}>
        Scan to send, or copy the address below.
      </Typography>
      <AddressCard address={address} caption={caption} />
      {footnote && <Box sx={{ fontFamily: MONO, fontSize: "0.62rem", opacity: 0.5, textAlign: "center" }}>{footnote}</Box>}
      {children}
    </Stack>
  );
}

/** One label/value row of the review box. */
export function ReviewRow({ label, value, last }: { label: string; value: ReactNode; last?: boolean }) {
  return (
    <Box sx={{ display: "flex", justifyContent: "space-between", py: 1, borderBottom: last ? "none" : "1px solid", borderColor: "divider" }}>
      <Typography variant="body2" sx={{ color: "text.secondary" }}>{label}</Typography>
      <Typography variant="body2" component="div" sx={{ textAlign: "right", ml: 2, wordBreak: "break-all" }}>{value}</Typography>
    </Box>
  );
}

type Step = "form" | "review" | "sending" | "done" | "error";

/**
 * Send flow shared by both homes: form (recipient + QR scan + amount + MAX) -> review -> sending
 * -> result (with the decoded frame tx). MAX means "send all" (the rail's sweep: the whole balance
 * when sponsored, the balance minus the self-pay reserve otherwise). `run` taps the passkey and
 * spends; it receives a progress callback for the rail's resubmit events.
 */
export function SendFlow({
  fromLabel, availableWei, scheme, sponsored, gasText, run, onClose,
}: {
  fromLabel: string;
  availableWei: bigint;
  scheme: PqScheme;
  sponsored: boolean;
  gasText: string;
  run: (recipient: `0x${string}`, valueWei: bigint, sweep: boolean, onProgress: (text: string) => void) => Promise<PqSpendResult>;
  onClose: (result: PqSpendResult | null) => void;
}) {
  const [step, setStep] = useState<Step>("form");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [sweep, setSweep] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [scan, setScan] = useState(false);
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState<PqSpendResult | null>(null);

  const recipient = to.trim();
  let valueWei = 0n;
  let amountErr: string | null = null;
  if (!sweep && amount.trim()) {
    try {
      valueWei = parseEther(amount.trim());
      if (valueWei <= 0n) amountErr = "amount must be greater than zero";
      else if (valueWei > availableWei) amountErr = "exceeds balance";
    } catch {
      amountErr = "enter a valid amount";
    }
  }
  const canReview = isAddress(recipient) && (sweep ? availableWei > 0n : amount.trim().length > 0 && !amountErr);

  async function confirm() {
    setStep("sending");
    setErr(null);
    setProgress("tap your key...");
    try {
      const res = await run(recipient as `0x${string}`, valueWei, sweep, setProgress);
      setResult(res);
      setStep("done");
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "send failed");
      setStep("error");
    }
  }

  const steps = ["Recipient & amount", "Review", "Sent"];
  const idx = step === "form" ? 0 : step === "review" ? 1 : 2;

  return (
    <Stack spacing={1.7} sx={{ width: "100%", maxWidth: 400, mx: "auto" }}>
      {scan && (
        <QrScanner
          onResult={(text) => { setTo(text.replace(/^ethereum:/i, "").split(/[@?]/)[0]); setScan(false); }}
          onClose={() => setScan(false)}
        />
      )}
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 1, flexWrap: "wrap" }}>
        {steps.map((s, i) => (
          <Box key={s} sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            {i > 0 && <Box sx={{ width: 18, height: "1px", bgcolor: "text.secondary", opacity: 0.4 }} />}
            <Typography variant="caption" sx={{ fontSize: "0.7rem", letterSpacing: "0.04em", color: i === idx ? "primary.main" : "inherit", fontWeight: i === idx ? 700 : 400, opacity: i < idx ? 0.8 : i === idx ? 1 : 0.45 }}>
              {i < idx ? "✓ " : `${i + 1}. `}{s}
            </Typography>
          </Box>
        ))}
      </Box>
      <Typography variant="body2" sx={{ color: "text.secondary", textAlign: "center" }}>
        From {fromLabel} · available {fmtAmount(availableWei)} {HEGOTA.symbol}
      </Typography>

      {step === "form" && (
        <>
          <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <Typography variant="body2">To (0x address)</Typography>
            <Button size="small" variant="text" startIcon={<QrCodeScannerIcon />} onClick={() => setScan(true)}>Scan</Button>
          </Box>
          <input style={inputStyle} placeholder="_ 0x address" value={to} onChange={(e) => setTo(e.target.value)} spellCheck={false} autoComplete="off" />
          {recipient.length > 0 && !isAddress(recipient) && (
            <Typography variant="caption" sx={{ color: "error.main" }}>enter a valid 0x address (no nicknames on this rail)</Typography>
          )}
          <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mt: 1 }}>
            <Typography variant="body2">Amount ({HEGOTA.symbol})</Typography>
            <Button size="small" variant={sweep ? "contained" : "text"} onClick={() => { setSweep((v) => !v); setAmount(""); }} sx={{ fontSize: "0.7rem" }} disabled={availableWei === 0n}>
              MAX
            </Button>
          </Box>
          <input
            style={inputStyle}
            placeholder={sweep ? "all" : "0.0"}
            inputMode="decimal"
            value={sweep ? "" : amount}
            disabled={sweep}
            onChange={(e) => setAmount(e.target.value)}
          />
          <Typography variant="caption" sx={{ color: amountErr ? "error.main" : "text.secondary" }}>
            {sweep
              ? sponsored ? "sends the whole balance (the paymaster pays the gas)" : "sends the balance minus the self-pay gas reserve"
              : amountErr ?? `Available: ${fmtAmount(availableWei)} ${HEGOTA.symbol}`}
          </Typography>
          <Button variant="outlined" color="primary" disabled={!canReview} onClick={() => setStep("review")} sx={{ py: 1.5, fontSize: "1rem", borderRadius: 2, mt: 2 }}>
            Review
          </Button>
          <Button variant="text" color="secondary" onClick={() => onClose(null)} sx={{ py: 1, fontSize: "0.9rem" }}>Cancel</Button>
        </>
      )}

      {step === "review" && (
        <>
          <Box sx={{ border: "1px solid", borderColor: "divider", borderRadius: 2, p: 2 }}>
            <ReviewRow label="From" value={<Box component="span" sx={{ fontFamily: MONO }}>{fromLabel}</Box>} />
            <ReviewRow label="To" value={<Box component="span" sx={{ fontFamily: MONO }}>{shortAddr(recipient)}</Box>} />
            <ReviewRow label="You send" value={sweep ? "everything" : `${fmtAmount(valueWei)} ${HEGOTA.symbol}`} />
            <ReviewRow label="Signature" value={`${scheme} (post-quantum)`} />
            <ReviewRow label="Gas" value={gasText} />
            <ReviewRow label="Recipient receives" value={sweep ? (sponsored ? "the whole balance" : "balance minus gas reserve") : `${fmtAmount(valueWei)} ${HEGOTA.symbol}`} last />
          </Box>
          <Button variant="outlined" color="primary" startIcon={<SendIcon />} onClick={() => void confirm()} sx={{ py: 1.5, fontSize: "1rem", borderRadius: 2, mt: 2 }}>
            Confirm & Send
          </Button>
          <Button variant="text" color="secondary" startIcon={<ArrowBackIcon />} onClick={() => setStep("form")}>Back</Button>
        </>
      )}

      {step === "sending" && (
        <Stack spacing={1.5} sx={{ alignItems: "center", py: 2 }}>
          <ProgressBar done={0} total={0} label={progress} showCount={false} />
          <Typography variant="caption" sx={{ color: "text.secondary", textAlign: "center" }}>
            {scheme === "ML-DSA-44" ? "ML-DSA signing and its 24.7 KB witness take a few seconds." : "Deploys the account on its first spend."}
          </Typography>
        </Stack>
      )}

      {step === "done" && result && (
        <>
          <Box sx={{ border: "1px solid", borderColor: "success.main", borderRadius: 2, p: 2 }}>
            <Typography sx={{ color: "success.main", fontWeight: 600, mb: 0.5 }}>Sent</Typography>
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              {result.deployTxHash ? "Account deployed and spent. " : ""}
              {result.mode === "sponsored" ? "Gas paid by the keyless paymaster; your account paid 0 gas." : "Self-pay fallback: this account paid the gas."}
            </Typography>
          </Box>
          <DecodedSection decoded={result.decoded} id="send.result.decoded" />
          <Button variant="outlined" color="primary" onClick={() => onClose(result)} sx={{ py: 1.5, fontSize: "1rem", borderRadius: 2 }}>Done</Button>
        </>
      )}

      {step === "error" && (
        <>
          <Box sx={{ border: "1px solid", borderColor: "error.main", borderRadius: 2, p: 2 }}>
            <Typography sx={{ color: "error.main", fontWeight: 600, mb: 0.5 }}>Not sent</Typography>
            <Typography variant="body2" sx={{ color: "text.secondary", wordBreak: "break-word" }}>{err}</Typography>
          </Box>
          <Button variant="outlined" color="primary" onClick={() => setStep("review")} sx={{ py: 1.5, borderRadius: 2 }}>Try again</Button>
          <Button variant="text" color="secondary" onClick={() => onClose(null)}>Close</Button>
        </>
      )}
    </Stack>
  );
}

/** The decoded frame tx(s) of a spend, collapsible. */
export function DecodedSection({ decoded, id, title = "Frame-tx decoded: what you signed", defaultOpen }: {
  decoded: PqSpendResult["decoded"]; id: string; title?: string; defaultOpen?: boolean;
}) {
  return (
    <FrameSection id={id} title={title} defaultOpen={defaultOpen}>
      <Box sx={{ fontSize: "0.68rem", opacity: 0.55, mb: 0.5 }}>
        No opaque UserOp: this is the actual EIP-8141 frame transaction, frame by frame.
      </Box>
      {decoded.deploy && <FrameTxView d={decoded.deploy} />}
      <FrameTxView d={decoded.spend} />
    </FrameSection>
  );
}
