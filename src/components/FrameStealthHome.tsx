"use client";

// FrameStealthHome: the main wallet view for the hegota rail in STEALTH mode (privacy=true).
//
// Rail-owned, self-contained, removable: it drives the stealth flow entirely through
// src/lib/frame/pqClient.ts + src/lib/frame/stealthStore.ts and never touches the base
// wallet's 4337 / Railgun / Safe stack. It is the privacy sibling of FrameHome: instead of one
// reusable address, each payment goes to a FRESH one-time account derived from the passkey plus an
// ML-KEM ticket {ct, viewTag} (fresh randomness per payment). The account class follows the scheme
// selected when the ticket was made (FrameSchemePicker): an independent leanSphincs-s (hash-based)
// SphincsFrameAccountS, or a DKSAP-blinded ML-DSA-44 AccountMldsaS. Each ticket stores its scheme and
// is spent with THAT scheme, so the list shows every ticket (with a scheme badge) whatever is
// selected. The ticket is stored on this device only and is the ONLY way to spend its account: it
// is never deleted (just hidden) and each row offers a "copy ticket" backup. Spends are sponsored by
// that scheme's keyless paymaster (self-pay fallback if it is missing, not gating or underfunded).
//
// There is NO pay-by-nick here: like FrameHome, a spend targets a raw 0x address the user
// pastes. No directory / nickname resolution is imported.
//
// Removable: delete this file (and the single render that mounts it in stealth rail mode).
import { useState, useEffect, useCallback } from "react";
import { Paper, Box, Button, Link, TextField, Alert, Divider } from "@mui/material";
import { parseEther, isAddress, formatEther } from "viem";
import { HEGOTA } from "@/lib/frame/network";
import { loadFromDevice } from "@/lib/passkeys";
import { getWalletCredential } from "@/lib/credstore";
import { LOCAL_LAST_USER } from "@/app/constants";
import {
  stealthNewPayment, stealthSpend, readStatus, railStatus, getScheme, setScheme, onSchemeChange, sendEventText,
  PQ_SCHEMES, type PqStealthMeta, type PqAccountStatus, type PqSpendResult, type PqRailStatus, type PqScheme,
} from "@/lib/frame/pqClient";
import {
  getTickets, addTicket, setTicketHidden, corruptTicketBackups, ticketStoreUnreadable,
  type LssStealthTicket,
} from "@/lib/frame/stealthStore";
import FrameTxView, { shortHex } from "@/components/FrameTxView";
import FrameSchemePicker, { SCHEME_INFO, SchemeBadge, gasLine } from "@/components/FrameSchemePicker";
import FrameSection, { FrameExplain } from "@/components/FrameSection";

// Reads LOCAL_LAST_USER, fetches the stored credential, and taps the authenticator to get the
// 32-byte PRF root the rail derives its stealth keys from. Same flow as FrameHome.
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

type Msg = { ok: boolean; busy: boolean; text: string } | null;

const label = { fontSize: "0.72rem", opacity: 0.6, letterSpacing: "0.06em", textTransform: "uppercase" as const };
const row = { display: "flex", justifyContent: "space-between", gap: "12px", fontSize: "0.85rem", padding: "3px 0" };
const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.8rem", wordBreak: "break-all" as const };

// Human label for the gas mode, from railStatus.
function gasModeText(rail: PqRailStatus | null): string {
  if (!rail || rail.mode === "sponsored") return "gas paid by paymaster";
  if (rail.fallbackReason === "underfunded") return "self-pay, paymaster out of funds";
  if (rail.fallbackReason === "not-gated") return "self-pay, paymaster does not cover this account";
  return "self-pay fallback";
}

