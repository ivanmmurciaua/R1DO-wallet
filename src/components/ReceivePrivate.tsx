import React, { useState } from "react";
import { Box, Button, Stack, Typography, Collapse } from "@mui/material";
import { generateStealthPayment, derivePQKeysFromPRF, buildStealthTicket, extractStealthBlobs, checkPQPayment, type StealthUTXO } from "@/lib/stealth";
import { getMetaAddress, saveMetaAddress, addStealthUTXO, getStealthUTXOs, patchStealthUTXO } from "@/lib/localstorage";
import { getWalletCredential } from "@/lib/credstore";
import { loadFromDevice } from "@/lib/passkeys";

type ReceivePrivateProps = {
  username: string;
  onBack: (message?: string) => void;
};

type Detail = { address: `0x${string}`; ticket: `0x${string}` | null };

const inputStyle: React.CSSProperties = {
  fontSize: "1rem",
  fontFamily: "var(--font-geist-mono), monospace",
  borderRadius: "2px",
  border: "1px solid currentColor",
  background: "transparent",
  color: "inherit",
  width: "100%",
  padding: "12px 14px",
  boxSizing: "border-box",
  outline: "none",
  letterSpacing: "0.04em",
  opacity: 0.7,
  transition: "opacity 0.15s",
};

const short = (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`;

// Pre-minted receive addresses are the StealthUTXOs we created ourselves (Δ1
// off-chain Courier flow): tagged with `createdAt`, newest first.
const loadReceives = (username: string): StealthUTXO[] =>
  getStealthUTXOs(username)
    .filter((u) => typeof u.createdAt === "number")
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

export const ReceivePrivate: React.FC<ReceivePrivateProps> = ({ username, onBack }) => {
  const [memo, setMemo] = useState("");
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [showTicket, setShowTicket] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [receives, setReceives] = useState<StealthUTXO[]>(() => loadReceives(username));
  const [importOpen, setImportOpen] = useState(false);
  const [importText, setImportText] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importMsg, setImportMsg] = useState<string | null>(null);

  const refresh = () => setReceives(loadReceives(username));

  const copy = (label: string, value: string) => {
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(label);
      setTimeout(() => setCopied((c) => (c === label ? null : c)), 1500);
    });
  };

  const openDetail = (d: Detail) => {
    setShowTicket(false);
    setDetail(d);
  };

  const handleCreate = async () => {
    setBusy(true);
    try {
      // Minting only needs the PUBLIC meta-address → no passkey in the common
      // case. We only tap the passkey if it isn't cached yet.
      let meta = getMetaAddress(username);
      if (!meta) {
        const cred = await getWalletCredential(username).catch(() => null);
        if (!cred) return onBack("Passkey not found on this device.");
        const prf = await loadFromDevice(cred.rawId);
        if (!prf || prf.length === 0) return onBack("Could not access your passkey. Try again.");
        meta = (await derivePQKeysFromPRF(prf)).pqMetaAddress;
        saveMetaAddress(username, meta);
      }

      const pay = await generateStealthPayment(meta);
      addStealthUTXO(username, {
        stealthAddress: pay.stealthAddress,
        ephemeralPubkey: pay.ephemeralPubkey,
        kemCiphertext: pay.kemCiphertext,
        blockNumber: 0,
        createdAt: Date.now(),
        memo: memo.trim() || undefined,
        viewTag: pay.viewTag,
      });

      setMemo("");
      openDetail({ address: pay.stealthAddress, ticket: pay.calldataBlob });
      refresh();
    } catch (e) {
      console.error("[ReceivePrivate] create error:", e);
      onBack("Could not create a receive address.");
    } finally {
      setBusy(false);
    }
  };

  const toggleHidden = (u: StealthUTXO) => {
    patchStealthUTXO(username, u.stealthAddress, { hidden: !u.hidden });
    // Closing the detail if we just hid the address being shown keeps the UI tidy.
    if (!u.hidden && detail?.address === u.stealthAddress) setDetail(null);
    refresh();
  };

  const handleImport = async () => {
    const raw = importText.trim();
    if (!raw) return;
    setImportBusy(true);
    setImportMsg(null);
    try {
      const hex = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
      const blobs = extractStealthBlobs(hex);
      if (blobs.length === 0) {
        setImportMsg("That doesn't look like a valid ticket.");
        return;
      }
      const cred = await getWalletCredential(username).catch(() => null);
      if (!cred) {
        setImportMsg("Passkey not found on this device.");
        return;
      }
      const prf = await loadFromDevice(cred.rawId);
      if (!prf || prf.length === 0) {
        setImportMsg("Could not access your passkey. Try again.");
        return;
      }
      const keys = await derivePQKeysFromPRF(prf);

      let added = 0;
      for (const blob of blobs) {
        // Trial-decrypt: returns the stealth address only if this ticket is ours.
        const addr = await checkPQPayment(keys.spendingPrivateKey, keys.viewingPrivateKey, keys.mlkemDecapsKey, blob);
        if (!addr) continue;
        addStealthUTXO(username, {
          stealthAddress: addr,
          ephemeralPubkey: blob.ephemeralPubkey,
          kemCiphertext: blob.kemCiphertext,
          blockNumber: 0,
          createdAt: Date.now(),
          viewTag: blob.viewTag,
        });
        added++;
      }

      if (added === 0) {
        setImportMsg("Not your payment — this ticket doesn't decrypt to this wallet.");
        return;
      }
      setImportText("");
      refresh();
      setImportMsg(`Imported ${added} payment${added > 1 ? "s" : ""} — its balance will show shortly.`);
    } catch (e) {
      console.error("[ReceivePrivate] import error:", e);
      setImportMsg("Import failed. Check the ticket and try again.");
    } finally {
      setImportBusy(false);
    }
  };

  const hiddenCount = receives.filter((u) => u.hidden).length;
  const visible = receives.filter((u) => (showHidden ? true : !u.hidden));

  return (
    <Box>
      <Stack spacing={1.7} direction="column" sx={{ width: "100%", maxWidth: 400, mx: "auto" }}>
        <Typography variant="body2" sx={{ color: "text.secondary", textAlign: "center", lineHeight: 1.6 }}>
          Create a one-time address to receive a private payment from <b>any</b> wallet
          (MetaMask, an exchange…). Share only the address — the payment stays unlinkable to you.
        </Typography>

        {/* Optional label */}
        <Box>
          <Typography variant="body2" sx={{ mb: 1, color: "text.secondary" }}>
            Label (optional)
          </Typography>
          <input
            type="text"
            value={memo}
            onChange={(e) => setMemo(e.target.value)}
            placeholder="_ e.g. rent from Bob"
            style={inputStyle}
            onFocus={(e) => (e.target.style.opacity = "1")}
            onBlur={(e) => (e.target.style.opacity = "0.7")}
          />
        </Box>

        <Button
          variant="outlined"
          color="primary"
          onClick={handleCreate}
          disabled={busy}
          sx={{ py: 1.5, fontSize: "1rem", borderRadius: 2 }}
        >
          {busy ? "Creating…" : "Create receive address"}
        </Button>

        {/* Detail card — freshly created OR re-checked from the list */}
        {detail && (
          <Box sx={{ border: "1px solid", borderColor: "primary.main", borderRadius: "2px", p: 1.5, textAlign: "left" }}>
            <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "center", mb: 0.75 }}>
              <Typography variant="body2" sx={{ fontSize: "0.62rem", opacity: 0.6, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                Share this address
              </Typography>
              <Button size="small" variant="text" onClick={() => setDetail(null)} sx={{ minWidth: 0, px: 1, fontSize: "0.68rem" }}>
                close
              </Button>
            </Box>
            <Typography sx={{ fontFamily: "var(--font-geist-mono), monospace", fontSize: "0.8rem", wordBreak: "break-all", mb: 1 }}>
              {detail.address}
            </Typography>
            <Stack direction="row" spacing={1}>
              <Button size="small" variant="text" onClick={() => copy("addr", detail.address)} sx={{ minWidth: 0, px: 1, fontSize: "0.7rem" }}>
                {copied === "addr" ? "copied" : "copy address"}
              </Button>
              {detail.ticket && (
                <Button size="small" variant="text" onClick={() => setShowTicket((s) => !s)} sx={{ minWidth: 0, px: 1, fontSize: "0.7rem" }}>
                  {showTicket ? "hide backup" : "backup ticket"}
                </Button>
              )}
            </Stack>
            {detail.ticket && (
              <Collapse in={showTicket}>
                <Typography variant="body2" sx={{ fontSize: "0.62rem", opacity: 0.7, mt: 1, lineHeight: 1.5 }}>
                  Keep this ticket if you might use another device — it&apos;s the only way to recover
                  this payment off this one. Anyone who sees it learns the address but <b>cannot spend</b>.
                </Typography>
                <Typography sx={{ fontFamily: "var(--font-geist-mono), monospace", fontSize: "0.6rem", wordBreak: "break-all", mt: 0.75, opacity: 0.75 }}>
                  {detail.ticket}
                </Typography>
                <Button size="small" variant="text" onClick={() => copy("ticket", detail.ticket!)} sx={{ minWidth: 0, px: 1, fontSize: "0.7rem", mt: 0.5 }}>
                  {copied === "ticket" ? "copied" : "copy ticket"}
                </Button>
              </Collapse>
            )}
          </Box>
        )}

        {/* Previously created receive addresses */}
        {visible.length > 0 && (
          <Box sx={{ mt: 1 }}>
            <Typography variant="body2" sx={{ fontSize: "0.62rem", opacity: 0.6, letterSpacing: "0.1em", textTransform: "uppercase", mb: 0.75 }}>
              Your receive addresses
            </Typography>
            <Stack spacing={0.75} sx={{ maxHeight: 240, overflowY: "auto", pr: 0.5 }}>
              {visible.map((u) => (
                <Box
                  key={u.stealthAddress}
                  sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", border: "1px solid", borderColor: "divider", borderRadius: "2px", px: 1.25, py: 0.75, opacity: u.hidden ? 0.5 : 1 }}
                >
                  <Box sx={{ minWidth: 0 }}>
                    {u.memo && <Typography sx={{ fontSize: "0.72rem" }}>{u.memo}</Typography>}
                    <Typography sx={{ fontFamily: "var(--font-geist-mono), monospace", fontSize: "0.66rem", opacity: 0.7 }}>
                      {short(u.stealthAddress)}{u.hidden ? " · hidden" : ""}
                    </Typography>
                    <Typography sx={{ fontSize: "0.6rem", opacity: 0.55, color: u.receivedAt ? "primary.main" : undefined }}>
                      {u.receivedAt ? "received" : "awaiting payment"}
                    </Typography>
                  </Box>
                  <Box sx={{ display: "flex", flexShrink: 0 }}>
                    <Button size="small" variant="text" onClick={() => openDetail({ address: u.stealthAddress, ticket: buildStealthTicket(u) })} sx={{ minWidth: 0, px: 1, fontSize: "0.68rem" }}>
                      view
                    </Button>
                    <Button size="small" variant="text" color="secondary" onClick={() => toggleHidden(u)} sx={{ minWidth: 0, px: 1, fontSize: "0.68rem" }}>
                      {u.hidden ? "unhide" : "hide"}
                    </Button>
                  </Box>
                </Box>
              ))}
            </Stack>
          </Box>
        )}

        {hiddenCount > 0 && (
          <Button variant="text" color="secondary" onClick={() => setShowHidden((s) => !s)} sx={{ fontSize: "0.7rem", py: 0.5 }}>
            {showHidden ? "Show less" : `Show more (${hiddenCount})`}
          </Button>
        )}

        {/* Secondary action: import a payment from a ticket (backup, another device, third party) */}
        <Box sx={{ borderTop: "1px solid", borderColor: "divider", pt: 1.5, mt: 1 }}>
          <Button
            variant="text"
            color="secondary"
            onClick={() => { setImportOpen((o) => !o); setImportMsg(null); }}
            sx={{ fontSize: "0.72rem", px: 0 }}
          >
            {importOpen ? "Cancel import" : "Import a payment (paste a ticket)"}
          </Button>
          <Collapse in={importOpen}>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              placeholder="paste a ticket (0x…)"
              style={{ ...inputStyle, minHeight: 70, resize: "vertical", fontSize: "0.7rem" }}
              onFocus={(e) => (e.target.style.opacity = "1")}
              onBlur={(e) => (e.target.style.opacity = "0.7")}
            />
            <Button
              variant="outlined"
              color="primary"
              onClick={handleImport}
              disabled={importBusy || !importText.trim()}
              sx={{ mt: 1, py: 1, fontSize: "0.85rem", borderRadius: 2 }}
              fullWidth
            >
              {importBusy ? "Importing…" : "Import"}
            </Button>
            {importMsg && (
              <Typography variant="body2" sx={{ fontSize: "0.66rem", opacity: 0.8, mt: 1, textAlign: "center" }}>
                {importMsg}
              </Typography>
            )}
          </Collapse>
        </Box>

        <Button variant="text" color="secondary" onClick={() => onBack()} sx={{ py: 1, fontSize: "0.9rem" }}>
          Back
        </Button>
      </Stack>
    </Box>
  );
};
