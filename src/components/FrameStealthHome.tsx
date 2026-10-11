"use client";

// FrameStealthHome — the main wallet view for the hegota rail in STEALTH mode (privacy=true).
//
// Rail-owned, self-contained, removable: it drives the stealth flow entirely through
// src/lib/frame/pqClient.ts + src/lib/frame/stealthStore.ts and never touches the base
// wallet's 4337 / Railgun / Safe stack. It is the privacy sibling of FrameHome: instead of
// one deterministic address, every received payment lands on a FRESH one-time stealth address
// (DKSAP, ML-KEM discovery + blinded ML-DSA spend), and the note that lets you spend it is an
// OFF-CHAIN ticket you keep (here: in the rail-owned stealthStore).
//
// There is NO pay-by-nick here: like FrameHome, a spend targets a raw 0x address the user
// pastes. No directory / nickname resolution is imported.
//
// Removable: delete this file (and the single render that mounts it in stealth rail mode).
import { useState, useEffect, useCallback } from "react";
import { Paper, Box, Button, Link, TextField, Alert, Divider, Collapse } from "@mui/material";
import { parseEther, isAddress, formatEther } from "viem";
import { HEGOTA } from "@/lib/frame/network";
import { loadFromDevice } from "@/lib/passkeys";
import { getWalletCredential } from "@/lib/credstore";
import { LOCAL_LAST_USER } from "@/app/constants";
import {
  stealthMeta, stealthNewPayment, stealthSpend, readStatus,
  type PqStealthMeta, type PqAccountStatus, type PqSpendResult,
} from "@/lib/frame/pqClient";
import { addTicket, getTickets, removeTicket, type StealthTicket } from "@/lib/frame/stealthStore";
import FrameTxView, { shortHex } from "@/components/FrameTxView";

// Reads LOCAL_LAST_USER, fetches the stored credential, and taps the authenticator to get the
// 32-byte PRF root the rail derives its ML-DSA / ML-KEM identity from. Same flow as FrameHome.
async function tapForPrf(): Promise<Uint8Array> {
  const user = typeof localStorage !== "undefined" ? localStorage.getItem(LOCAL_LAST_USER) : null;
  if (!user) throw new Error("log in with a passkey first");
  const cred = await getWalletCredential(user);
  if (!cred?.rawId) throw new Error("no credential found for this wallet");
  const prf = await loadFromDevice(cred.rawId);
  if (!prf || prf.length !== 32) throw new Error("authenticator has no 32-byte PRF support");
  return prf;
}

// Inline "what changes vs the 4337 wallet" note (same teaching surface as FrameHome).
function Vs({ a, b }: { a: string; b: string }) {
  return (
    <Box sx={{ mt: 0.75, mb: 0.5, pl: 1, borderLeft: "2px solid", borderColor: "divider", fontSize: "0.68rem", lineHeight: 1.5 }}>
      <Box sx={{ opacity: 0.5 }}><b>4337 wallet:</b> {a}</Box>
      <Box sx={{ color: "success.main", opacity: 0.9 }}><b>Hegota:</b> {b}</Box>
    </Box>
  );
}

const label = { fontSize: "0.72rem", opacity: 0.6, letterSpacing: "0.06em", textTransform: "uppercase" as const };
const row = { display: "flex", justifyContent: "space-between", gap: "12px", fontSize: "0.85rem", padding: "3px 0" };
const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.8rem", wordBreak: "break-all" as const };

