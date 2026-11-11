"use client";

// FrameHome: the transparent home of the frame-native "hegota" rail.
//
// Rail-owned, self-contained, removable: it drives the frame rail entirely through
// src/lib/frame/pqClient.ts and never touches the base wallet's 4337 / Railgun stack. It looks and
// flows like the normal wallet (balance card, persistent bottom action bar, Send / Receive / Details
// sub-views, via FrameWalletKit) but every action runs on the post-quantum frame-tx rail, with the
// scheme the user picks (leanSphincs-s hash-based, the default, or ML-DSA-44 lattice), gas paid by
// that scheme's keyless on-chain paymaster, and each send shows the real on-chain anatomy of the
// frame-tx it produced.
//
// Recipient is a raw 0x address: there is no name directory on this rail. Private, unlinkable
// receiving lives in the stealth home (privacy=true).
//
// Removable: delete this file (and the single render that mounts it in rail mode).
import { useState, useEffect, useRef } from "react";
import { Box, Button, Link, Alert } from "@mui/material";
import { parseEther } from "viem";
import { HEGOTA } from "@/lib/frame/network";
import { claimFaucet } from "@/lib/frame/faucet";
import { LOCAL_LAST_USER } from "@/app/constants";
import {
  deriveAccount, readStatus, railStatus, spend, getScheme, setScheme, onSchemeChange, sendEventText,
  type PqAccount, type PqAccountStatus, type PqSpendResult, type PqRailStatus, type PqScheme,
} from "@/lib/frame/pqClient";
import { shortHex } from "@/components/FrameTxView";
import FrameSchemePicker, { SCHEME_INFO, SchemeGas, gasLine } from "@/components/FrameSchemePicker";
import { FrameExplain } from "@/components/FrameSection";
import {
  MONO, captionSx, BAR_SPACE, tapForPrf, shortAddr, useHideBalance,
  BalanceCard, ActionBar, SubHeader, ReceiveBlock, SendFlow, DecodedSection,
} from "@/components/FrameWalletKit";

// Inline "what changes vs the 4337 wallet" note: each differing step explains itself.
function Vs({ a, b }: { a: string; b: string }) {
  return (
    <Box sx={{ mt: 0.75, mb: 0.5, pl: 1, borderLeft: "2px solid", borderColor: "divider", fontSize: "0.68rem", lineHeight: 1.5 }}>
      <Box sx={{ opacity: 0.5 }}><b>4337 wallet:</b> {a}</Box>
      <Box sx={{ color: "success.main", opacity: 0.9 }}><b>Hegota:</b> {b}</Box>
    </Box>
  );
}

