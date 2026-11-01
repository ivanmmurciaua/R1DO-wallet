"use client";

// FrameHome — the main wallet view when the frame-native "hegota" rail is the active network.
//
// Rail-owned, self-contained, removable: it drives the frame rail entirely through
// src/lib/frame/pqClient.ts and never touches the base wallet's 4337 / Railgun stack.
// It mirrors the normal wallet home UX (receive address, balance, send form) but every action
// runs on the post-quantum frame-tx rail, with the scheme the user picks (leanSphincs-s hash-based,
// the default, or ML-DSA-44 lattice; FrameSchemePicker), gas paid by that scheme's keyless on-chain
// paymaster, and each send shows the real on-chain anatomy of the frame-tx it
// produced (not an opaque 4337 UserOp).
//
// Recipient is a raw 0x address: there is no name directory on this rail. Private, unlinkable
// receiving lives in the stealth home (privacy=true), not in a reusable-address nick scheme.
//
// Removable: delete this file (and the single render that mounts it in rail mode).
import { useState, useEffect, useRef } from "react";
import { Paper, Box, Button, Link, TextField, Alert, Divider } from "@mui/material";
import { formatEther, parseEther, isAddress } from "viem";
import { HEGOTA } from "@/lib/frame/network";
import { loadFromDevice } from "@/lib/passkeys";
import { getWalletCredential } from "@/lib/credstore";
import { LOCAL_LAST_USER } from "@/app/constants";
import {
  deriveAccount, readStatus, railStatus, spend, getScheme, setScheme, onSchemeChange, sendEventText,
  type PqAccount, type PqAccountStatus, type PqSpendResult, type PqRailStatus, type PqScheme,
} from "@/lib/frame/pqClient";
import FrameTxView, { shortHex } from "@/components/FrameTxView";
import FrameSchemePicker, { SCHEME_INFO, gasLine } from "@/components/FrameSchemePicker";
import FrameSection, { FrameExplain } from "@/components/FrameSection";

// Reads LOCAL_LAST_USER, fetches the stored credential, and taps the authenticator to get
// the 32-byte PRF root the rail derives its post-quantum identity from.
async function tapForPrf(): Promise<Uint8Array> {
  const user = typeof localStorage !== "undefined" ? localStorage.getItem(LOCAL_LAST_USER) : null;
  if (!user) throw new Error("log in with a passkey first");
  const cred = await getWalletCredential(user);
  if (!cred?.rawId) throw new Error("no credential found for this wallet");
  const prf = await loadFromDevice(cred.rawId);
  if (!prf || prf.length !== 32) throw new Error("authenticator has no 32-byte PRF support");
  return prf;
}

// Inline "what changes vs the 4337 wallet" note: each differing step explains itself.
function Vs({ a, b }: { a: string; b: string }) {
  return (
    <Box sx={{ mt: 0.75, mb: 0.5, pl: 1, borderLeft: "2px solid", borderColor: "divider", fontSize: "0.68rem", lineHeight: 1.5 }}>
      <Box sx={{ opacity: 0.5 }}><b>4337 wallet:</b> {a}</Box>
      <Box sx={{ color: "success.main", opacity: 0.9 }}><b>Hegota:</b> {b}</Box>
    </Box>
  );
}

// Unlock state of the SELECTED scheme's account (the derived accounts themselves are kept per scheme).
type Unlock =
  | { kind: "idle" }
  | { kind: "unlocking" }
  | { kind: "error"; message: string };

type Msg = { ok: boolean; busy: boolean; text: string } | null;

const label = { fontSize: "0.72rem", opacity: 0.6, letterSpacing: "0.06em", textTransform: "uppercase" as const };
const row = { display: "flex", justifyContent: "space-between", gap: "12px", fontSize: "0.85rem", padding: "3px 0" };
const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.8rem", wordBreak: "break-all" as const };