// One stored stealth ticket: its on-chain status (deployed? balance) + a compact self-pay
// blinded spend form. Each ticket is an independent one-time address, so it owns its own state.
function TicketRow({ ticket, onForget }: { ticket: StealthTicket; onForget: () => void }) {
  const [status, setStatus] = useState<PqAccountStatus | null>(null);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; busy: boolean; text: string } | null>(null);
  const [decoded, setDecoded] = useState<PqSpendResult["decoded"] | null>(null);
  const [copied, setCopied] = useState(false);

  async function copyAddress() {
    try {
      await navigator.clipboard.writeText(ticket.stealthAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable: the full address is shown below to copy by hand */
    }
  }

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await readStatus(ticket.stealthAddress));
    } catch {
      /* a read hiccup is not fatal to the view */
    }
  }, [ticket.stealthAddress]);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  async function doSpend(sweep = false) {
    const recipient = to.trim();
    if (!isAddress(recipient)) {
      setMsg({ ok: false, busy: false, text: "enter a valid 0x recipient address" });
      return;
    }
    let valueWei = 0n;
    if (!sweep) {
      try {
        valueWei = parseEther(amount.trim());
      } catch {
        setMsg({ ok: false, busy: false, text: "enter a valid amount" });
        return;
      }
      if (valueWei <= 0n) {
        setMsg({ ok: false, busy: false, text: "amount must be greater than zero" });
        return;
      }
    }
    try {
      setSending(true);
      setMsg({ ok: false, busy: true, text: "tap your key..." });
      const prf = await tapForPrf();
      setMsg({ ok: false, busy: true, text: sweep ? "recovering + deploying (if needed) + sweeping all..." : "recovering + deploying (if needed) + blinded spend..." });
      const res = await stealthSpend(prf, ticket.ct, ticket.viewTag, recipient, valueWei, sweep);
      setMsg({ ok: true, busy: false, text: res.deployTxHash ? "deployed + spent (blinded)" : "spent (blinded)" });
      setDecoded(res.decoded);
      setAmount("");
      await refreshStatus();
    } catch (e: unknown) {
      setMsg({ ok: false, busy: false, text: e instanceof Error ? e.message : "spend failed" });
    } finally {
      setSending(false);
    }
  }

  const balWei = status ? BigInt(status.balanceWei) : 0n;

  return (
    <Box sx={{ mt: 1.5, p: 1.5, border: "1px solid", borderColor: "divider", borderRadius: 1.5 }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 1 }}>
        <Box sx={{ ...label, mb: 0.25 }}>Stealth address — fund this to receive</Box>
        <Button size="small" variant="text" color="inherit" onClick={onForget} disabled={sending} sx={{ opacity: 0.6, minWidth: 0 }}>
          forget
        </Button>
      </Box>
      {/* Full address (not shortened): this is what you paste into the faucet / sender to fund it. */}
      <Box sx={{ ...mono, fontSize: "0.78rem", mb: 0.5 }}>{ticket.stealthAddress}</Box>
      <Button size="small" variant="outlined" onClick={() => void copyAddress()} sx={{ mb: 0.5 }}>
        {copied ? "copied" : "copy address"}
      </Button>

      <Box sx={row}>
        <span>State</span>
        <span style={mono}>
          {status === null
            ? "reading..."
            : status.deployed
              ? "deployed"
              : "not deployed (deploys on first spend)"}
        </span>
      </Box>
      <Box sx={row}>
        <span>Balance</span>
        <span style={mono}>{status === null ? "-" : `${formatEther(balWei)} ${HEGOTA.symbol}`}</span>
      </Box>

      <Box sx={{ mt: 0.5, mb: 1 }}>
        <Button size="small" variant="text" onClick={() => void refreshStatus()} disabled={sending}>
          refresh
        </Button>
      </Box>

      {/* Spend: blinded self-pay ML-DSA spend to a raw 0x address (no pay-by-nick on this rail). */}
      <TextField
        fullWidth
        size="small"
        label="Recipient (0x address)"
        placeholder="0x..."
        value={to}
        onChange={(e) => setTo(e.target.value)}
        disabled={sending}
        error={to.trim().length > 0 && !isAddress(to.trim())}
        sx={{ mb: 1.25 }}
        inputProps={{ style: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.8rem" } }}
      />
      <TextField
        fullWidth
        size="small"
        label={`Amount (${HEGOTA.symbol})`}
        placeholder="0.0"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
        disabled={sending}
        sx={{ mb: 1.25 }}
      />
      <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
        <Button
          variant="contained"
          size="small"
          onClick={() => void doSpend(false)}
          disabled={sending || to.trim().length === 0 || amount.trim().length === 0}
        >
          {sending ? "tap your key..." : "Spend (self-pay, blinded)"}
        </Button>
        <Button
          variant="outlined"
          size="small"
          onClick={() => void doSpend(true)}
          disabled={sending || to.trim().length === 0 || balWei === 0n}
          title="Send the whole balance minus the gas reserve (leaves ~0)"
        >
          Send all
        </Button>
      </Box>

      {msg && (
        <Alert severity={msg.ok ? "success" : msg.busy ? "info" : "error"} sx={{ mt: 1.5 }}>
          {msg.text}
        </Alert>
      )}

      {decoded && (
        <Box sx={{ mt: 1.5 }}>
          <Box sx={{ ...label, mb: 0.5 }}>Frame-tx decoded — what you just signed</Box>
          <Box sx={{ fontSize: "0.68rem", opacity: 0.55, mb: 0.5 }}>
            No opaque UserOp: this is the actual EIP-8141 frame transaction, frame by frame — now blinded to this
            one-time stealth address.
          </Box>
          {decoded.deploy && <FrameTxView d={decoded.deploy} />}
          <FrameTxView d={decoded.spend} />
        </Box>
      )}
    </Box>
  );
}

