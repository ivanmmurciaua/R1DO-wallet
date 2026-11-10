"use client";

// FrameSchemePicker: the post-quantum scheme selector shared by both rail homes (FrameHome and
// FrameStealthHome), plus the per-scheme facts they render (labels, verifier, gas notes).
//
// Rail-owned and removable like the other Frame* components: it reads the selection and each
// scheme's paymaster status through src/lib/frame/pqClient.ts only. The selection itself is stored
// by pqClient (per device user); this component just shows it, changes it, and shows for the
// SELECTED scheme its tradeoffs, which keyless paymaster sponsors it and whether it is in self-pay
// fallback. Both schemes' statuses are read up front so switching shows the new line instantly.
import { useState, useEffect } from "react";
import { Box, Link, ToggleButton, ToggleButtonGroup } from "@mui/material";
import { formatEther } from "viem";
import { HEGOTA } from "@/lib/frame/network";
import { railStatus, PQ_SCHEMES, type PqScheme, type PqRailStatus } from "@/lib/frame/pqClient";
import { shortHex } from "@/components/FrameTxView";
import { FrameExplain } from "@/components/FrameSection";

type Addr = `0x${string}`;

/** Per-scheme facts for the UI copy. */
export const SCHEME_INFO: Record<PqScheme, {
  button: string; family: string; keyText: string; accountClass: string;
  verifier?: Addr; verifierText: string; verifyGas: string;
  /** Tradeoff copy shown only for the selected scheme: what it gives you vs what it costs you. */
  gives: string; costs: string;
}> = {
  "leanSphincs-s": {
    button: "leanSphincs-s (hash-based, ~50K gas)",
    family: "SPHINCS+ family · hash-based, no lattices",
    keyText: "a leanSphincs-s hash-based post-quantum key",
    accountClass: "SphincsFrameAccountS",
    verifier: HEGOTA.singletons?.lssVerifier,
    verifierText: "leanSphincs-s verifier, called by your account's frame module in its VERIFY frame",
    verifyGas: "~50K gas",
    gives:
      "Security from hash functions alone (no lattice assumptions) and cheap spends: ~50K gas to verify, about 25x less " +
      "than ML-DSA-44, and ~290K gas per spend, about 5x less.",
    costs:
      "Its keys cannot be blinded: only YOU can create your stealth addresses. Nobody can derive one for you from your " +
      "public meta-address, so third parties cannot pay you privately this way. Each key also has a finite signature " +
      "budget (the wallet counts it).",
  },
  "ML-DSA-44": {
    button: "ML-DSA-44 (lattice, blindable, ~1.25M gas)",
    family: "FIPS-204 (Dilithium) · lattice-based",
    keyText: "an ML-DSA-44 lattice post-quantum key",
    accountClass: "AccountMldsaS",
    verifier: HEGOTA.singletons?.verifier,
    verifierText: "ZKNOX packed ML-DSA-44 verifier (unaudited, testnet), called by your account in its atomic verify frame",
    verifyGas: "~1.25M gas",
    gives:
      "Its keys can be blinded: from your public meta-address alone, anyone can derive a fresh stealth address that only " +
      "you can spend. That is what lets a third party pay you privately (planned for a future version of this rail).",
    costs:
      `Relies on lattice assumptions, and each spend costs ~1.6M gas (~0.00016 ${HEGOTA.symbol} at current fees), ` +
      "mostly for the ~24.7 KB witness calldata.",
  },
};

const fmtBal = (wei: string): string => `${Number(formatEther(BigInt(wei))).toFixed(4)} ${HEGOTA.symbol}`;

/** Human gas-mode line for one scheme's rail status. */
export function gasLine(rail: PqRailStatus | null): string {
  if (!rail) return "-";
  if (rail.mode === "sponsored" && rail.paymaster) return `sponsored by keyless paymaster ${shortHex(rail.paymaster)} (${fmtBal(rail.paymasterBalanceWei)})`;
  if (rail.fallbackReason === "underfunded" && rail.paymaster) return `self-pay fallback (paymaster ${shortHex(rail.paymaster)} out of funds: ${fmtBal(rail.paymasterBalanceWei)})`;
  if (rail.fallbackReason === "not-gated" && rail.paymaster) return `self-pay fallback (paymaster ${shortHex(rail.paymaster)} does not gate this account class)`;
  return "self-pay fallback (paymaster missing)";
}

