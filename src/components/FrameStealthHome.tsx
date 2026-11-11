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
import { Box, Button, Link, Alert, IconButton, Stack, Typography } from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import { HEGOTA } from "@/lib/frame/network";
import { claimFaucet } from "@/lib/frame/faucet";
import { LOCAL_LAST_USER } from "@/app/constants";
import {
  stealthNewPayment, stealthSpend, readStatus, railStatus, getScheme, setScheme, onSchemeChange, sendEventText,
  PQ_SCHEMES, type PqStealthMeta, type PqAccountStatus, type PqSpendResult, type PqRailStatus, type PqScheme,
} from "@/lib/frame/pqClient";
import {
  getTickets, addTicket, setTicketHidden, corruptTicketBackups, ticketStoreUnreadable,
  type LssStealthTicket,
} from "@/lib/frame/stealthStore";
import { shortHex } from "@/components/FrameTxView";
import FrameSchemePicker, { SCHEME_INFO, SchemeBadge, SchemeGas, gasLine } from "@/components/FrameSchemePicker";
import FrameSection, { FrameExplain } from "@/components/FrameSection";
import {
  MONO, captionSx, BAR_SPACE, tapForPrf, shortAddr, useHideBalance, Amount, BalanceCard, ActionBar,
  SubHeader, ReceiveBlock, SendFlow, DecodedSection, type BarSlot,
} from "@/components/FrameWalletKit";

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
type View = "menu" | "send" | "receive" | "details";

const NOTE = { fontSize: "0.68rem", opacity: 0.55, mb: 0.5 };
const wrapSx = { display: "flex", flexDirection: "column" as const, maxWidth: 400, mx: "auto", width: "100%", px: 2, py: 2 };
const rowSx = {
  display: "flex", alignItems: "center", gap: 1, border: "1px solid", borderColor: "divider", borderRadius: "2px",
  px: 1.25, py: 0.75,
};
const clickRowSx = { ...rowSx, cursor: "pointer", "&:hover": { borderColor: "primary.main" } };

// Compact row used by the "Awaiting payment" / "Spent" / hidden lists.
function MiniRow({ t, extra, actions }: { t: LssStealthTicket; extra?: string; actions: React.ReactNode }) {
  return (
    <Box sx={{ ...rowSx, opacity: t.hidden ? 0.6 : 1 }}>
      <Box sx={{ fontFamily: MONO, fontSize: "0.72rem" }}>{shortAddr(t.stealthAddress)}</Box>
      <SchemeBadge scheme={t.scheme} />
      {extra && <Box sx={{ fontSize: "0.68rem", opacity: 0.55 }}>{extra}</Box>}
      <Box sx={{ ml: "auto", display: "flex", gap: 0.5 }}>{actions}</Box>
    </Box>
  );
}

const txtBtn = { opacity: 0.7, minWidth: 0, fontSize: "0.7rem", py: 0 };

