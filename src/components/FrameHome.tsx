"use client";

// FrameHome — the main wallet view when the frame-native "hegota" rail is the active network.
//
// Rail-owned, self-contained, removable: it drives the frame rail entirely through
// src/lib/frame/pqClient.ts and never touches the base wallet's 4337 / Railgun stack.
// It mirrors the normal wallet home UX (receive address, balance, send form) but every
// action runs on the post-quantum ML-DSA frame-tx rail.
//
// Pay-by-nick on this rail is NATIVE and storage-free: a @nick resolves to a meta-address
// against a directory whose merkle root an operator publishes to the 0x8272 recent-root
// predeploy (EIP-8272). Resolution is a free, authenticated view call (no gas, no PRF); a
// send still targets the resolved raw address. A plain 0x address also works as before.
//
// Removable: delete this file (and the single render that mounts it in rail mode).
import { useState, useEffect } from "react";
import { Paper, Box, Button, Link, TextField, Alert, Divider } from "@mui/material";
import { formatEther, parseEther, isAddress } from "viem";
import { HEGOTA } from "@/lib/frame/network";
import { loadFromDevice } from "@/lib/passkeys";
import { getWalletCredential } from "@/lib/credstore";
import { LOCAL_LAST_USER } from "@/app/constants";
import {
  deriveAccount, readStatus, spend, resolveNick,
  type PqAccount, type PqAccountStatus, type PqSpendResult,
} from "@/lib/frame/pqClient";
import FrameTxView from "@/components/FrameTxView";

// Reads LOCAL_LAST_USER, fetches the stored credential, and taps the authenticator to get
// the 32-byte PRF root the rail derives its ML-DSA identity from. Same flow as the panel.
async function tapForPrf(): Promise<Uint8Array> {
  const user = typeof localStorage !== "undefined" ? localStorage.getItem(LOCAL_LAST_USER) : null;
  if (!user) throw new Error("log in with a passkey first");
  const cred = await getWalletCredential(user);
  if (!cred?.rawId) throw new Error("no credential found for this wallet");
  const prf = await loadFromDevice(cred.rawId);
  if (!prf || prf.length !== 32) throw new Error("authenticator has no 32-byte PRF support");
  return prf;
}

// Inline "what changes vs the 4337 wallet" note. This view IS the teaching surface now
// (the separate Settings panel was removed): each differing step explains itself.
function Vs({ a, b }: { a: string; b: string }) {
  return (
    <Box sx={{ mt: 0.75, mb: 0.5, pl: 1, borderLeft: "2px solid", borderColor: "divider", fontSize: "0.68rem", lineHeight: 1.5 }}>
      <Box sx={{ opacity: 0.5 }}><b>4337 wallet:</b> {a}</Box>
      <Box sx={{ color: "success.main", opacity: 0.9 }}><b>Hegota:</b> {b}</Box>
    </Box>
  );
}

type Pq =
  | { kind: "idle" }
  | { kind: "unlocking" }
  | { kind: "ok"; acc: PqAccount }
  | { kind: "error"; message: string };