export default function FrameSchemePicker({
  scheme, onChange, disabled, context,
}: { scheme: PqScheme; onChange: (s: PqScheme) => void; disabled?: boolean; context: "transparent" | "stealth" }) {
  const [rails, setRails] = useState<Partial<Record<PqScheme, PqRailStatus>>>({});

  useEffect(() => {
    let live = true;
    for (const s of PQ_SCHEMES) {
      railStatus(s).then((r) => { if (live) setRails((prev) => ({ ...prev, [s]: r })); }).catch(() => {});
    }
    return () => { live = false; };
  }, []);

  return (
    <Box sx={{ mb: 2 }}>
      <Box sx={{ fontSize: "0.72rem", opacity: 0.6, letterSpacing: "0.06em", textTransform: "uppercase", mb: 0.5 }}>
        Post-quantum signature scheme
      </Box>
      <ToggleButtonGroup
        exclusive
        size="small"
        value={scheme}
        disabled={disabled}
        onChange={(_e, v: PqScheme | null) => { if (v && v !== scheme) onChange(v); }}
        sx={{ flexWrap: "wrap", "& .MuiToggleButton-root": { textTransform: "none", fontSize: "0.72rem", lineHeight: 1.3 } }}
      >
        {PQ_SCHEMES.map((s) => (
          <ToggleButton key={s} value={s}>{SCHEME_INFO[s].button}</ToggleButton>
        ))}
      </ToggleButtonGroup>

      {/* Only the selected scheme's explanation, like the highlighted paymaster line below. Collapsed by default. */}
      <FrameExplain id={`scheme.why.${context}`} label="why choose this scheme">
        <Box sx={{ fontSize: "0.66rem", mt: 0.5, lineHeight: 1.55 }}>
          <Box sx={{ color: "success.main", opacity: 0.9 }}>+ {SCHEME_INFO[scheme].gives}</Box>
          <Box sx={{ opacity: 0.65, mt: 0.25 }}>- {SCHEME_INFO[scheme].costs}</Box>
          <Box sx={{ opacity: 0.5, mt: 0.25 }}>
            Today both behave the same for you on this rail (you create your own stealth addresses); the difference
            matters once third parties can pay you.
          </Box>
        </Box>
        <Box sx={{ fontSize: "0.66rem", opacity: 0.65, mt: 0.5, lineHeight: 1.55 }}>
          {context === "transparent"
            ? "Switching changes your address (a different key and account class). Funds stay on the other scheme's account and reappear when you switch back."
            : "New stealth addresses use the selected scheme. Existing tickets keep their own scheme (badge on each) and stay spendable whatever you select."}
        </Box>
      </FrameExplain>

      {/* Gas line for the selected scheme only. */}
      <Box sx={{ mt: 0.75, fontSize: "0.64rem", lineHeight: 1.6, opacity: 0.85, fontFamily: "ui-monospace,monospace" }}>
        gas:{" "}
        {rails[scheme]
          ? <>
              {gasLine(rails[scheme]!)}
              {rails[scheme]!.paymaster && (
                <>
                  {" "}
                  <Link href={`${HEGOTA.explorerUrl}/address/${rails[scheme]!.paymaster}`} target="_blank" rel="noopener">↗</Link>
                </>
              )}
            </>
          : "reading..."}
      </Box>
    </Box>
  );
}

/** Small per-ticket scheme badge. */
export function SchemeBadge({ scheme }: { scheme: PqScheme }) {
  return (
    <Box component="span" sx={{ fontFamily: "ui-monospace,monospace", fontSize: "0.56rem", letterSpacing: "0.06em", border: "1px solid", borderColor: "divider", borderRadius: 0.5, px: 0.5, py: 0.1, opacity: 0.8, whiteSpace: "nowrap" }}>
      {scheme}
    </Box>
  );
}