// `account` is derived once at login (the login already taps the passkey) with the scheme selected
// at that time, so the PQ account shows immediately with NO separate in-view unlock tap. Switching
// the scheme (FrameSchemePicker) derives that scheme's account here with a tap, without any change
// to page.tsx; derived accounts are kept per scheme, so switching back needs no tap. The unlock
// button remains as a fallback when the selected scheme's account is not derived yet.
export default function FrameHome({ account }: { account?: PqAccount | null }) {
  const [scheme, setSchemeState] = useState<PqScheme>(() => getScheme());
  const [accs, setAccs] = useState<Partial<Record<PqScheme, PqAccount>>>(() => (account ? { [account.level]: account } : {}));
  const [unlockState, setUnlockState] = useState<Unlock>({ kind: "idle" });
  const [acctStatus, setAcctStatus] = useState<PqAccountStatus | null>(null);
  const [rail, setRail] = useState<PqRailStatus | null>(null);

  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [sending, setSending] = useState(false);
  const [sendMsg, setSendMsg] = useState<Msg>(null);
  const [decoded, setDecoded] = useState<PqSpendResult["decoded"] | null>(null);

  const acc = accs[scheme];
  // The latest selected scheme, so a slow status read for a scheme the user already left is dropped.
  const schemeRef = useRef(scheme);
  schemeRef.current = scheme;

  async function refreshStatus(a: PqAccount) {
    const s = a.level;
    try {
      const st = await readStatus(a.address);
      if (schemeRef.current === s) setAcctStatus(st);
    } catch {
      /* a read hiccup is not fatal to the view */
    }
    try {
      const r = await railStatus(s);
      if (schemeRef.current === s) setRail(r);
    } catch {
      /* idem */
    }
  }

  // Adopt the account derived at login (arrives async), under its own scheme.
  useEffect(() => {
    if (account) setAccs((prev) => ({ ...prev, [account.level]: account }));
  }, [account]);

  // Follow a selection made elsewhere (e.g. the stealth home in the same tab).
  useEffect(() => onSchemeChange(setSchemeState), []);

  // Whenever the shown account changes (scheme switch or first derive), reset the per-account view.
  useEffect(() => {
    setAcctStatus(null);
    setRail(null);
    setDecoded(null);
    setSendMsg(null);
    if (acc) void refreshStatus(acc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acc?.address, scheme]);

  async function unlock(s: PqScheme = scheme) {
    try {
      setUnlockState({ kind: "unlocking" });
      const prf = await tapForPrf();
      const a = await deriveAccount(prf, s);
      setAccs((prev) => ({ ...prev, [s]: a }));
      setUnlockState({ kind: "idle" });
    } catch (e: unknown) {
      setUnlockState({ kind: "error", message: e instanceof Error ? e.message : "unlock failed" });
    }
  }

  function choose(s: PqScheme) {
    setScheme(s);
    setSchemeState(s);
    setUnlockState({ kind: "idle" });
    if (!accs[s]) void unlock(s);
  }

  async function doSend(acc: PqAccount, sweep = false) {
    const recipient = to.trim();
    if (!isAddress(recipient)) {
      setSendMsg({ ok: false, busy: false, text: "enter a valid 0x recipient address" });
      return;
    }
    let valueWei = 0n;
    if (!sweep) {
      try {
        valueWei = parseEther(amount.trim());
      } catch {
        setSendMsg({ ok: false, busy: false, text: "enter a valid amount" });
        return;
      }
      if (valueWei <= 0n) {
        setSendMsg({ ok: false, busy: false, text: "amount must be greater than zero" });
        return;
      }
    }
    try {
      setSending(true);
      setSendMsg({ ok: false, busy: true, text: "tap your key..." });
      const prf = await tapForPrf();
      setSendMsg({ ok: false, busy: true, text: `deriving + signing (${acc.level}), deploying (if needed), spending${acc.level === "ML-DSA-44" ? " (ML-DSA signing is slower)" : ""}...` });
      const res = await spend(prf, recipient, valueWei, sweep, acc.level, (ev) => setSendMsg({ ok: false, busy: true, text: sendEventText(ev) }));
      setSendMsg({ ok: true, busy: false, text: `${res.deployTxHash ? "deployed + spent" : "spent"} (${res.mode === "sponsored" ? "gas paid by the paymaster" : "self-pay fallback"})` });
      setDecoded(res.decoded);
      setAmount("");
      await refreshStatus(acc);
    } catch (e: unknown) {
      setSendMsg({ ok: false, busy: false, text: e instanceof Error ? e.message : "send failed" });
    } finally {
      setSending(false);
    }
  }

  const balWei = acctStatus ? BigInt(acctStatus.balanceWei) : 0n;
  // Low enough that receiving is the obvious next step: surface the faucet hint.
  const lowBalance = acctStatus ? balWei < parseEther("0.001") : false;
  const sponsored = rail ? rail.mode === "sponsored" : true;
  const sendLabel = sponsored ? "Send (gas paid by paymaster)" : "Send (self-pay fallback)";
  const used = acctStatus?.signaturesUsed ?? 0;
  // Only leanSphincs-s has a signature budget (null for the stateless ML-DSA-44).
  const budget = rail?.signatureBudget ?? null;
  const budgetWarn = rail?.budgetWarn != null && used >= rail.budgetWarn;
  const info = SCHEME_INFO[scheme];
  const verifier = info.verifier;

  return (
    <Box sx={{ maxWidth: 520, mx: "auto", px: 2, py: 3 }}>
      {/* Header: which rail is active (always visible) and how it is served (collapsible). */}
      <Box sx={{ mb: 2 }}>
        <Box sx={{ fontSize: "1.1rem", fontWeight: 600 }}>{HEGOTA.name}</Box>
        <FrameSection id="home.about" title="About this rail" sx={{ mt: 0.5 }}>
          <Box sx={label}>
            chain {HEGOTA.chainId} · frame-native · post-quantum {scheme} ({scheme === "ML-DSA-44" ? "lattice" : "hash-based"})
          </Box>
          <Vs
            a="the same passkey derives an ECDSA secp256k1 owner (quantum-vulnerable)"
            b={`the same passkey derives ${info.keyText}`}
          />
        </FrameSection>
      </Box>

      <Paper variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
        <FrameSchemePicker scheme={scheme} onChange={choose} disabled={sending || unlockState.kind === "unlocking"} context="transparent" />
        {!acc ? (
          <>
            <Box sx={{ ...label, mb: 1 }}>PQ account ({scheme}, derived from your passkey)</Box>
            <Button variant="contained" onClick={() => void unlock()} disabled={unlockState.kind === "unlocking"}>
              {unlockState.kind === "unlocking" ? "tap your key..." : `Unlock ${scheme} account`}
            </Button>
            {unlockState.kind === "error" && (
              <Alert severity="error" sx={{ mt: 2 }}>{unlockState.message}</Alert>
            )}
          </>
        ) : (
          <>
            {/* PQ identity card: make it explicit (and on-chain-verifiable) that this account
                signs with a post-quantum scheme, not ECDSA. Collapsed by default; the budget
                warning stays pinned under the header. */}
            <FrameSection
              id="home.key"
              title={<Box component="span" sx={{ color: "success.main" }}>Your signing key · {acc.level}</Box>}
              right={
                <Box component="span" sx={{ fontFamily: "ui-monospace,monospace", fontSize: "0.56rem", letterSpacing: "0.08em", color: "success.main", border: "1px solid", borderColor: "success.main", borderRadius: 0.5, px: 0.5, py: 0.1 }}>
                  POST-QUANTUM
                </Box>
              }
              pinned={budgetWarn && budget !== null && (
                <Alert severity="warning" sx={{ mt: 0.75 }}>
                  This key has used {used.toLocaleString()} of its ~{budget.toLocaleString()} signatures.
                  Spends are blocked at {(rail?.budgetBlock ?? budget).toLocaleString()}: plan to move the funds to a new account.
                </Alert>
              )}
              sx={{ mb: 2 }}
            >
              <Box sx={{ p: 1.25, border: "1px solid", borderColor: "success.main", borderRadius: 1.5 }}>
                <Box sx={{ fontSize: "0.95rem", fontWeight: 600 }}>
                  {acc.level}
                  <Box component="span" sx={{ opacity: 0.55, fontWeight: 400, fontSize: "0.7rem" }}> · {info.family}</Box>
                </Box>
                <Box sx={{ ...mono, fontSize: "0.72rem", opacity: 0.85, mt: 0.5 }}>
                  public key {acc.publicKeyBytes.toLocaleString()} B · signature {acc.signatureBytes.toLocaleString()} B
                </Box>
                <Box sx={{ fontSize: "0.64rem", opacity: 0.5 }}>
                  a normal wallet (ECDSA secp256k1) is 33 B / 65 B, breakable by a quantum computer
                </Box>
                <Box sx={{ ...mono, fontSize: "0.7rem", opacity: 0.8, mt: 0.5 }}>account salt {shortHex(acc.commit)}</Box>
                {acctStatus && rail && (
                  <Box sx={{ ...mono, fontSize: "0.7rem", opacity: 0.8 }}>
                    {budget !== null
                      ? `signatures used ${used.toLocaleString()} / ${budget.toLocaleString()}`
                      : `signatures used ${used.toLocaleString()} (stateless scheme, no budget)`}
                  </Box>
                )}
                {verifier && (
                  <Box sx={{ fontSize: "0.64rem", opacity: 0.6, mt: 0.4, lineHeight: 1.5 }}>
                    verified on-chain by{" "}
                    <Link href={`${HEGOTA.explorerUrl}/address/${verifier}`} target="_blank" rel="noopener" sx={{ fontFamily: "ui-monospace,monospace" }}>
                      {shortHex(verifier)} ↗
                    </Link>{" "}
                    ({info.verifierText}): funds move only if your post-quantum signature is VALID.
                  </Box>
                )}
              </Box>
            </FrameSection>

            {/* Receive: the deterministic CREATE2 address funds arrive to. */}
            <FrameSection id="home.address" title="Your address (send funds here to receive)" defaultOpen>
              <Box sx={{ ...mono, mb: 0.5 }}>{acc.address}</Box>
              <FrameExplain id="home.address.vs">
                <Vs
                  a="a Safe account, deployed by a bundler through the ERC-4337 EntryPoint + factory"
                  b={`an ${info.accountClass} at a deterministic CREATE2 address, deployed by an on-chain sponsor on first spend (no bundler)`}
                />
              </FrameExplain>
              <Box sx={{ mb: 0.5 }} />

              <Box sx={row}>
                <span>State</span>
                <span style={mono}>
                  {acctStatus === null
                    ? "reading..."
                    : acctStatus.deployed
                      ? "deployed"
                      : "not deployed (deploys on first spend)"}
                </span>
              </Box>
              <Box sx={row}>
                <span>Balance</span>
                <span style={mono}>{acctStatus === null ? "-" : `${formatEther(balWei)} ${HEGOTA.symbol}`}</span>
              </Box>
              <Box sx={row}>
                <span>Gas</span>
                <span style={mono}>
                  {gasLine(rail)}
                </span>
              </Box>

              {/* Low balance: part of the address section, hidden when it is collapsed. */}
              {acctStatus && lowBalance && (
                <Alert severity="info" sx={{ mt: 1 }}>
                  Low balance. Fund this address to receive:{" "}
                  <Link href="https://faucet.privacy.ethrex.xyz/" target="_blank" rel="noopener">
                    faucet
                  </Link>
                  .
                </Alert>
              )}

              <Box sx={{ mt: 1 }}>
                <Button size="small" variant="text" onClick={() => refreshStatus(acc)} disabled={sending}>
                  refresh
                </Button>
              </Box>
            </FrameSection>

            <Divider sx={{ my: 2 }} />

            {/* Send: paymaster-sponsored spend (selected scheme) to a raw 0x address. */}
            <FrameSection id="home.send" title={sendLabel}>
              <FrameExplain id="home.send.vs">
                <Vs
                  a="a bundler relays your UserOp and an off-chain paymaster fronts the gas"
                  b="frame-tx: your account approves execution, a keyless on-chain paymaster (gated by your account's code hash) pays the gas; no bundler, no relayer, no operator key"
                />
              </FrameExplain>
              <Box sx={{ mb: 1 }} />
              <TextField
                fullWidth
                size="small"
                label="Recipient (0x address)"
                placeholder="0x..."
                value={to}
                onChange={(e) => setTo(e.target.value)}
                disabled={sending}
                error={to.trim().length > 0 && !isAddress(to.trim())}
                sx={{ mb: 1.5 }}
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
                sx={{ mb: 1.5 }}
              />
              <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
                <Button
                  variant="contained"
                  onClick={() => doSend(acc)}
                  disabled={sending || !isAddress(to.trim()) || amount.trim().length === 0}
                >
                  {sending ? "working..." : sendLabel}
                </Button>
                <Button
                  variant="outlined"
                  onClick={() => doSend(acc, true)}
                  disabled={sending || !isAddress(to.trim()) || balWei === 0n}
                  title={sponsored ? "Send the whole balance (the paymaster pays the gas, nothing is left)" : "Send the balance minus the self-pay gas reserve"}
                >
                  Send all
                </Button>
              </Box>
            </FrameSection>

            {/* Send progress / result / error stays visible even with the send section collapsed. */}
            {sendMsg && (
              <Alert severity={sendMsg.ok ? "success" : sendMsg.busy ? "info" : "error"} sx={{ mt: 2 }}>
                {sendMsg.text}
              </Alert>
            )}

            {decoded && (
              <FrameSection id="home.decoded" title="Frame-tx decoded: what you just signed" sx={{ mt: 2 }}>
                <Box sx={{ fontSize: "0.68rem", opacity: 0.55, mb: 0.5 }}>
                  No opaque UserOp: this is the actual EIP-8141 frame transaction, frame by frame.
                </Box>
                {decoded.deploy && <FrameTxView d={decoded.deploy} />}
                <FrameTxView d={decoded.spend} />

                <FrameExplain id="home.decoded.verify" label={`how the ${acc.level} verify works`}>
                  {acc.level === "ML-DSA-44" ? (
                    <Box sx={{ mt: 0.75, pl: 1, borderLeft: "2px solid", borderColor: "divider", fontSize: "0.68rem", opacity: 0.72, lineHeight: 1.6 }}>
                      <Box sx={{ fontWeight: 600, mb: 0.25 }}>On the ML-DSA-44 verify (the DEFAULT batch frame)</Box>
                      The verify costs ~15M gas, far over the 500K cap of the VERIFY frames, so your account&apos;s VERIFY
                      only checks the frame layout (its own verify frame follows, atomically batched with the spend) and
                      approves. The DEFAULT frame then runs the ML-DSA verify; a bad signature reverts it and the node skips
                      the rest of the batch, so nothing moves. The witness is ~24.7 KB of calldata (expanded public key +
                      signature). The ML-DSA paymaster is a separate keyless contract with its own balance, so this
                      expensive class cannot drain the leanSphincs-s paymaster.
                    </Box>
                  ) : (
                    <Box sx={{ mt: 0.75, pl: 1, borderLeft: "2px solid", borderColor: "divider", fontSize: "0.68rem", opacity: 0.72, lineHeight: 1.6 }}>
                      <Box sx={{ fontWeight: 600, mb: 0.25 }}>On the leanSphincs-s verify (the first VERIFY frame)</Box>
                      The signature is checked in the EVM by a stateless verifier (~55K gas incl. reading the key from
                      storage). The frame-tx cost is dominated by calldata: the signature is ~4.2 KB. The paymaster frame
                      is a keyless contract that only compares your account&apos;s code hash, so it sponsors any account of
                      this class with no operator and no off-chain service.
                      <Box sx={{ mt: 0.5 }}>
                        <b>EIP-8288</b> goes further (candidate, Buterin/Coratger; targets &ldquo;I-star&rdquo;, the fork after
                        Hegota): a SIGNATURE frame that accepts STARK proofs and aggregates many PQ signatures off-chain
                        into one recursive STARK the block verifies, so N spends cost about as much as 1, collapsing the
                        per-op gas at scale.
                      </Box>
                      <Box sx={{ mt: 0.5 }}>
                        This scheme is <b>hash-based</b>, the direction lean Ethereum / L-star favors
                        (&ldquo;believe in hashes&rdquo;) over lattices. Each key has a finite signature budget (~20K), shown
                        above.
                      </Box>
                    </Box>
                  )}
                </FrameExplain>
              </FrameSection>
            )}
          </>
        )}
      </Paper>
    </Box>
  );
}