// `meta` is the ML-KEM meta-address page.tsx derives at login (the key a payment is encrypted to).
// Generating a stealth address taps the passkey again: the ticket is made in the worker.
export default function FrameStealthHome({ meta }: { meta?: PqStealthMeta | null }) {
  const [tickets, setTickets] = useState<LssStealthTicket[]>([]);
  const [statuses, setStatuses] = useState<Record<string, PqAccountStatus>>({});
  const [statusesLoaded, setStatusesLoaded] = useState(false);
  const [rails, setRails] = useState<Partial<Record<PqScheme, PqRailStatus>>>({});
  const [scheme, setSchemeState] = useState<PqScheme>(() => getScheme());
  const [genBusy, setGenBusy] = useState(false);
  const [genMsg, setGenMsg] = useState<Msg>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [view, setView] = useState<View>("menu");
  const [spendFrom, setSpendFrom] = useState<LssStealthTicket | null>(null);
  const [shown, setShown] = useState<LssStealthTicket | null>(null);
  const [lastResult, setLastResult] = useState<PqSpendResult | null>(null);
  // Per-address faucet claim state (testnet convenience): pending, or the faucet's answer.
  const [claims, setClaims] = useState<Record<string, { busy: boolean; ok?: boolean; text?: string }>>({});
  const [copied, setCopied] = useState(false);
  const [hideBal, toggleHideBal] = useHideBalance();
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

  // Per-ticket on-chain status, lifted here so the total and the lists share one source.
  const refreshAll = useCallback(async () => {
    const list = tickets;
    const results = await Promise.all(
      list.map(async (t) => {
        try {
          return [t.stealthAddress, await readStatus(t.stealthAddress)] as const;
        } catch {
          return null; // a read hiccup is not fatal: keep the previous value
        }
      }),
    );
    setStatuses((prev) => {
      const next = { ...prev };
      for (const r of results) if (r) next[r[0]] = r[1];
      return next;
    });
    setStatusesLoaded(true);
  }, [tickets]);

  const refreshOne = useCallback(async (address: `0x${string}`) => {
    try {
      const st = await readStatus(address);
      setStatuses((prev) => ({ ...prev, [address]: st }));
    } catch {
      /* a read hiccup is not fatal to the view */
    }
  }, []);

  useEffect(() => {
    if (tickets.length === 0) {
      setStatusesLoaded(true);
      return;
    }
    void refreshAll();
  }, [tickets, refreshAll]);

  // Both schemes' rail status: each ticket needs the status of ITS scheme.
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
      const ticket: LssStealthTicket = { v: 1, scheme: p.scheme, stealthAddress: p.stealthAddress, ct: p.ct, viewTag: p.viewTag, createdAt: Date.now() };
      await addTicket(user, ticket);
      reload();
      setGenMsg(null);
      setShown(ticket);
    } catch (e: unknown) {
      setGenMsg({ ok: false, busy: false, text: e instanceof Error ? e.message : "could not generate a stealth address" });
    } finally {
      setGenBusy(false);
    }
  }

  // One faucet claim per click, then poll that address a few times until the funds land.
  async function doClaim(address: `0x${string}`) {
    setClaims((p) => ({ ...p, [address]: { busy: true } }));
    const r = await claimFaucet(address);
    setClaims((p) => ({ ...p, [address]: { busy: false, ok: r.ok, text: r.text } }));
    if (!r.ok) return;
    for (let i = 0; i < 6; i++) {
      await new Promise((res) => setTimeout(res, 5000));
      await refreshOne(address);
    }
  }

  function hide(stealthAddress: `0x${string}`, hidden: boolean) {
    if (!user) return;
    // Best-effort and never rejects; reload once the (cross-tab serialized) write is done.
    void setTicketHidden(user, stealthAddress, hidden).finally(reload);
  }

  async function copyTicket(t: LssStealthTicket) {
    try {
      // The ticket JSON is the manual backup: with the passkey it is all that spends this account.
      await navigator.clipboard.writeText(JSON.stringify({ v: t.v, scheme: t.scheme, stealthAddress: t.stealthAddress, ct: t.ct, viewTag: t.viewTag, createdAt: t.createdAt }));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable: nothing else to fall back to here */
    }
  }

  const balOf = (t: LssStealthTicket): bigint => {
    const st = statuses[t.stealthAddress];
    return st ? BigInt(st.balanceWei) : 0n;
  };
  const sortedAll = tickets.slice().sort((a, b) => b.createdAt - a.createdAt);
  const hiddenList = sortedAll.filter((t) => t.hidden);
  const visible = sortedAll.filter((t) => !t.hidden);
  const funded = visible.filter((t) => balOf(t) > 0n).sort((a, b) => (balOf(b) > balOf(a) ? 1 : balOf(b) < balOf(a) ? -1 : 0));
  const awaiting = visible.filter((t) => balOf(t) === 0n && !statuses[t.stealthAddress]?.deployed);
  const spent = visible.filter((t) => balOf(t) === 0n && statuses[t.stealthAddress]?.deployed);
  const total: bigint | null = statusesLoaded ? visible.reduce((acc, t) => acc + balOf(t), 0n) : null;

  const info = SCHEME_INFO[scheme];
  const verifier = info.verifier;

  function onSelect(s: BarSlot) {
    // Tapping the active slot goes back to the menu, like the transparent home.
    if (view === s) {
      backToMenu();
      return;
    }
    if (s !== "receive") setShown(null);
    if (s !== "send") setSpendFrom(null);
    setView(s);
  }
  function backToMenu() {
    setShown(null);
    setSpendFrom(null);
    setView("menu");
  }

  const bar = <ActionBar active={view === "menu" ? null : view} onSelect={onSelect} sendDisabled={funded.length === 0} />;

  const fundedRow = (t: LssStealthTicket) => (
    <Box key={t.stealthAddress} onClick={() => { setSpendFrom(t); setView("send"); }} sx={clickRowSx}>
      <Box sx={{ fontFamily: MONO, fontSize: "1rem", opacity: 0.6 }}>◈</Box>
      <Link
        href={`${HEGOTA.explorerUrl}/address/${t.stealthAddress}`}
        target="_blank"
        rel="noopener"
        underline="hover"
        color="inherit"
        onClick={(e) => e.stopPropagation()}
        sx={{ fontFamily: MONO, fontSize: "0.72rem", opacity: 0.7 }}
      >
        {shortAddr(t.stealthAddress)}
      </Link>
      <SchemeBadge scheme={t.scheme} />
      <Typography variant="body2" sx={{ ml: "auto", fontWeight: 500 }}>
        <Amount wei={balOf(t)} hidden={hideBal} />
      </Typography>
    </Box>
  );

  // ---------------------------------------------------------------- send
  if (view === "send") {
    const t = spendFrom;
    const tr = t ? rails[t.scheme] ?? null : null;
    return (
      <Box sx={wrapSx}>
        <Box sx={{ pb: BAR_SPACE }}>
          <SubHeader title="Send" onBack={backToMenu} />
          <FrameExplain id="stealth.list.recipient" label="why a raw 0x recipient">
            <Box sx={NOTE}>
              Recipient is a raw address: the 4337 pay-by-name directory does not apply on this rail (separate address
              space).
            </Box>
          </FrameExplain>
          {t === null ? (
            <Stack spacing={0.75} sx={{ mt: 1 }}>
              <Typography variant="body2" sx={{ textAlign: "center", color: "text.secondary" }}>Choose a stealth UTXO to spend</Typography>
              {funded.length === 0
                ? <Typography variant="body2" sx={{ textAlign: "center", color: "text.secondary" }}>No funded stealth addresses yet. Tap Receive to get one.</Typography>
                : funded.map(fundedRow)}
            </Stack>
          ) : (
            <SendFlow
              key={t.stealthAddress}
              fromLabel={`${shortAddr(t.stealthAddress)} (${t.scheme})`}
              availableWei={balOf(t)}
              scheme={t.scheme}
              sponsored={tr ? tr.mode === "sponsored" : true}
              gasText={gasLine(tr)}
              run={async (recipient, valueWei, sweep, onProgress) => {
                const prf = await tapForPrf();
                onProgress(`opening the ticket, deriving the ${t.scheme} key, deploying if needed and sending...`);
                // Routed by the ticket's own scheme, not the current selection.
                const res = await stealthSpend(prf, t, recipient, valueWei, sweep, (ev) => onProgress(sendEventText(ev)));
                await refreshOne(t.stealthAddress);
                return res;
              }}
              onClose={(res) => {
                if (res) setLastResult(res);
                setSpendFrom(null);
                setView("menu");
              }}
            />
          )}
        </Box>
        {bar}
      </Box>
    );
  }

  // ---------------------------------------------------------------- receive
  if (view === "receive") {
    return (
      <Box sx={wrapSx}>
        <Box sx={{ pb: BAR_SPACE }}>
          <SubHeader title="Receive" onBack={backToMenu} />
          {shown ? (
            <ReceiveBlock
              address={shown.stealthAddress}
              caption="One-time stealth address"
              footnote={`Receives ${HEGOTA.symbol} on ${HEGOTA.name} only · ${shown.scheme}`}
            >
              <Button size="small" variant="text" onClick={() => void copyTicket(shown)}>
                {copied ? "copied" : "copy ticket (backup)"}
              </Button>
              <Box sx={{ ...NOTE, textAlign: "center", mt: -1 }}>
                The ticket plus your passkey is all that spends this address.
              </Box>
              <Button variant="outlined" onClick={() => { setShown(null); setGenMsg(null); }} sx={{ py: 1, borderRadius: 2 }}>
                Generate another
              </Button>
            </ReceiveBlock>
          ) : (
            <Stack spacing={1.5}>
              <FrameSchemePicker scheme={scheme} onChange={choose} disabled={genBusy} context="stealth" />
              <FrameExplain id="stealth.receive.how" label="how stealth receiving works">
                <Box sx={NOTE}>
                  Each tap encrypts a fresh secret to your ML-KEM meta-address and derives a new one-time address from it.
                  Fund it (
                  <Link href="https://faucet.privacy.ethrex.xyz/" target="_blank" rel="noopener">faucet</Link>
                  ) to receive. The ticket &#123;ct, viewTag&#125; is the off-chain note that, with your passkey, spends it.
                </Box>
              </FrameExplain>
              <Alert severity="warning">
                Tickets are stored only on this device. Clearing site storage or changing device loses access to the funds
                on those addresses unless you backed the ticket up (&quot;copy ticket&quot; on each address).
              </Alert>
              <Button variant="outlined" color="primary" onClick={() => void generate()} disabled={genBusy || !user} sx={{ py: 1.5, borderRadius: 2 }}>
                {genBusy ? "working..." : `Generate a ${scheme} stealth address`}
              </Button>
              {genMsg && (
                <Alert severity={genMsg.ok ? "success" : genMsg.busy ? "info" : "error"}>{genMsg.text}</Alert>
              )}
            </Stack>
          )}
        </Box>
        {bar}
      </Box>
    );
  }

  // ---------------------------------------------------------------- details
  if (view === "details") {
    return (
      <Box sx={wrapSx}>
        <Box sx={{ pb: BAR_SPACE }}>
          <SubHeader title="Details" onBack={backToMenu} />
          <Stack spacing={1.5}>
            <FrameSection id="stealth.about" title="About this rail" defaultOpen>
              <Box sx={captionSx}>
                chain {HEGOTA.chainId} · frame-native · post-quantum {scheme} · STEALTH (privacy)
              </Box>
              <Vs
                a="privacy = a stealth meta-address plus a shielded Railgun pool to hide amounts/links"
                b={`a FRESH one-time ${scheme} account per payment from an ML-KEM ticket; gas paid by a keyless paymaster`}
              />
            </FrameSection>
            <SchemeGas scheme={scheme} />
            <FrameSection
              id="stealth.keys"
              title={<Box component="span" sx={{ color: "success.main" }}>Your keys · {scheme}</Box>}
              defaultOpen
              right={
                <Box component="span" sx={{ fontFamily: MONO, fontSize: "0.56rem", letterSpacing: "0.08em", color: "success.main", border: "1px solid", borderColor: "success.main", borderRadius: 0.5, px: 0.5, py: 0.1 }}>
                  POST-QUANTUM
                </Box>
              }
            >
              <Box sx={{ p: 1.25, border: "1px solid", borderColor: "success.main", borderRadius: "2px" }}>
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
                      meta-address <Box component="span" sx={{ fontFamily: MONO }}>{shortHex(meta.metaAddress)}</Box> ·{" "}
                      {((meta.metaAddress.length - 2) / 2).toLocaleString()} B, the key each payment&apos;s ticket is encrypted to
                      (the same for both schemes)
                    </Box>
                  </>
                )}
                {verifier && (
                  <Box sx={{ fontSize: "0.64rem", opacity: 0.6, mt: 0.4, lineHeight: 1.5 }}>
                    each spend&apos;s signature is verified on-chain by{" "}
                    <Link href={`${HEGOTA.explorerUrl}/address/${verifier}`} target="_blank" rel="noopener" sx={{ fontFamily: MONO }}>
                      {shortHex(verifier)} ↗
                    </Link>{" "}
                    ({info.verifierText}): funds move only if it is VALID.
                  </Box>
                )}
              </Box>
            </FrameSection>
          </Stack>
        </Box>
        {bar}
      </Box>
    );
  }

  // ---------------------------------------------------------------- menu
  return (
    <Box sx={wrapSx}>
      <Box sx={{ pb: BAR_SPACE }}>
        <Stack spacing={2}>
          <BalanceCard
            caption="Stealth balance"
            wei={total}
            hidden={hideBal}
            onToggleHide={toggleHideBal}
            subline={`${user ?? "-"} · stealth · ${HEGOTA.name}`}
          />

          {(storeIssue.unreadable || storeIssue.backups.length > 0) && (
            <Alert severity="error">
              {storeIssue.unreadable
                ? "Some stored ticket data on this device could not be read. It is kept as-is (the next stored ticket first copies it aside). "
                : ""}
              {storeIssue.backups.length > 0
                ? `Unreadable ticket data was set aside, never deleted, under this site's storage key${storeIssue.backups.length > 1 ? "s" : ""} ${storeIssue.backups.join(", ")}. `
                : ""}
              Do not clear site data: it may hold the only copy of a ticket.
            </Alert>
          )}

          <Box>
            <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 0.5, mb: 1 }}>
              <Typography sx={{ fontWeight: 500 }}>Stealth UTXOs</Typography>
              <IconButton size="small" onClick={() => void refreshAll()} aria-label="Refresh balances" sx={{ color: "primary.main" }}>
                <RefreshIcon fontSize="small" />
              </IconButton>
            </Box>
            {funded.length === 0 ? (
              <Typography variant="body2" sx={{ color: "text.secondary", textAlign: "center" }}>
                No funded stealth addresses yet. Tap Receive to get one.
              </Typography>
            ) : (
              <Stack spacing={0.75} sx={{ maxHeight: 320, overflowY: "auto" }}>
                {funded.map(fundedRow)}
              </Stack>
            )}
          </Box>

          {awaiting.length > 0 && (
            <FrameSection id="stealth.awaiting" title={`Awaiting payment (${awaiting.length})`}>
              <Box sx={{ fontSize: "0.64rem", opacity: 0.55, mb: 0.75, lineHeight: 1.5 }}>
                &quot;faucet&quot; asks the testnet faucet to fund that address: a testing shortcut. Real stealth
                payments come from a third party; a faucet request ties the address to your connection.
              </Box>
              <Stack spacing={0.75}>
                {awaiting.map((t) => (
                  <MiniRow
                    key={t.stealthAddress}
                    t={t}
                    extra={new Date(t.createdAt).toLocaleDateString()}
                    actions={
                      <>
                        <Button size="small" variant="text" onClick={() => { setShown(t); setView("receive"); }} sx={txtBtn}>view</Button>
                        <Button
                          size="small"
                          variant="text"
                          disabled={claims[t.stealthAddress]?.busy || claims[t.stealthAddress]?.ok === true}
                          onClick={() => void doClaim(t.stealthAddress)}
                          title={claims[t.stealthAddress]?.text}
                          sx={{ ...txtBtn, color: claims[t.stealthAddress]?.ok === false ? "error.main" : undefined }}
                        >
                          {claims[t.stealthAddress]?.busy ? "claiming..." : claims[t.stealthAddress]?.ok ? "requested" : claims[t.stealthAddress]?.ok === false ? "faucet failed" : "faucet"}
                        </Button>
                        <Button size="small" variant="text" color="inherit" onClick={() => hide(t.stealthAddress, true)} sx={txtBtn}>hide</Button>
                      </>
                    }
                  />
                ))}
              </Stack>
            </FrameSection>
          )}

          {spent.length > 0 && (
            <FrameSection id="stealth.spent" title={`Spent (${spent.length})`}>
              <Stack spacing={0.75}>
                {spent.map((t) => (
                  <MiniRow
                    key={t.stealthAddress}
                    t={t}
                    extra={`signatures used ${statuses[t.stealthAddress]?.signaturesUsed ?? 0}`}
                    actions={<Button size="small" variant="text" color="inherit" onClick={() => hide(t.stealthAddress, true)} sx={txtBtn}>hide</Button>}
                  />
                ))}
              </Stack>
            </FrameSection>
          )}

          {hiddenList.length > 0 && (
            <Box>
              <Button size="small" variant="text" onClick={() => setShowHidden((v) => !v)}>
                {showHidden ? "hide hidden" : `show hidden (${hiddenList.length})`}
              </Button>
              {showHidden && (
                <Stack spacing={0.75} sx={{ mt: 0.5 }}>
                  {hiddenList.map((t) => (
                    <MiniRow
                      key={t.stealthAddress}
                      t={t}
                      actions={<Button size="small" variant="text" onClick={() => hide(t.stealthAddress, false)} sx={txtBtn}>unhide</Button>}
                    />
                  ))}
                </Stack>
              )}
            </Box>
          )}

          {lastResult && (
            <Box>
              <Box sx={{ ...captionSx, mb: 0.5 }}>Last transaction</Box>
              <DecodedSection decoded={lastResult.decoded} id="stealth.last.decoded" />
            </Box>
          )}
        </Stack>
      </Box>
      {bar}
    </Box>
  );
}