// Per-scheme "how the verify works" explanation.
function VerifyExplain({ level }: { level: PqScheme }) {
  return (
    <FrameExplain id="home.last.verify" label={`how the ${level} verify works`}>
      {level === "ML-DSA-44" ? (
        <Box sx={{ mt: 0.75, pl: 1, borderLeft: "2px solid", borderColor: "divider", fontSize: "0.68rem", opacity: 0.72, lineHeight: 1.6 }}>
          <Box sx={{ fontWeight: 600, mb: 0.25 }}>On the ML-DSA-44 verify (the DEFAULT batch frame)</Box>
          The verify costs ~1.25M gas, over the gas cap of the VERIFY prefix, so your account&apos;s VERIFY
          only checks the frame layout (its own verify frame follows, atomically batched with the spend) and
          approves. The DEFAULT frame then runs the ML-DSA verify; a bad signature reverts it and the node skips
          the rest of the batch, so nothing moves. The witness is ~24.7 KB of calldata (expanded public key +
          signature). The ML-DSA paymaster is a separate keyless contract with its own balance, so this
          more expensive class cannot drain the leanSphincs-s paymaster.
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
  );
}

// Unlock state of the SELECTED scheme's account (the derived accounts themselves are kept per scheme).
type Unlock =
  | { kind: "idle" }
  | { kind: "unlocking" }
  | { kind: "error"; message: string };

type View = "menu" | "send" | "receive" | "details";


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
  const [view, setView] = useState<View>("menu");
  const [lastResult, setLastResult] = useState<PqSpendResult | null>(null);
  // Faucet claim for the shown account: idle, pending, or the faucet's answer.
  const [claim, setClaim] = useState<{ busy: boolean; ok?: boolean; text?: string }>({ busy: false });
  const [hidden, toggleHidden] = useHideBalance();

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
    setLastResult(null);
    setClaim({ busy: false });
    setView("menu");
    if (acc) void refreshStatus(acc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [acc?.address, scheme]);

  // One faucet claim per click, then poll the balance a few times until the funds land.
  async function doClaim(a: PqAccount) {
    setClaim({ busy: true });
    const r = await claimFaucet(a.address);
    setClaim({ busy: false, ok: r.ok, text: r.text || (r.ok ? "ok" : "failed") });
    if (!r.ok) return;
    for (let i = 0; i < 6; i++) {
      await new Promise((res) => setTimeout(res, 5000));
      if (schemeRef.current !== a.level) return;
      await refreshStatus(a);
    }
  }

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

  const balWei = acctStatus ? BigInt(acctStatus.balanceWei) : null;
  // Low enough that receiving is the obvious next step: surface the faucet hint.
  const lowBalance = balWei !== null && balWei < parseEther("0.001");
  const sponsored = rail ? rail.mode === "sponsored" : true;
  const used = acctStatus?.signaturesUsed ?? 0;
  // Only leanSphincs-s has a signature budget (null for the stateless ML-DSA-44).
  const budget = rail?.signatureBudget ?? null;
  const budgetWarn = rail?.budgetWarn != null && used >= rail.budgetWarn;
  const info = SCHEME_INFO[scheme];
  const verifier = info.verifier;
  const user = typeof localStorage !== "undefined" ? localStorage.getItem(LOCAL_LAST_USER) : null;
  const unlocking = unlockState.kind === "unlocking";

  const unlockBlock = (
    <Box>
      <Box sx={{ ...captionSx, mb: 1 }}>PQ account ({scheme}, derived from your passkey)</Box>
      <Button variant="contained" onClick={() => void unlock()} disabled={unlocking}>
        {unlocking ? "tap your key..." : `Unlock ${scheme} account`}
      </Button>
      {unlockState.kind === "error" && <Alert severity="error" sx={{ mt: 2 }}>{unlockState.message}</Alert>}
    </Box>
  );

  const budgetAlert = budgetWarn && budget !== null && (
    <Alert severity="warning">
      This key has used {used.toLocaleString()} of its ~{budget.toLocaleString()} signatures.
      Spends are blocked at {(rail?.budgetBlock ?? budget).toLocaleString()}: plan to move the funds to a new account.
    </Alert>
  );

  let body: React.ReactNode;
  if (view === "send" && acc) {
    body = (
      <>
        <SubHeader title="Send" onBack={() => setView("menu")} />
        <FrameExplain id="home.send.vs">
          <Vs
            a="a bundler relays your UserOp and an off-chain paymaster fronts the gas"
            b="frame-tx: your account approves execution, a keyless on-chain paymaster (gated by your account's code hash) pays the gas; no bundler, no relayer, no operator key"
          />
        </FrameExplain>
        <SendFlow
          fromLabel={shortAddr(acc.address)}
          availableWei={balWei ?? 0n}
          scheme={acc.level}
          sponsored={sponsored}
          gasText={gasLine(rail)}
          run={async (recipient, valueWei, sweep, onProgress) => {
            const prf = await tapForPrf();
            onProgress(`signing with ${acc.level} and sending${acc.level === "ML-DSA-44" ? " (ML-DSA is slower)" : ""}...`);
            const res = await spend(prf, recipient, valueWei, sweep, acc.level, (ev) => onProgress(sendEventText(ev)));
            await refreshStatus(acc);
            return res;
          }}
          onClose={(res) => {
            if (res) setLastResult(res);
            setView("menu");
          }}
        />
      </>
    );
  } else if (view === "receive") {
    body = (
      <>
        <SubHeader title="Receive" onBack={() => setView("menu")} />
        {acc && (lowBalance || claim.busy || claim.text) && (
          <Alert
            sx={{ mb: 2, alignItems: "center" }}
            severity={claim.text && claim.ok === false ? "error" : claim.text && claim.ok ? "success" : "info"}
            action={lowBalance && !claim.ok && (
              <Button color="inherit" size="small" variant="outlined" disabled={claim.busy} onClick={() => void doClaim(acc)}>
                {claim.busy ? "claiming..." : "Get test funds"}
              </Button>
            )}
          >
            {claim.busy
              ? "Asking the testnet faucet..."
              : claim.text
                ? claim.ok ? "Test funds requested. The balance updates when they land." : `Faucet: ${claim.text}`
                : "Low balance."}
          </Alert>
        )}
        {acc ? (
          <ReceiveBlock
            address={acc.address}
            caption="Your address"
            footnote={`Receives ${HEGOTA.symbol} on ${HEGOTA.name} only (chain ${HEGOTA.chainId})`}
          >
            <FrameExplain id="home.address.vs">
              <Vs
                a="a Safe account, deployed by a bundler through the ERC-4337 EntryPoint + factory"
                b={`an ${info.accountClass} at a deterministic CREATE2 address, deployed by an on-chain sponsor on first spend (no bundler)`}
              />
            </FrameExplain>
          </ReceiveBlock>
        ) : unlockBlock}
      </>
    );
  } else if (view === "details") {
    body = (
      <>
        <SubHeader title="Details" onBack={() => setView("menu")} />
        <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
          <Box>
            <Box sx={captionSx}>About this rail</Box>
            <Box sx={{ ...captionSx, mt: 0.5 }}>
              chain {HEGOTA.chainId} · frame-native · post-quantum {scheme} ({scheme === "ML-DSA-44" ? "lattice" : "hash-based"})
            </Box>
            <Vs
              a="the same passkey derives an ECDSA secp256k1 owner (quantum-vulnerable)"
              b={`the same passkey derives ${info.keyText}`}
            />
          </Box>

          <SchemeGas scheme={scheme} />

          {acc ? (
            <Box sx={{ p: 1.25, border: "1px solid", borderColor: "success.main", borderRadius: 1.5 }}>
              <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 1, mb: 0.5 }}>
                <Box component="span" sx={{ ...captionSx, color: "success.main", opacity: 1 }}>Your signing key</Box>
                <Box component="span" sx={{ fontFamily: MONO, fontSize: "0.56rem", letterSpacing: "0.08em", color: "success.main", border: "1px solid", borderColor: "success.main", borderRadius: 0.5, px: 0.5, py: 0.1 }}>
                  POST-QUANTUM
                </Box>
              </Box>
              <Box sx={{ fontSize: "0.95rem", fontWeight: 600 }}>
                {acc.level}
                <Box component="span" sx={{ opacity: 0.55, fontWeight: 400, fontSize: "0.7rem" }}> · {info.family}</Box>
              </Box>
              <Box sx={{ fontFamily: MONO, fontSize: "0.72rem", opacity: 0.85, mt: 0.5, wordBreak: "break-all" }}>
                public key {acc.publicKeyBytes.toLocaleString()} B · signature {acc.signatureBytes.toLocaleString()} B
              </Box>
              <Box sx={{ fontSize: "0.64rem", opacity: 0.5 }}>
                a normal wallet (ECDSA secp256k1) is 33 B / 65 B, breakable by a quantum computer
              </Box>
              <Box sx={{ fontFamily: MONO, fontSize: "0.7rem", opacity: 0.8, mt: 0.5 }}>account salt {shortHex(acc.salt)}</Box>
              {acctStatus && rail && (
                <Box sx={{ fontFamily: MONO, fontSize: "0.7rem", opacity: 0.8 }}>
                  {budget !== null
                    ? `signatures used ${used.toLocaleString()} / ${budget.toLocaleString()}`
                    : `signatures used ${used.toLocaleString()} (stateless scheme, no budget)`}
                </Box>
              )}
              {verifier && (
                <Box sx={{ fontSize: "0.64rem", opacity: 0.6, mt: 0.4, lineHeight: 1.5 }}>
                  verified on-chain by{" "}
                  <Link href={`${HEGOTA.explorerUrl}/address/${verifier}`} target="_blank" rel="noopener" sx={{ fontFamily: MONO }}>
                    {shortHex(verifier)} ↗
                  </Link>{" "}
                  ({info.verifierText}): funds move only if your post-quantum signature is VALID.
                </Box>
              )}
            </Box>
          ) : unlockBlock}

          {budgetAlert}

        </Box>
      </>
    );
  } else {
    body = (
      <Box sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <BalanceCard
          wei={acc ? balWei : null}
          hidden={hidden}
          onToggleHide={toggleHidden}
          subline={`${user ?? "-"} · ${scheme} · ${HEGOTA.name}`}
        >
          {acc && (
            <Box sx={{ fontFamily: MONO, fontSize: "0.66rem", opacity: 0.6, mt: 0.5, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1 }}>
              <span>
                {acctStatus === null ? "reading..." : acctStatus.deployed ? "deployed" : "not deployed, deploys on first spend"}
              </span>
              <Button size="small" variant="text" onClick={() => void refreshStatus(acc)} sx={{ fontSize: "0.66rem", minWidth: 0, py: 0 }}>
                refresh
              </Button>
            </Box>
          )}
        </BalanceCard>

        {!acc && unlockBlock}

        <FrameSchemePicker scheme={scheme} onChange={choose} disabled={unlocking} context="transparent" />

        {acc && budgetAlert}

        {acc && lastResult && (
          <Box>
            <Box sx={captionSx}>Last transaction</Box>
            <Box sx={{ fontSize: "0.72rem", opacity: 0.8, my: 0.5 }}>
              {lastResult.mode === "sponsored" ? "sponsored by the keyless paymaster" : "self-pay"}
            </Box>
            <DecodedSection decoded={lastResult.decoded} id="home.last.decoded" />
            <VerifyExplain level={acc.level} />
          </Box>
        )}
      </Box>
    );
  }

  return (
    <Box sx={{ display: "flex", flexDirection: "column", maxWidth: 400, mx: "auto", width: "100%", px: 2, py: 3 }}>
      <Box sx={{ pb: BAR_SPACE }}>{body}</Box>
      <ActionBar
        active={view === "menu" ? null : view}
        onSelect={(s) => setView(view === s ? "menu" : s)}
        sendDisabled={!acc || !balWei}
      />
    </Box>
  );
}