// `account` is derived once at login (the login already taps the passkey), so the PQ
// account shows immediately with NO separate in-view unlock tap. The unlock button remains
// only as a fallback when the account was not pre-derived (e.g. derivation failed at login).
export default function FrameHome({ account }: { account?: PqAccount | null }) {
  const [pq, setPq] = useState<Pq>(account ? { kind: "ok", acc: account } : { kind: "idle" });
  const [acctStatus, setAcctStatus] = useState<PqAccountStatus | null>(null);

  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [sending, setSending] = useState(false);
  const [sendMsg, setSendMsg] = useState<{ ok: boolean; busy: boolean; text: string } | null>(null);
  const [decoded, setDecoded] = useState<PqSpendResult["decoded"] | null>(null);

  // Pay-by-nick resolution state. `resolvedNick` is set when a @nick authenticates against a
  // recent root; it is cleared whenever the recipient field no longer matches it.
  const [resolvedNick, setResolvedNick] = useState<{ name: string; address: `0x${string}`; slot: number } | null>(null);
  const [resolvingNick, setResolvingNick] = useState(false);
  const [nickMsg, setNickMsg] = useState<string | null>(null);

  const isNickInput = to.trim().startsWith("@");
  const nickResolved = resolvedNick && to.trim().toLowerCase() === `@${resolvedNick.name}`;
  // The address a send actually targets: the resolved nick's address, or a raw 0x address.
  const effectiveRecipient: `0x${string}` | null = nickResolved
    ? resolvedNick!.address
    : (isAddress(to.trim()) ? (to.trim() as `0x${string}`) : null);

  async function doResolveNick() {
    setNickMsg(null);
    setResolvedNick(null);
    try {
      setResolvingNick(true);
      const r = await resolveNick(to.trim());
      if (r.ok && r.address) {
        setResolvedNick({ name: r.name, address: r.address, slot: r.slot ?? 0 });
      } else {
        const why = r.reason === "unknown-nick" ? "not in the directory"
          : r.reason === "stale-root" ? "directory root is stale (operator must republish)"
            : r.reason === "no-resolver" ? "no directory resolver configured"
              : "rejected by the recent-root gate";
        setNickMsg(`@${r.name || to.trim().replace(/^@/, "")}: ${why}`);
      }
    } catch (e: unknown) {
      setNickMsg(e instanceof Error ? e.message : "could not resolve");
    } finally {
      setResolvingNick(false);
    }
  }

  const label = { fontSize: "0.72rem", opacity: 0.6, letterSpacing: "0.06em", textTransform: "uppercase" as const };
  const row = { display: "flex", justifyContent: "space-between", gap: "12px", fontSize: "0.85rem", padding: "3px 0" };
  const mono = { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.8rem", wordBreak: "break-all" as const };

  async function refreshStatus(acc: PqAccount) {
    try {
      setAcctStatus(await readStatus(acc.address));
    } catch {
      /* a read hiccup is not fatal to the view */
    }
  }

  // Adopt the account derived at login (arrives async) and read its on-chain status, with
  // no in-view authenticator prompt.
  useEffect(() => {
    if (account) {
      setPq({ kind: "ok", acc: account });
      void refreshStatus(account);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account]);

  async function unlock() {
    try {
      setPq({ kind: "unlocking" });
      const prf = await tapForPrf();
      const acc = await deriveAccount(prf);
      setPq({ kind: "ok", acc });
      void refreshStatus(acc);
    } catch (e: unknown) {
      setPq({ kind: "error", message: e instanceof Error ? e.message : "unlock failed" });
    }
  }

  async function doSend(acc: PqAccount) {
    const recipient = effectiveRecipient;
    if (!recipient) {
      setSendMsg({ ok: false, busy: false, text: isNickInput ? "resolve the @nick first" : "enter a valid 0x recipient address" });
      return;
    }
    let valueWei: bigint;
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
    try {
      setSending(true);
      setSendMsg({ ok: false, busy: true, text: "tap your key..." });
      const prf = await tapForPrf();
      setSendMsg({ ok: false, busy: true, text: "deploying (if needed) + spending..." });
      const res = await spend(prf, recipient, valueWei);
      setSendMsg({ ok: true, busy: false, text: res.deployTxHash ? "deployed + spent" : "spent" });
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

  return (
    <Box sx={{ maxWidth: 520, mx: "auto", px: 2, py: 3 }}>
      {/* Header: which rail is active and how it is served. */}
      <Box sx={{ mb: 2 }}>
        <Box sx={{ fontSize: "1.1rem", fontWeight: 600 }}>{HEGOTA.name}</Box>
        <Box sx={{ ...label, mt: 0.5 }}>
          chain {HEGOTA.chainId} · frame-native · post-quantum ML-DSA
        </Box>
        <Vs
          a="the same passkey derives an ECDSA secp256k1 owner (quantum-vulnerable)"
          b="the same passkey derives an ML-DSA-44 post-quantum key"
        />
      </Box>

      <Paper variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
        {pq.kind !== "ok" ? (
          <>
            <Box sx={{ ...label, mb: 1 }}>PQ account (ML-DSA, derived from your passkey)</Box>
            <Button variant="contained" onClick={unlock} disabled={pq.kind === "unlocking"}>
              {pq.kind === "unlocking" ? "tap your key..." : "Unlock PQ account"}
            </Button>
            {pq.kind === "error" && (
              <Alert severity="error" sx={{ mt: 2 }}>{pq.message}</Alert>
            )}
          </>
        ) : (
          <>
            {/* Receive: the deterministic CREATE2 address funds arrive to. */}
            <Box sx={{ ...label, mb: 0.5 }}>Your address (send funds here to receive)</Box>
            <Box sx={{ ...mono, mb: 1 }}>{pq.acc.address}</Box>
            <Vs
              a="a Safe account, deployed by a bundler through the ERC-4337 EntryPoint + factory"
              b="an AccountPQ at a deterministic CREATE2 address, deployed by an on-chain sponsor on first spend (no bundler)"
            />
            <Box sx={{ mb: 1 }} />

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
              <Button size="small" variant="text" onClick={() => refreshStatus(pq.acc)} disabled={sending}>
                refresh
              </Button>
            </Box>

            <Divider sx={{ my: 2 }} />

            {/* Send: self-pay ML-DSA spend to a raw 0x address (no pay-by-nick on this rail). */}
            <Box sx={{ ...label, mb: 0.5 }}>Send (self-pay)</Box>
            <Vs
              a="a bundler relays your UserOp and an off-chain paymaster fronts the gas"
              b="self-pay frame-tx: the account pays its own gas from received funds, no relayer"
            />
            <Box sx={{ mb: 1 }} />
            <Box sx={{ fontSize: "0.68rem", opacity: 0.55, mb: 1.5 }}>
              Recipient is a raw 0x address or a <b>@nick</b>. A @nick resolves through the directory;
              paste a plain address to skip it.
            </Box>
            <Vs
              a="pay-by-name reads a registry contract's storage (an SLOAD, and a public, enumerable mapping)"
              b="@nick is proven against a recent merkle root at the 0x8272 predeploy (EIP-8272), storage-free: no SLOAD, nothing enumerable on-chain"
            />
            <Box sx={{ mb: 1 }} />
            <TextField
              fullWidth
              size="small"
              label="Recipient (0x address or @nick)"
              placeholder="0x... or @alice"
              value={to}
              onChange={(e) => { setTo(e.target.value); setResolvedNick(null); setNickMsg(null); }}
              disabled={sending}
              error={to.trim().length > 0 && !isNickInput && !isAddress(to.trim())}
              sx={{ mb: 1 }}
              inputProps={{ style: { fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "0.8rem" } }}
            />

            {/* Pay-by-nick resolve affordance: only when the recipient looks like a @nick. */}
            {isNickInput && !nickResolved && (
              <Button size="small" variant="outlined" onClick={() => void doResolveNick()} disabled={sending || resolvingNick} sx={{ mb: 1.5 }}>
                {resolvingNick ? "resolving..." : "Resolve @nick"}
              </Button>
            )}
            {nickResolved && (
              <Box sx={{ mb: 1.5, p: 1, border: "1px solid", borderColor: "success.main", borderRadius: 1, fontSize: "0.72rem" }}>
                <Box sx={{ color: "success.main", fontWeight: 600, mb: 0.25 }}>
                  @{resolvedNick!.name} resolved · recent-roots ✓ (slot {resolvedNick!.slot})
                </Box>
                <Box sx={{ ...mono, fontSize: "0.72rem" }}>{resolvedNick!.address}</Box>
                <Box sx={{ opacity: 0.55, mt: 0.25 }}>
                  authenticated against the directory root at 0x8272, no storage read
                </Box>
              </Box>
            )}
            {nickMsg && <Alert severity="warning" sx={{ mb: 1.5 }}>{nickMsg}</Alert>}
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
            <Button
              variant="contained"
              onClick={() => doSend(pq.acc)}
              disabled={sending || !effectiveRecipient || amount.trim().length === 0}
            >
              {sending ? "tap your key..." : "Send (self-pay)"}
            </Button>

            {sendMsg && (
              <Alert severity={sendMsg.ok ? "success" : sendMsg.busy ? "info" : "error"} sx={{ mt: 2 }}>
                {sendMsg.text}
              </Alert>
            )}

            {decoded && (
              <Box sx={{ mt: 2 }}>
                <Box sx={{ ...label, mb: 0.5 }}>Frame-tx decoded — what you just signed</Box>
                <Box sx={{ fontSize: "0.68rem", opacity: 0.55, mb: 0.5 }}>
                  No opaque UserOp: this is the actual EIP-8141 frame transaction, frame by frame.
                </Box>
                {decoded.deploy && <FrameTxView d={decoded.deploy} />}
                <FrameTxView d={decoded.spend} />

                <Box sx={{ mt: 1.5, pl: 1, borderLeft: "2px solid", borderColor: "divider", fontSize: "0.68rem", opacity: 0.72, lineHeight: 1.6 }}>
                  <Box sx={{ fontWeight: 600, mb: 0.25 }}>On the ML-DSA verify (the DEFAULT frame)</Box>
                  Today the signature is checked inline in the EVM (~15M gas). <b>EIP-8355</b> (a native ML-DSA
                  verification precompile — candidate, not yet on this devnet) would cut that to ~6.5k gas (~758×).
                  <Box sx={{ mt: 0.5 }}>
                    <b>EIP-8288</b> goes further (candidate, Buterin/Coratger; targets &ldquo;I-star&rdquo;, the fork after
                    Hegota): a SIGNATURE frame that accepts STARK proofs and aggregates many PQ signatures off-chain
                    into one recursive STARK the block verifies, so N spends cost about as much as 1 — collapsing the
                    per-op gas at scale.
                  </Box>
                  <Box sx={{ mt: 0.5 }}>
                    ML-DSA is <b>lattice-based</b> (module-LWE). The lean-Ethereum / L-star direction (&ldquo;believe in
                    hashes&rdquo;) favors <b>non-lattice</b>, hash-based signatures (SLH-DSA / SPHINCS+) as more robust
                    against AI-accelerated lattice cryptanalysis. This rail is verifier-agnostic (EIP-8141 + ERC-7913),
                    so the signature can swap ML-DSA → SLH-DSA without rebuilding.
                  </Box>
                </Box>
              </Box>
            )}
          </>
        )}
      </Paper>
    </Box>
  );
}