// One stored ticket: its account's on-chain status + a compact spend form. Each ticket is an
// independent one-time account, so it owns its own state; `rail` is the status of the TICKET's scheme.
function StealthRow({ entry, rail, onHide }: { entry: LssStealthTicket; rail: PqRailStatus | null; onHide: (hidden: boolean) => void }) {
  const [status, setStatus] = useState<PqAccountStatus | null>(null);
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const [decoded, setDecoded] = useState<PqSpendResult["decoded"] | null>(null);
  const [copied, setCopied] = useState<"address" | "ticket" | null>(null);
  const sponsored = rail ? rail.mode === "sponsored" : true;

  async function copy(what: "address" | "ticket") {
    try {
      // The ticket JSON is the manual backup: with the passkey it is all that spends this account.
      const text = what === "address"
        ? entry.stealthAddress
        : JSON.stringify({ v: entry.v, scheme: entry.scheme, stealthAddress: entry.stealthAddress, ct: entry.ct, viewTag: entry.viewTag, createdAt: entry.createdAt });
      await navigator.clipboard.writeText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      /* clipboard unavailable: the full address is shown below to copy by hand */
    }
  }

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await readStatus(entry.stealthAddress));
    } catch {
      /* a read hiccup is not fatal to the view */
    }
  }, [entry.stealthAddress]);

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
      setMsg({ ok: false, busy: true, text: `opening the ticket + deriving the ${entry.scheme} key + deploying (if needed) + ${sweep ? "sending all" : "spending"}...` });
      // Routed by the ticket's own scheme, not the current selection.
      const res = await stealthSpend(prf, entry, recipient, valueWei, sweep, (ev) => setMsg({ ok: false, busy: true, text: sendEventText(ev) }));
      setMsg({ ok: true, busy: false, text: `${res.deployTxHash ? "deployed + spent" : "spent"} (${res.mode === "sponsored" ? "gas paid by the paymaster" : "self-pay fallback, this account paid the gas"})` });
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
    <Box sx={{ mt: 1.5, p: 1.5, border: "1px solid", borderColor: "divider", borderRadius: 1.5, opacity: entry.hidden ? 0.6 : 1 }}>
      <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 1 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
          <Box sx={{ ...label, mb: 0.25 }}>One-time stealth address, fund this to receive</Box>
          <SchemeBadge scheme={entry.scheme} />
        </Box>
        <Button size="small" variant="text" color="inherit" onClick={() => onHide(!entry.hidden)} disabled={sending} sx={{ opacity: 0.6, minWidth: 0 }}>
          {entry.hidden ? "unhide" : "hide"}
        </Button>
      </Box>
      {/* Full address (not shortened): this is what you paste into the faucet / sender to fund it. */}
      <Box sx={{ ...mono, fontSize: "0.78rem", mb: 0.5 }}>{entry.stealthAddress}</Box>
      <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", mb: 0.5 }}>
        <Button size="small" variant="outlined" onClick={() => void copy("address")}>
          {copied === "address" ? "copied" : "copy address"}
        </Button>
        <Button size="small" variant="text" onClick={() => void copy("ticket")} title="Copy the ticket JSON as a manual backup of this address">
          {copied === "ticket" ? "copied" : "copy ticket"}
        </Button>
      </Box>

      <Box sx={row}>
        <span>State</span>
        <span style={mono}>
          {status === null
            ? "reading..."
            : status.deployed
              ? `deployed · ${status.signaturesUsed} signature${status.signaturesUsed === 1 ? "" : "s"} used`
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

      {/* Spend with the ticket's scheme (sponsored, or self-pay fallback) to a raw 0x address (no pay-by-nick on this rail). */}
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
          {sending ? "working..." : `Spend (${gasModeText(rail)})`}
        </Button>
        <Button
          variant="outlined"
          size="small"
          onClick={() => void doSpend(true)}
          disabled={sending || to.trim().length === 0 || balWei === 0n}
          title={sponsored ? "Send the whole balance (the paymaster pays the gas)" : "Send the balance minus the self-pay gas reserve"}
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
          <Box sx={{ ...label, mb: 0.25 }}>Frame-tx decoded: what you just signed</Box>
          <FrameExplain id="stealth.row.decoded" label="what is this">
            <Box sx={{ fontSize: "0.68rem", opacity: 0.55, mb: 0.5 }}>
              No opaque UserOp: this is the actual EIP-8141 frame transaction, frame by frame, from this one-time
              stealth account.
            </Box>
          </FrameExplain>
          {decoded.deploy && <FrameTxView d={decoded.deploy} />}
          <FrameTxView d={decoded.spend} />
        </Box>
      )}
    </Box>
  );
}