// `meta` is the ML-KEM meta-address derived at login (the viewing half others encrypt to). If it
// arrives null (derivation skipped/failed at login), an in-view "unlock" button taps to fetch it.
export default function FrameStealthHome({ meta }: { meta?: PqStealthMeta | null }) {
  const [metaState, setMetaState] = useState<PqStealthMeta | null>(meta ?? null);
  const [metaBusy, setMetaBusy] = useState(false);
  const [metaErr, setMetaErr] = useState<string | null>(null);

  const [tickets, setTickets] = useState<StealthTicket[]>([]);
  const [genBusy, setGenBusy] = useState(false);
  const [genMsg, setGenMsg] = useState<{ ok: boolean; busy: boolean; text: string } | null>(null);
  const [showTickets, setShowTickets] = useState(true);

  // Resolve the active user at RENDER time (same proven pattern as FrameHome), not in a one-shot
  // mount effect: page.tsx writes LOCAL_LAST_USER in its own effect, and React runs child effects
  // before parent effects, so a mount read here could run first, cache null, and leave Generate
  // permanently disabled. Reading per-render always reflects the latest written value.
  const user = typeof localStorage !== "undefined" ? localStorage.getItem(LOCAL_LAST_USER) : null;

  // Adopt the login-derived meta when it changes.
  useEffect(() => {
    setMetaState(meta ?? null);
  }, [meta]);

  // Load (and reload) this user's stored tickets whenever the resolved user changes.
  useEffect(() => {
    if (user) setTickets(getTickets(user));
  }, [user]);

  const refreshTickets = useCallback(() => {
    if (user) setTickets(getTickets(user));
  }, [user]);

  async function unlockMeta() {
    try {
      setMetaBusy(true);
      setMetaErr(null);
      const prf = await tapForPrf();
      setMetaState(await stealthMeta(prf));
    } catch (e: unknown) {
      setMetaErr(e instanceof Error ? e.message : "could not read meta-address");
    } finally {
      setMetaBusy(false);
    }
  }

  async function generate() {
    if (!user) {
      setGenMsg({ ok: false, busy: false, text: "log in with a passkey first" });
      return;
    }
    try {
      setGenBusy(true);
      setGenMsg({ ok: false, busy: true, text: "tap your key..." });
      const prf = await tapForPrf();
      const payment = await stealthNewPayment(prf);
      addTicket(user, {
        stealthAddress: payment.stealthAddress,
        ct: payment.ct,
        viewTag: payment.viewTag,
        createdAt: Date.now(),
      });
      refreshTickets();
      setGenMsg({ ok: true, busy: false, text: "fresh stealth address generated — fund it to receive" });
    } catch (e: unknown) {
      setGenMsg({ ok: false, busy: false, text: e instanceof Error ? e.message : "could not generate a stealth address" });
    } finally {
      setGenBusy(false);
    }
  }

  function forget(stealthAddress: `0x${string}`) {
    if (!user) return;
    removeTicket(user, stealthAddress);
    refreshTickets();
  }

  return (
    <Box sx={{ maxWidth: 520, mx: "auto", px: 2, py: 3 }}>
      {/* Header: which rail is active, how it is served, and what STEALTH changes. */}
      <Box sx={{ mb: 2 }}>
        <Box sx={{ fontSize: "1.1rem", fontWeight: 600 }}>{HEGOTA.name}</Box>
        <Box sx={{ ...label, mt: 0.5 }}>
          chain {HEGOTA.chainId} · frame-native · post-quantum ML-DSA · STEALTH (privacy)
        </Box>
        <Vs
          a="privacy = a stealth meta-address plus a shielded Railgun pool to hide amounts/links"
          b="DKSAP PQ: ML-KEM-512 discovery + blinded ML-DSA spend; a FRESH address per payment, the note delivered OFF-CHAIN (courier), the funds on-chain"
        />
      </Box>

      <Paper variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
        {/* Receive side: the ML-KEM meta-address others encrypt a payment to. */}
        <Box sx={{ ...label, mb: 0.5 }}>Your stealth meta-address</Box>
        {metaState ? (
          <>
            <Box sx={{ ...mono, mb: 0.5 }}>{shortHex(metaState.metaAddress)}</Box>
            <Box sx={{ fontSize: "0.68rem", opacity: 0.55, mb: 1 }}>
              This is your ML-KEM viewing key: senders encrypt to it to derive a one-time address only you can spend.
            </Box>
          </>
        ) : (
          <>
            <Button variant="outlined" size="small" onClick={() => void unlockMeta()} disabled={metaBusy} sx={{ mb: 1 }}>
              {metaBusy ? "tap your key..." : "Unlock meta-address"}
            </Button>
            {metaErr && <Alert severity="error" sx={{ mb: 1 }}>{metaErr}</Alert>}
          </>
        )}

        <Divider sx={{ my: 2 }} />

        {/* Generate: a fresh one-time stealth address + the off-chain ticket to spend it later. */}
        <Box sx={{ ...label, mb: 0.5 }}>Receive on a fresh stealth address</Box>
        <Box sx={{ fontSize: "0.68rem", opacity: 0.55, mb: 1.25 }}>
          Each tap generates a FRESH one-time address. Fund it (
          <Link href="https://faucet.privacy.ethrex.xyz/" target="_blank" rel="noopener">faucet</Link>
          ) to receive. The ticket &#123;ct, viewTag&#125; is the off-chain note you keep — it is what lets you spend
          that address later.
        </Box>
        <Button variant="contained" onClick={() => void generate()} disabled={genBusy || !user}>
          {genBusy ? "tap your key..." : "Generate a stealth address to receive"}
        </Button>
        {genMsg && (
          <Alert severity={genMsg.ok ? "success" : genMsg.busy ? "info" : "error"} sx={{ mt: 1.5 }}>
            {genMsg.text}
          </Alert>
        )}

        <Divider sx={{ my: 2 }} />

        {/* The tickets: one card per stored one-time address, each with status + a blinded spend.
            The whole list collapses behind a clickable header so a long history can be tucked away. */}
        <Box
          onClick={() => setShowTickets((v) => !v)}
          sx={{
            ...label,
            mb: 0.5,
            display: "flex",
            alignItems: "center",
            gap: 0.75,
            cursor: "pointer",
            userSelect: "none",
            "&:hover": { opacity: 0.85 },
          }}
        >
          <Box component="span" sx={{ transition: "transform 0.15s", transform: showTickets ? "rotate(90deg)" : "none", lineHeight: 1 }}>
            &#9656;
          </Box>
          Your stealth tickets ({tickets.length})
        </Box>
        <Collapse in={showTickets} unmountOnExit>
          <Box sx={{ fontSize: "0.68rem", opacity: 0.55, mb: 0.5 }}>
            Recipient is a raw address: the 4337 pay-by-name directory does not apply on this rail (separate address
            space).
          </Box>
          {tickets.length === 0 ? (
            <Box sx={{ fontSize: "0.8rem", opacity: 0.6, py: 1 }}>
              No stealth addresses yet — generate one above to receive.
            </Box>
          ) : (
            tickets
              .slice()
              .sort((a, b) => b.createdAt - a.createdAt)
              .map((t) => <TicketRow key={t.stealthAddress} ticket={t} onForget={() => forget(t.stealthAddress)} />)
          )}
        </Collapse>
      </Paper>
    </Box>
  );
}
