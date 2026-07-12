import React, { useState } from "react";
import { Box, Button, Stack, Typography, Collapse, IconButton } from "@mui/material";
import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CheckIcon from "@mui/icons-material/Check";
import { QrCode } from "./QrCode";
import { generateStealthPayment, derivePQKeysFromPRF, buildStealthTicket, extractStealthBlobs, checkPQPayment, type StealthUTXO } from "@/lib/stealth";
import { getMetaAddress, saveMetaAddress, addStealthUTXO, getStealthUTXOs, patchStealthUTXO, receivableChainNames } from "@/lib/localstorage";
import { nativeAsset, activeTokens } from "@/lib/assets";
import { formatList } from "@/lib/common";
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

// Pre-minted receive addresses are the StealthUTXOs we created ourselves (Δ
// off-chain Courier flow): tagged with `createdAt`, newest first.
const loadReceives = (username: string): StealthUTXO[] =>
  getStealthUTXOs(username)
    .filter((u) => typeof u.createdAt === "number")
    .sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

export const ReceivePrivate: React.FC<ReceivePrivateProps> = ({ username, onBack }) => {
  const [busy, setBusy] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [showTicket, setShowTicket] = useState(false);
  // Label is decoupled from creation: the address is saved instantly (the
  // crypto material is what matters), and you name/rename/clear it afterwards.
  const [editingLabel, setEditingLabel] = useState(false);
  const [labelDraft, setLabelDraft] = useState("");
  const [copied, setCopied] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);
  const [receives, setReceives] = useState<StealthUTXO[]>(() => loadReceives(username));
  const [paymentsOpen, setPaymentsOpen] = useState(false);
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
    setEditingLabel(false);
    setDetail(d);
  };

  // The memo for the address currently previewed (looked up live so it reflects
  // renames without threading memo through the Detail type).
  const detailMemo = detail ? receives.find((u) => u.stealthAddress === detail.address)?.memo : undefined;

  const startEditLabel = () => {
    setLabelDraft(detailMemo ?? "");
    setEditingLabel(true);
  };

  const saveLabel = () => {
    if (!detail) return;
    patchStealthUTXO(username, detail.address, { memo: labelDraft.trim() || undefined });
    setEditingLabel(false);
    refresh();
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
        viewTag: pay.viewTag,
      });

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
  const activeCount = receives.filter((u) => !u.hidden).length;
  // What this address can receive, and WHERE it's safe to receive it: assets from
  // the active network's registry; networks = those with a scan cursor (payments
  // there won't be missed) — a cursor-less chain is deliberately left out.
  const assetLine = [nativeAsset().symbol, ...activeTokens().map((t) => t.symbol)].join(" · ");
  const networkLine = formatList(receivableChainNames(username));

  return (
    <Box sx={{ pb: 4 }}>
      {/* Header — mirrors public Receive */}
      <Box sx={{ display: "flex", alignItems: "center", maxWidth: 400, mx: "auto", mb: 1 }}>
        <IconButton onClick={() => onBack()} size="small" aria-label="Back">
          <ArrowBackIcon fontSize="small" />
        </IconButton>
        <Typography sx={{ flex: 1, textAlign: "center", fontWeight: 600, letterSpacing: "0.02em", mr: 4 }}>
          Receive
        </Typography>
      </Box>

      <Stack spacing={2} direction="column" sx={{ width: "100%", maxWidth: 400, mx: "auto" }}>
        {/* Actions — stacked, explicit. Generate never fires automatically:
            opening Receive must not burn a fresh stealth address, only a tap. */}
        <Stack spacing={1} sx={{ mt: 6 }}>
          <Button
            fullWidth
            variant="outlined"
            color="primary"
            onClick={handleCreate}
            disabled={busy}
            sx={{ py: 1.3, fontSize: "0.9rem", borderRadius: 2 }}
          >
            {busy ? "Generating…" : "Generate"}
          </Button>
          <Button
            fullWidth
            variant={paymentsOpen ? "contained" : "outlined"}
            color="primary"
            onClick={() => { setPaymentsOpen((o) => !o); setImportOpen(false); }}
            sx={{ py: 1.3, fontSize: "0.9rem", borderRadius: 2 }}
          >
            Payments{activeCount > 0 ? ` (${activeCount})` : ""}
          </Button>
          <Button
            fullWidth
            variant={importOpen ? "contained" : "outlined"}
            color="primary"
            onClick={() => { setImportOpen((o) => !o); setPaymentsOpen(false); setImportMsg(null); }}
            sx={{ py: 1.3, fontSize: "0.9rem", borderRadius: 2 }}
          >
            Import
          </Button>
        </Stack>

        <Stack spacing={0.75} sx={{ px: 1 }}>
          <Typography variant="body2" sx={{ color: "text.secondary", textAlign: "center", lineHeight: 1.6, fontSize: "0.7rem", opacity: 0.7 }}>
            A one-time address. Share it with the sender — they send to it, and the
            payment lands here privately.
          </Typography>
          <Typography sx={{ textAlign: "center", fontSize: "0.66rem", opacity: 0.6, letterSpacing: "0.02em", lineHeight: 1.5 }}>
            Receives {assetLine}<br />on {networkLine}
          </Typography>
        </Stack>

        {/* Detail — QR + address (freshly created OR opened from the list) */}
        {detail && (
          <Stack spacing={2} alignItems="center" sx={{ mt: 0.5 }}>
            <QrCode value={detail.address} size={232} />
            <Typography variant="body2" sx={{ color: "text.secondary", textAlign: "center", lineHeight: 1.6, maxWidth: 300 }}>
              Scan to send, or copy the address below.
            </Typography>

            {/* Address card — whole row copies */}
            <Box
              onClick={() => copy("addr", detail.address)}
              title="Tap to copy this address"
              sx={{
                width: "100%",
                border: "1px solid",
                borderColor: copied === "addr" ? "success.main" : "primary.main",
                borderRadius: 2,
                px: 1.75,
                py: 1.5,
                cursor: "pointer",
                transition: "border-color 0.15s",
                "&:hover": { borderColor: "primary.main" },
              }}
            >
              <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 1, mb: 0.75 }}>
                <Typography sx={{ fontSize: "0.62rem", opacity: 0.6, letterSpacing: "0.1em", textTransform: "uppercase" }}>
                  Share this address
                </Typography>
                <Box sx={{ display: "flex", alignItems: "center", gap: 0.5, color: copied === "addr" ? "success.main" : "primary.main" }}>
                  {copied === "addr" ? <CheckIcon sx={{ fontSize: "0.95rem" }} /> : <ContentCopyIcon sx={{ fontSize: "0.95rem" }} />}
                  <Typography sx={{ fontSize: "0.68rem", letterSpacing: "0.04em" }}>
                    {copied === "addr" ? "copied" : "copy"}
                  </Typography>
                </Box>
              </Box>
              <Typography sx={{ fontFamily: "var(--font-geist-mono), monospace", fontSize: "0.82rem", wordBreak: "break-all", lineHeight: 1.5 }}>
                {detail.address}
              </Typography>
            </Box>

            {/* Label — decoupled from creation: set / rename / clear anytime */}
            <Box sx={{ width: "100%", textAlign: "center" }}>
              {editingLabel ? (
                <Stack direction="row" spacing={1} alignItems="center" sx={{ width: "100%" }}>
                  <input
                    type="text"
                    value={labelDraft}
                    onChange={(e) => setLabelDraft(e.target.value)}
                    placeholder="_ label (optional) — e.g. rent from Bob"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter") saveLabel();
                      if (e.key === "Escape") setEditingLabel(false);
                    }}
                    style={{ ...inputStyle, fontSize: "0.78rem", padding: "8px 12px" }}
                    onFocus={(e) => (e.target.style.opacity = "1")}
                  />
                  <Button size="small" variant="text" onClick={saveLabel} sx={{ minWidth: 0, fontSize: "0.7rem" }}>
                    save
                  </Button>
                </Stack>
              ) : detailMemo ? (
                <Stack direction="row" spacing={1} alignItems="center" justifyContent="center">
                  <Typography sx={{ fontSize: "0.8rem" }}>{detailMemo}</Typography>
                  <Button size="small" variant="text" color="secondary" onClick={startEditLabel} sx={{ minWidth: 0, fontSize: "0.66rem" }}>
                    rename
                  </Button>
                </Stack>
              ) : (
                <Button size="small" variant="text" color="secondary" onClick={startEditLabel} sx={{ minWidth: 0, fontSize: "0.7rem" }}>
                  + add label
                </Button>
              )}
            </Box>

            {/* Backup ticket (off-chain Courier) — copy only, never in the QR.
                Toggle sits beside "close preview"; the ticket itself expands below. */}
            <Stack direction="row" spacing={2} justifyContent="center" sx={{ width: "100%" }}>
              {detail.ticket && (
                <Button size="small" variant="text" onClick={() => setShowTicket((s) => !s)} sx={{ minWidth: 0, fontSize: "0.7rem" }}>
                  {showTicket ? "hide backup ticket" : "backup ticket"}
                </Button>
              )}
              <Button size="small" variant="text" color="secondary" onClick={() => setDetail(null)} sx={{ minWidth: 0, fontSize: "0.7rem" }}>
                close preview
              </Button>
            </Stack>

            {detail.ticket && (
              <Collapse in={showTicket} sx={{ width: "100%" }}>
                <Typography variant="body2" sx={{ fontSize: "0.62rem", opacity: 0.7, lineHeight: 1.5 }}>
                  Keep this if you might use another device — it&apos;s the only way to recover this
                  payment off this one. Anyone who sees it learns the address but <b>cannot spend</b>.
                </Typography>
                <Typography sx={{ fontFamily: "var(--font-geist-mono), monospace", fontSize: "0.6rem", wordBreak: "break-all", mt: 0.75, opacity: 0.75 }}>
                  {detail.ticket}
                </Typography>
                <Button size="small" variant="text" onClick={() => copy("ticket", detail.ticket!)} sx={{ minWidth: 0, px: 0, fontSize: "0.7rem", mt: 0.5 }}>
                  {copied === "ticket" ? "copied" : "copy ticket"}
                </Button>
              </Collapse>
            )}
          </Stack>
        )}

        {/* Payments list */}
        <Collapse in={paymentsOpen}>
          {visible.length > 0 ? (
            <Stack spacing={0.75} sx={{ maxHeight: 280, overflowY: "auto", pr: 0.5 }}>
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
          ) : (
            <Typography variant="body2" sx={{ textAlign: "center", opacity: 0.6, fontSize: "0.72rem", py: 1.5 }}>
              No receive addresses yet.
            </Typography>
          )}
          {hiddenCount > 0 && (
            <Button variant="text" color="secondary" onClick={() => setShowHidden((s) => !s)} sx={{ fontSize: "0.7rem", py: 0.5 }}>
              {showHidden ? "Show less" : `Show more (${hiddenCount})`}
            </Button>
          )}
        </Collapse>

        {/* Import a payment from a ticket (backup, another device, third party) */}
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
      </Stack>
    </Box>
  );
};
