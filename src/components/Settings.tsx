"use client";
import { useState } from "react";
import SettingsIcon from "@mui/icons-material/Settings";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import { IconButton, Paper, TextField, MenuItem, Popover, Box } from "@mui/material";
import {
  getSymbol,
  setSymbolConfig,
  getDecimals,
  setDecimalsConfig,
  getUtxoCleanup,
  DEFAULT_SYMBOL,
  DEFAULT_DECIMALS,
} from "@/lib/localstorage";
import { NETWORKS, activeNetwork, setActiveNetwork } from "@/lib/networks";

// R1DO's standard info indicator: click-to-open Popover (mobile-friendly), same
// look as the Announce/Ghost explainer — NOT a hover Tooltip.
function InfoDot({ children }: { children: React.ReactNode }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <IconButton
        size="small"
        onClick={(e) => setAnchor(e.currentTarget)}
        sx={{ p: 0.25, color: (t) => (t.palette.mode === "dark" ? "#fff" : "inherit") }}
        aria-label="More info"
      >
        <InfoOutlinedIcon sx={{ fontSize: "0.8rem" }} />
      </IconButton>
      <Popover
        open={Boolean(anchor)}
        anchorEl={anchor}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
      >
        <Box
          p={2}
          maxWidth={250}
          sx={{
            fontSize: "0.7rem",
            lineHeight: 1.5,
            fontFamily: "var(--font-geist-mono), monospace",
            backgroundColor: (t) => (t.palette.mode === "dark" ? "#222" : "#3B3B3B"),
            color: "#fff",
          }}
        >
          {children}
        </Box>
      </Popover>
    </>
  );
}

const inputSx = {
  "& .MuiInputBase-input": {
    fontFamily: "var(--font-geist-mono), monospace",
    fontSize: "0.85rem",
  },
  "& .MuiInputLabel-root": {
    fontFamily: "var(--font-geist-mono), monospace",
    fontSize: "0.75rem",
  },
};

