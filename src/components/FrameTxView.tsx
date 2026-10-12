"use client";

// FrameTxView — shared renderer for the human-readable anatomy of one EIP-8141 frame-tx.
//
// Rail-owned and removable: extracted out of FrameHome so BOTH rail homes (the public
// privacy=false home and the stealth privacy=true home) render a decoded frame-tx the same
// way. It depends only on the rail's own pqClient types + network, never on the base wallet.
import { Box, Link } from "@mui/material";
import { formatEther } from "viem";
import { HEGOTA } from "@/lib/frame/network";
import type { FrameTxDesc } from "@/lib/frame/pqClient";

/** Shorten a 0x hex for display (keeps head + tail), passing non-hex through untouched. */
export const shortHex = (a: string) =>
  a.startsWith("0x") && a.length > 20 ? `${a.slice(0, 10)}…${a.slice(-6)}` : a;

// Renders the human-readable anatomy of one EIP-8141 frame-tx: its frames (mode/flags/
// target/gas/value + a plain-language note) and the inline ML-DSA signature. This is the
// teaching payoff of the rail — you SEE the self-pay frame-tx, not an opaque 4337 UserOp.
export default function FrameTxView({ d }: { d: FrameTxDesc }) {
  const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.72rem", wordBreak: "break-all" as const };
  return (
    <Box sx={{ mt: 1.25, p: 1.25, border: "1px solid", borderColor: "divider", borderRadius: 1.5 }}>
      <Box sx={{ fontSize: "0.74rem", fontWeight: 600, mb: 0.25 }}>
        {d.label} <Box component="span" sx={{ opacity: 0.5, fontWeight: 400 }}>· {d.type}</Box>
      </Box>
      <Box sx={{ ...mono, opacity: 0.6, mb: d.onchain ? 0.5 : 1 }}>sender {shortHex(d.sender)} · nonce {d.nonce} · chain {d.chainId}</Box>

      {/* The REAL on-chain trace of this exact tx: what the chain stored, who paid, how much gas.
          This is the point of the rail — the account itself is the on-chain sender, not a bundler. */}
      {d.onchain && (
        <Box sx={{ mb: 1, p: 0.75, borderRadius: 1, border: "1px solid", borderColor: "success.main", fontSize: "0.68rem", lineHeight: 1.6 }}>
          <Box sx={{ color: "success.main", fontWeight: 600 }}>on-chain ✓ · native frame-tx (0x06)</Box>
          <Box sx={{ opacity: 0.8 }}>paid by <b>{d.onchain.payer}</b></Box>
          <Link href={`${HEGOTA.explorerUrl}/tx/${d.onchain.txHash}`} target="_blank" rel="noopener" sx={{ ...mono, fontSize: "0.68rem" }}>
            {shortHex(d.onchain.txHash)} ↗
          </Link>
        </Box>
      )}
      {d.frames.map((f) => (
        <Box key={f.index} sx={{ mb: 0.75, pl: 1, borderLeft: "2px solid", borderColor: "divider" }}>
          <Box sx={{ fontSize: "0.72rem", fontWeight: 600 }}>
            #{f.index} {f.mode} <Box component="span" sx={{ opacity: 0.6, fontWeight: 400 }}>[{f.flags}]</Box>
          </Box>
          <Box sx={mono}>
            → {shortHex(f.target)} · value {formatEther(BigInt(f.valueWei))} {HEGOTA.symbol}
          </Box>
          {f.note && <Box sx={{ fontSize: "0.68rem", opacity: 0.6, mt: 0.25 }}>{f.note}</Box>}
        </Box>
      ))}
      <Box sx={{ fontSize: "0.68rem", opacity: 0.75, mt: 0.5 }}><b>signature</b> — {d.signature}</Box>
    </Box>
  );
}