// `meta` is the ML-KEM meta-address page.tsx derives at login (the key a payment is encrypted to).
// Generating a stealth address taps the passkey again: the ticket is made in the worker.
export default function FrameStealthHome({ meta }: { meta?: PqStealthMeta | null }) {
  const [tickets, setTickets] = useState<LssStealthTicket[]>([]);
  const [rails, setRails] = useState<Partial<Record<PqScheme, PqRailStatus>>>({});
  const [scheme, setSchemeState] = useState<PqScheme>(() => getScheme());
  const [genBusy, setGenBusy] = useState(false);
  const [genMsg, setGenMsg] = useState<Msg>(null);
  const [showHidden, setShowHidden] = useState(false);
  // Unparseable ticket data: set aside (never deleted) or still in place. Shown as a warning.
  const [storeIssue, setStoreIssue] = useState<{ unreadable: boolean; backups: string[] }>({ unreadable: false, backups: [] });

  // Resolve the active user at RENDER time (same proven pattern as FrameHome), not in a one-shot
  // mount effect: page.tsx writes LOCAL_LAST_USER in its own effect, and React runs child effects
  // before parent effects, so a mount read here could run first, cache null, and leave Generate
  // permanently disabled. Reading per-render always reflects the latest written value.
  const user = typeof localStorage !== "undefined" ? localStorage.getItem(LOCAL_LAST_USER) : null;

  const reload = useCallback(() => {
    if (!user) return;
    setTickets(getTickets(user));
    setStoreIssue({ unreadable: ticketStoreUnreadable(user), backups: corruptTicketBackups(user) });
  }, [user]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Both schemes' rail status: the rows need the status of THEIR ticket's scheme.
  useEffect(() => {
    for (const s of PQ_SCHEMES) railStatus(s).then((r) => setRails((prev) => ({ ...prev, [s]: r }))).catch(() => {});
  }, []);

  // Follow a selection made elsewhere (e.g. the transparent home in the same tab).
  useEffect(() => onSchemeChange(setSchemeState), []);

  function choose(s: PqScheme) {
    setScheme(s);
    setSchemeState(s);
    setGenMsg(null);
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
      setGenMsg({ ok: false, busy: true, text: `encapsulating a fresh ticket + deriving its one-time ${scheme} account...` });
      const p = await stealthNewPayment(prf, scheme);
      // Store the ticket (with its scheme) IMMEDIATELY: it is the only way back to this account.
      // Throws if the ticket is not durably stored: the address is then never shown, so never funded.
      await addTicket(user, { v: 1, scheme: p.scheme, stealthAddress: p.stealthAddress, ct: p.ct, viewTag: p.viewTag, createdAt: Date.now() });
      reload();
      setGenMsg({ ok: true, busy: false, text: "fresh stealth address generated and its ticket stored on this device, fund it to receive" });
    } catch (e: unknown) {
      setGenMsg({ ok: false, busy: false, text: e instanceof Error ? e.message : "could not generate a stealth address" });
    } finally {
      setGenBusy(false);
    }
  }

  function hide(stealthAddress: `0x${string}`, hidden: boolean) {
    if (!user) return;
    // Best-effort and never rejects; reload once the (cross-tab serialized) write is done.
    void setTicketHidden(user, stealthAddress, hidden).finally(reload);
  }

  const hiddenCount = tickets.filter((t) => t.hidden).length;
  const visible = tickets.filter((t) => showHidden || !t.hidden).slice().sort((a, b) => b.createdAt - a.createdAt);
  const info = SCHEME_INFO[scheme];
  const verifier = info.verifier;
  const rail = rails[scheme] ?? null;
  const busy = genBusy;

  return (
    <Box sx={{ maxWidth: 520, mx: "auto", px: 2, py: 3 }}>
      {/* Header: which rail is active (always visible), how it is served and what STEALTH changes (collapsible). */}
      <Box sx={{ mb: 2 }}>
        <Box sx={{ fontSize: "1.1rem", fontWeight: 600 }}>{HEGOTA.name}</Box>
        <FrameSection id="stealth.about" title="About this rail" sx={{ mt: 0.5 }}>
          <Box sx={label}>
            chain {HEGOTA.chainId} · frame-native · post-quantum {scheme} · STEALTH (privacy)
          </Box>
          <Vs
            a="privacy = a stealth meta-address plus a shielded Railgun pool to hide amounts/links"
            b={`a FRESH one-time ${scheme} account per payment from an ML-KEM ticket; gas paid by a keyless paymaster`}
          />
        </FrameSection>
      </Box>

      <Paper variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
        <FrameSchemePicker scheme={scheme} onChange={choose} disabled={genBusy} context="stealth" />
        {/* PQ identity card: the one post-quantum primitive this stealth home uses. Collapsed by default. */}
        <FrameSection
          id="stealth.keys"
          title={<Box component="span" sx={{ color: "success.main" }}>Your keys · {scheme}</Box>}
          right={
            <Box component="span" sx={{ fontFamily: "ui-monospace,monospace", fontSize: "0.56rem", letterSpacing: "0.08em", color: "success.main", border: "1px solid", borderColor: "success.main", borderRadius: 0.5, px: 0.5, py: 0.1 }}>
              POST-QUANTUM
            </Box>
          }
          sx={{ mb: 2 }}
        >
          <Box sx={{ p: 1.25, border: "1px solid", borderColor: "success.main", borderRadius: 1.5 }}>
            <Box sx={{ fontSize: "0.84rem" }}>
              <b>Spending</b> · {scheme}
              <Box component="span" sx={{ opacity: 0.55, fontSize: "0.68rem" }}> · {info.family}</Box>
            </Box>
            <Box sx={{ fontSize: "0.64rem", opacity: 0.6 }}>
              {scheme === "ML-DSA-44"
                ? "one blinded ML-DSA key per one-time account (DKSAP: your base key blinded by that payment's ticket secret)"
                : "one independent key per one-time account, from your passkey plus that payment's ticket"}{" "}
              · a normal wallet uses ECDSA (breakable by a quantum computer)
            </Box>
            {meta?.metaAddress && (
              <>
                <Box sx={{ fontSize: "0.84rem", mt: 0.75 }}>
                  <b>Receiving</b> · ML-KEM
                  <Box component="span" sx={{ opacity: 0.55, fontSize: "0.68rem" }}> · key encapsulation, fresh randomness per payment</Box>
                </Box>
                <Box sx={{ fontSize: "0.64rem", opacity: 0.6 }}>
                  meta-address <Box component="span" sx={{ fontFamily: "ui-monospace,monospace" }}>{shortHex(meta.metaAddress)}</Box> ·{" "}
                  {((meta.metaAddress.length - 2) / 2).toLocaleString()} B, the key each payment&apos;s ticket is encrypted to
                  (the same for both schemes)
                </Box>
              </>
            )}
            {verifier && (
              <Box sx={{ fontSize: "0.64rem", opacity: 0.6, mt: 0.4, lineHeight: 1.5 }}>
                each spend&apos;s signature is verified on-chain by{" "}
                <Link href={`${HEGOTA.explorerUrl}/address/${verifier}`} target="_blank" rel="noopener" sx={{ fontFamily: "ui-monospace,monospace" }}>
                  {shortHex(verifier)} ↗
                </Link>{" "}
                ({info.verifierText}): funds move only if it is VALID.
              </Box>
            )}
            {rail && (
              <Box sx={{ fontSize: "0.64rem", opacity: 0.6, mt: 0.4 }}>
                gas ({scheme}): {gasLine(rail)}
              </Box>
            )}
          </Box>
        </FrameSection>

        {/* Generate: a fresh one-time account + the ticket that spends it later. The corrupt-store
            error is pinned (always visible, only shown when ticket data is at risk); the general
            "tickets live on this device" note lives inside the section. */}
        <FrameSection
          id="stealth.receive"
          title="Receive on a fresh stealth address"
          pinned={
            <>
              {(storeIssue.unreadable || storeIssue.backups.length > 0) && (
                <Alert severity="error" sx={{ mb: 0.5 }}>
                  {storeIssue.unreadable
                    ? "Some stored ticket data on this device could not be read. It is kept as-is (the next stored ticket first copies it aside). "
                    : ""}
                  {storeIssue.backups.length > 0
                    ? `Unreadable ticket data was set aside, never deleted, under this site's storage key${storeIssue.backups.length > 1 ? "s" : ""} ${storeIssue.backups.join(", ")}. `
                    : ""}
                  Do not clear site data: it may hold the only copy of a ticket.
                </Alert>
              )}
            </>
          }
        >
          <Alert severity="warning" sx={{ mb: 0.5 }}>
            Tickets are stored only on this device. Clearing site storage or changing device loses access to the funds
            on those addresses unless you backed the ticket up (&quot;copy ticket&quot; on each address).
          </Alert>
          <FrameExplain id="stealth.receive.how" label="how stealth receiving works">
            <Box sx={{ fontSize: "0.68rem", opacity: 0.55, mb: 0.5 }}>
              Each tap encrypts a fresh secret to your ML-KEM meta-address and derives a new one-time address from it.
              Fund it (
              <Link href="https://faucet.privacy.ethrex.xyz/" target="_blank" rel="noopener">faucet</Link>
              ) to receive. The ticket &#123;ct, viewTag&#125; is the off-chain note that, with your passkey, spends it.
            </Box>
          </FrameExplain>
          <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap", mt: 0.5 }}>
            <Button variant="contained" onClick={() => void generate()} disabled={busy || !user}>
              {genBusy ? "working..." : `Generate a ${scheme} stealth address to receive`}
            </Button>
          </Box>
        </FrameSection>
        {/* Generate progress / result / error stays visible even with the section collapsed. */}
        {genMsg && (
          <Alert severity={genMsg.ok ? "success" : genMsg.busy ? "info" : "error"} sx={{ mt: 1.5 }}>
            {genMsg.text}
          </Alert>
        )}

        <Divider sx={{ my: 2 }} />

        {/* The stealth accounts: one card per stored ticket, each with status + a spend.
            The whole list collapses behind a clickable header so a long history can be tucked away;
            rows stay mounted when collapsed, so a half-filled spend form survives. */}
        <FrameSection id="stealth.list" title={`Your stealth addresses (${tickets.length - hiddenCount})`}>
          <FrameExplain id="stealth.list.recipient" label="why a raw 0x recipient">
            <Box sx={{ fontSize: "0.68rem", opacity: 0.55, mb: 0.5 }}>
              Recipient is a raw address: the 4337 pay-by-name directory does not apply on this rail (separate address
              space).
            </Box>
          </FrameExplain>
          {hiddenCount > 0 && (
            <Button size="small" variant="text" onClick={() => setShowHidden((v) => !v)} sx={{ mb: 0.5 }}>
              {showHidden ? "hide hidden" : `show hidden (${hiddenCount})`}
            </Button>
          )}
          {visible.length === 0 ? (
            <Box sx={{ fontSize: "0.8rem", opacity: 0.6, py: 1 }}>
              No stealth addresses yet: generate one above to receive.
            </Box>
          ) : (
            visible.map((t) => <StealthRow key={t.stealthAddress} entry={t} rail={rails[t.scheme] ?? null} onHide={(h) => hide(t.stealthAddress, h)} />)
          )}
        </FrameSection>

      </Paper>
    </Box>
  );
}