export function Settings({
  privacy = false,
  username,
  minimal = false,
  networkOnly = false,
  findable = false,
  publishing = false,
  scanning = false,
  onMakeFindable,
}: {
  privacy?: boolean;
  username?: string;
  minimal?: boolean;
  // Login-screen variant: shows ONLY the network selector, unlocked. Scaffolding
  // for multichain — picking does nothing functional yet (single network), it
  // just plants the switcher's home. Mutually exclusive with `minimal`.
  networkOnly?: boolean;
  // Findability (pay-by-username directory). The "Make me findable" action is
  // surfaced here too — the permanent home for it — but ONLY while the wallet
  // is NOT yet published (`!findable`). Same opt-in as the home-screen nudge.
  findable?: boolean;
  publishing?: boolean;
  // UTXO scan in progress → the publish stays blocked until it finishes (they'd
  // otherwise fight for the same rate-limited RPCs).
  scanning?: boolean;
  onMakeFindable?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [seedWorking, setSeedWorking] = useState(false);
  const [seedPhrase, setSeedPhrase] = useState<string | null>(null);
  const [seedErr, setSeedErr] = useState<string | null>(null);

  // Reveal the 0zk recovery seed AFTER a fresh passkey confirmation. The phrase
  // is derived client-side from the PRF (never stored, never logged) and shown so
  // the user can back it up / import it into a standard RAILGUN wallet. Dynamic
  // imports keep the auth/seed code (and any heavy deps) out of this component's
  // SSR module graph.
  const handleRevealSeed = async () => {
    if (!username) return;
    setSeedErr(null);
    setSeedWorking(true);
    let prf: Uint8Array | null = null;
    try {
      const { getWalletCredential } = await import("@/lib/credstore");
      const { loadFromDevice } = await import("@/lib/passkeys");
      const { poolMnemonicFromPRF } = await import("@/lib/pool/seed");
      const cred = await getWalletCredential(username).catch(() => null);
      if (!cred?.rawId) throw new Error("no credential found for this account");
      prf = await loadFromDevice(cred.rawId);
      if (!prf || prf.length === 0) throw new Error("passkey/PRF unavailable on this device");
      setSeedPhrase(poolMnemonicFromPRF(prf));
    } catch (e) {
      setSeedErr((e as Error)?.message ?? String(e));
    } finally {
      if (prf) prf.fill(0);
      setSeedWorking(false);
    }
  };

  const closePanel = () => {
    setSeedPhrase(null); // never leave the seed lingering in state after closing
    setSeedErr(null);
    setOpen(false);
  };
  const [symbol, setSymbol] = useState(DEFAULT_SYMBOL);
  const [decimals, setDecimals] = useState(DEFAULT_DECIMALS);
  // `cleanup` is LOCKED for now (tombstone-only); the UI is wired so flipping
  // `disabled` off later ships it. `network` is LIVE — it drives the switcher
  // (handleNetworkChange: persist + reload).
  const [cleanup, setCleanup] = useState<string>("tombstone");
  const [network, setNetwork] = useState<string>(activeNetwork().id);
  const [confirmResync, setConfirmResync] = useState(false);
  const [resyncing, setResyncing] = useState(false);
  const [resyncMsg, setResyncMsg] = useState<string | null>(null);

  const handleResync = async () => {
    setConfirmResync(false);
    setResyncMsg(null);
    setResyncing(true);
    try {
      // Dynamic import: keeps the Railgun SDK (+ its WASM) out of this client
      // component's SSR module graph (a static import crashes `next start` —
      // the WASM loader builds a relative URL that Node can't parse server-side).
      const { resyncPool } = await import("@/lib/pool/railgun");
      await resyncPool();
      setResyncMsg("Re-sync complete.");
    } catch (e) {
      setResyncMsg("Re-sync failed: " + ((e as Error)?.message ?? String(e)));
    } finally {
      setResyncing(false);
    }
  };

  // Switching network persists the choice and RELOADS: the active network feeds
  // module-level consts (RPC_URLS, BUNDLER_URL…) frozen at import, so a clean
  // reload is the simplest correct way to re-derive them everywhere. The reload
  // also clears the in-memory session (no silent F5 restore) → you land on the
  // login screen for the newly selected chain, which is exactly the switch flow.
  const handleNetworkChange = (id: string) => {
    if (id === activeNetwork().id) return;
    setNetwork(id);
    setActiveNetwork(id as (typeof NETWORKS)[number]["id"]);
    window.location.reload();
  };

  const handleOpen = () => {
    setSymbol(getSymbol());
    setDecimals(getDecimals());
    setCleanup(getUtxoCleanup());
    setNetwork(activeNetwork().id);
    setConfirmResync(false);
    setSeedPhrase(null);
    setSeedErr(null);
    setOpen(true);
  };

  const handleSymbolChange = (value: string) => {
    const trimmed = value.slice(0, 7);
    setSymbol(trimmed);
    setSymbolConfig(trimmed || DEFAULT_SYMBOL);
  };

  const handleDecimalsChange = (value: string) => {
    const parsed = parseInt(value);
    if (Number.isNaN(parsed)) return;
    const clamped = Math.min(Math.max(parsed, 0), 18);
    setDecimals(clamped);
    setDecimalsConfig(clamped);
  };

  return (
    <>
      <IconButton
        onClick={handleOpen}
        title="Settings"
        size="small"
        sx={{
          position: "fixed",
          // Sit just above the fixed bottom action bar (UserMenu, ~57px tall)
          // instead of overlapping it. Respects the safe-area inset the bar uses.
          bottom: "calc(72px + env(safe-area-inset-bottom))",
          right: 16,
          zIndex: 999,
          opacity: 0.5,
          border: "1px solid currentColor",
          borderRadius: "2px",
          color: "text.secondary",
          "&:hover": { opacity: 1 },
        }}
      >
        <SettingsIcon fontSize="small" />
      </IconButton>

      {open && (
        <div
          onClick={closePanel}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            zIndex: 1000,
            fontFamily: "var(--font-geist-mono), monospace",
          }}
        >
          <Paper
            onClick={(e) => e.stopPropagation()}
            sx={{
              border: "1px solid currentColor",
              padding: "2rem 2.5rem",
              minWidth: 300,
              maxWidth: 400,
              display: "flex",
              flexDirection: "column",
              gap: "1.2rem",
              fontFamily: "var(--font-geist-mono), monospace",
            }}
          >
            <p style={{ fontSize: "0.75rem", letterSpacing: "0.08em" }}>
              [SETTINGS]
            </p>

            {!minimal && !networkOnly && (
            <div>
              <p style={{ fontSize: "0.8rem", marginBottom: "10px" }}>
                Native unit display
              </p>
              <div style={{ display: "flex", gap: "0.8rem" }}>
                <TextField
                  label="Symbol"
                  size="small"
                  value={symbol}
                  onChange={(e) => handleSymbolChange(e.target.value)}
                  sx={{ ...inputSx, width: 110 }}
                />
                <TextField
                  label="Decimals"
                  size="small"
                  type="number"
                  value={decimals}
                  onChange={(e) => handleDecimalsChange(e.target.value)}
                  inputProps={{ min: 0, max: 18 }}
                  sx={{ ...inputSx, width: 110 }}
                />
              </div>
            </div>
            )}

            {networkOnly && (
            <div>
              <p style={{ fontSize: "0.8rem", marginBottom: "10px" }}>
                Network
              </p>
              <TextField
                select
                size="small"
                value={network}
                onChange={(e) => handleNetworkChange(e.target.value)}
                sx={{ ...inputSx, width: "100%" }}
              >
                {NETWORKS.map((n) => (
                  <MenuItem key={n.id} value={n.id}>{n.chain.name}</MenuItem>
                ))}
              </TextField>
            </div>
            )}

            {!minimal && !networkOnly && onMakeFindable && !findable && (
            <div>
              <p style={{ fontSize: "0.8rem", marginBottom: "10px", display: "flex", alignItems: "center", gap: "6px" }}>
                Findability
                <InfoDot>
                  Publish an encrypted directory entry so others can pay you by
                  username. Optional and one-time; until then you can still
                  receive by sharing your address.
                </InfoDot>
              </p>
              <button
                onClick={onMakeFindable}
                disabled={publishing || scanning}
                style={{
                  background: "transparent",
                  border: "1px solid currentColor",
                  color: "inherit",
                  fontFamily: "var(--font-geist-mono), monospace",
                  fontSize: "0.75rem",
                  letterSpacing: "0.08em",
                  padding: "6px 12px",
                  cursor: publishing || scanning ? "default" : "pointer",
                  opacity: publishing || scanning ? 0.5 : 1,
                  width: "100%",
                }}
              >
                {scanning
                  ? "[FINISHING SCAN…]"
                  : publishing
                    ? "[MAKING YOU FINDABLE…]"
                    : "[MAKE ME FINDABLE]"}
              </button>
            </div>
            )}

            {!minimal && !networkOnly && privacy && (
            <div>
              <p style={{ fontSize: "0.8rem", marginBottom: "10px", display: "flex", alignItems: "center", gap: "6px" }}>
                Spent addresses
                <LockOutlinedIcon sx={{ fontSize: "0.8rem", opacity: 0.5 }} />
                <InfoDot>
                  One-time addresses never refund, so once drained they stop being
                  queried. <b>Keep</b> retains the spent record (history). <b>Purge</b>{" "}
                  also deletes the spent record to shrink local storage — except notes
                  that can only be spent from this device, which are always kept
                  (deleting them would lose the funds for good).
                </InfoDot>
              </p>
              <TextField
                select
                size="small"
                value={cleanup}
                disabled
                onChange={(e) => setCleanup(e.target.value)}
                sx={{ ...inputSx, width: "100%" }}
              >
                <MenuItem value="tombstone">Keep spent records</MenuItem>
                <MenuItem value="purge">Purge spent records</MenuItem>
              </TextField>
            </div>
            )}

            {minimal && (
            <div>
              <p style={{ fontSize: "0.8rem", marginBottom: "10px", display: "flex", alignItems: "center", gap: "6px" }}>
                Re-sync from chain
                <InfoDot>
                  Rebuilds this account&apos;s shielded balance by re-scanning the chain
                  from scratch. Use if balances or pending items look stuck. Takes a few
                  minutes; your funds, keys and other accounts are untouched.
                </InfoDot>
              </p>
              {!confirmResync ? (
                <button
                  onClick={() => setConfirmResync(true)}
                  disabled={resyncing}
                  style={{
                    background: "transparent",
                    border: "1px solid currentColor",
                    color: "inherit",
                    fontFamily: "var(--font-geist-mono), monospace",
                    fontSize: "0.75rem",
                    letterSpacing: "0.08em",
                    padding: "6px 12px",
                    cursor: resyncing ? "default" : "pointer",
                    opacity: resyncing ? 0.5 : 1,
                    width: "100%",
                  }}
                >
                  {resyncing ? "[RE-SYNCING… can take minutes]" : "[RE-SYNC]"}
                </button>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  <span style={{ fontSize: "0.72rem", opacity: 0.8, lineHeight: 1.5 }}>
                    Rebuild from chain? This can take a few minutes.
                  </span>
                  <div style={{ display: "flex", gap: "0.6rem" }}>
                    <button
                      onClick={handleResync}
                      style={{
                        background: "transparent",
                        border: "1px solid currentColor",
                        color: "inherit",
                        fontFamily: "var(--font-geist-mono), monospace",
                        fontSize: "0.75rem",
                        letterSpacing: "0.08em",
                        padding: "6px 12px",
                        cursor: "pointer",
                        flex: 1,
                      }}
                    >
                      [CONFIRM]
                    </button>
                    <button
                      onClick={() => setConfirmResync(false)}
                      style={{
                        background: "transparent",
                        border: "1px solid currentColor",
                        color: "inherit",
                        opacity: 0.6,
                        fontFamily: "var(--font-geist-mono), monospace",
                        fontSize: "0.75rem",
                        letterSpacing: "0.08em",
                        padding: "6px 12px",
                        cursor: "pointer",
                        flex: 1,
                      }}
                    >
                      [CANCEL]
                    </button>
                  </div>
                </div>
              )}
              {resyncMsg && (
                <p style={{ fontSize: "0.72rem", opacity: 0.8, marginTop: "8px" }}>{resyncMsg}</p>
              )}
            </div>
            )}

            {minimal && username && (
            <div>
              <p style={{ fontSize: "0.8rem", marginBottom: "10px", display: "flex", alignItems: "center", gap: "6px" }}>
                Recovery seed
                <InfoDot>
                  The 12-word phrase that controls this account&apos;s shielded (0zk)
                  funds. Import it into any standard RAILGUN wallet to recover your funds
                  without R1DO. Anyone who sees it can take those funds — never share it
                  or type it into a site that asks.
                </InfoDot>
              </p>
              {!seedPhrase ? (
                <button
                  onClick={handleRevealSeed}
                  disabled={seedWorking}
                  style={{
                    background: "transparent",
                    border: "1px solid currentColor",
                    color: "inherit",
                    fontFamily: "var(--font-geist-mono), monospace",
                    fontSize: "0.75rem",
                    letterSpacing: "0.08em",
                    padding: "6px 12px",
                    cursor: seedWorking ? "default" : "pointer",
                    opacity: seedWorking ? 0.5 : 1,
                    width: "100%",
                  }}
                >
                  {seedWorking ? "[CONFIRM ON YOUR DEVICE…]" : "[SHOW SEED — confirm passkey]"}
                </button>
              ) : (
                <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                  <div
                    style={{
                      border: "1px solid currentColor",
                      borderRadius: "2px",
                      padding: "10px 12px",
                      fontSize: "0.8rem",
                      lineHeight: 1.8,
                      wordSpacing: "0.3em",
                      userSelect: "all",
                    }}
                  >
                    {seedPhrase}
                  </div>
                  <div style={{ display: "flex", gap: "0.6rem" }}>
                    <button
                      onClick={() => navigator.clipboard?.writeText(seedPhrase)}
                      style={{
                        background: "transparent",
                        border: "1px solid currentColor",
                        color: "inherit",
                        fontFamily: "var(--font-geist-mono), monospace",
                        fontSize: "0.75rem",
                        letterSpacing: "0.08em",
                        padding: "6px 12px",
                        cursor: "pointer",
                        flex: 1,
                      }}
                    >
                      [COPY]
                    </button>
                    <button
                      onClick={() => setSeedPhrase(null)}
                      style={{
                        background: "transparent",
                        border: "1px solid currentColor",
                        color: "inherit",
                        opacity: 0.6,
                        fontFamily: "var(--font-geist-mono), monospace",
                        fontSize: "0.75rem",
                        letterSpacing: "0.08em",
                        padding: "6px 12px",
                        cursor: "pointer",
                        flex: 1,
                      }}
                    >
                      [HIDE]
                    </button>
                  </div>
                </div>
              )}
              {seedErr && (
                <p style={{ fontSize: "0.72rem", opacity: 0.8, marginTop: "8px" }}>Seed reveal failed: {seedErr}</p>
              )}
            </div>
            )}

            {!minimal && !networkOnly && (
            <div>
              <p style={{ fontSize: "0.8rem" }}>
                Feel free to contact me if you have any question or feedback:
              </p>
              <a
                href="https://t.me/Ivanovish10"
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "7px",
                  marginTop: "10px",
                  textDecoration: "none",
                  background: "#229ED9",
                  color: "#fff",
                  borderRadius: "2px",
                  padding: "4px 12px",
                  fontWeight: 600,
                  fontSize: "0.8rem",
                }}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M22 2L11 13" />
                  <path d="M22 2L15 22L11 13L2 9L22 2Z" />
                </svg>
                Telegram
              </a>
            </div>
            )}

            <button
              onClick={closePanel}
              style={{
                background: "transparent",
                border: "1px solid currentColor",
                color: "inherit",
                fontFamily: "var(--font-geist-mono), monospace",
                fontSize: "0.75rem",
                letterSpacing: "0.08em",
                padding: "6px 12px",
                cursor: "pointer",
                alignSelf: "flex-end",
              }}
            >
              [CLOSE]
            </button>
          </Paper>
        </div>
      )}
    </>
  );
}
