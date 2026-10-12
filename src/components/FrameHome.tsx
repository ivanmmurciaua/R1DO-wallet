"use client";

// FrameHome — the main wallet view when the frame-native "hegota" rail is the active network.
//
// Rail-owned, self-contained, removable: it drives the frame rail entirely through
// src/lib/frame/pqClient.ts and never touches the base wallet's 4337 / Railgun stack.
// It mirrors the normal wallet home UX (receive address, balance, send form) but every
// action runs on the post-quantum ML-DSA frame-tx rail, and each send shows the real
// on-chain anatomy of the frame-tx it produced (not an opaque 4337 UserOp).
//
// Recipient is a raw 0x address: there is no name directory on this rail. Private, unlinkable
// receiving lives in the stealth home (privacy=true), not in a reusable-address nick scheme.
//
// Removable: delete this file (and the single render that mounts it in rail mode).
import { useState, useEffect } from "react";
import { Paper, Box, Button, Link, TextField, Alert, Divider } from "@mui/material";
import { formatEther, parseEther, isAddress } from "viem";
import { HEGOTA } from "@/lib/frame/network";
import { loadFromDevice } from "@/lib/passkeys";
import { getWalletCredential } from "@/lib/credstore";
import { LOCAL_LAST_USER } from "@/app/constants";
import { deriveAccount, readStatus, spend, type PqAccount, type PqAccountStatus, type PqSpendResult } from "@/lib/frame/pqClient";
import FrameTxView, { shortHex } from "@/components/FrameTxView";

// Reads LOCAL_LAST_USER, fetches the stored credential, and taps the authenticator to get
// the 32-byte PRF root the rail derives its ML-DSA identity from.
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

  // Adopt the account derived at login (arrives async) and read its on-chain status.
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
    const recipient = to.trim();
    if (!isAddress(recipient)) {
      setSendMsg({ ok: false, busy: false, text: "enter a valid 0x recipient address" });
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
            {/* PQ identity card: make it explicit (and on-chain-verifiable) that this account
                signs with a post-quantum scheme, not ECDSA. */}
            <Box sx={{ mb: 2, p: 1.25, border: "1px solid", borderColor: "success.main", borderRadius: 1.5 }}>
              <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 0.4 }}>
                <Box sx={{ ...label, color: "success.main", opacity: 1 }}>Your signing key</Box>
                <Box component="span" sx={{ fontFamily: "ui-monospace,monospace", fontSize: "0.56rem", letterSpacing: "0.08em", color: "success.main", border: "1px solid", borderColor: "success.main", borderRadius: 0.5, px: 0.5, py: 0.1 }}>
                  POST-QUANTUM
                </Box>
              </Box>
              <Box sx={{ fontSize: "0.95rem", fontWeight: 600 }}>
                {pq.acc.level}
                <Box component="span" sx={{ opacity: 0.55, fontWeight: 400, fontSize: "0.7rem" }}> · FIPS-204 · lattice (module-LWE)</Box>
              </Box>
              <Box sx={{ ...mono, fontSize: "0.72rem", opacity: 0.85, mt: 0.5 }}>
                public key {pq.acc.publicKeyBytes.toLocaleString()} B · signature {pq.acc.signatureBytes.toLocaleString()} B
              </Box>
              <Box sx={{ fontSize: "0.64rem", opacity: 0.5 }}>
                a normal wallet (ECDSA secp256k1) is 33 B / 65 B — breakable by a quantum computer
              </Box>
              <Box sx={{ ...mono, fontSize: "0.7rem", opacity: 0.8, mt: 0.5 }}>key commitment {shortHex(pq.acc.commit)}</Box>
              {HEGOTA.singletons?.verifier && (
                <Box sx={{ fontSize: "0.64rem", opacity: 0.6, mt: 0.4, lineHeight: 1.5 }}>
                  verified on-chain by{" "}
                  <Link href={`${HEGOTA.explorerUrl}/address/${HEGOTA.singletons.verifier}`} target="_blank" rel="noopener" sx={{ fontFamily: "ui-monospace,monospace" }}>
                    {shortHex(HEGOTA.singletons.verifier)} ↗
                  </Link>{" "}
                  (ZKNOX inline ML-DSA verifier): your account&apos;s own code runs it to approve every spend, so funds
                  move only if your post-quantum signature is VALID.
                </Box>
              )}
            </Box>

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

            {/* Send: self-pay ML-DSA spend to a raw 0x address. */}
            <Box sx={{ ...label, mb: 0.5 }}>Send (self-pay)</Box>
            <Vs
              a="a bundler relays your UserOp and an off-chain paymaster fronts the gas"
              b="self-pay frame-tx: the account pays its own gas from received funds, no relayer"
            />
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
            <Button
              variant="contained"
              onClick={() => doSend(pq.acc)}
              disabled={sending || !isAddress(to.trim()) || amount.trim().length === 0}
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
