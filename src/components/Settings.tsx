"use client";
import { useState } from "react";
import SettingsIcon from "@mui/icons-material/Settings";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import LockOutlinedIcon from "@mui/icons-material/LockOutlined";
import { IconButton, Paper, TextField, MenuItem, Tooltip } from "@mui/material";
import {
  getSymbol,
  setSymbolConfig,
  getDecimals,
  setDecimalsConfig,
  getUtxoCleanup,
  DEFAULT_SYMBOL,
  DEFAULT_DECIMALS,
} from "@/lib/localstorage";
import { NETWORKS, activeNetwork } from "@/lib/networks";

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

export function Settings({ privacy = false }: { privacy?: boolean }) {
  const [open, setOpen] = useState(false);
  const [symbol, setSymbol] = useState(DEFAULT_SYMBOL);
  const [decimals, setDecimals] = useState(DEFAULT_DECIMALS);
  // Both controls below are LOCKED for now (single network, tombstone-only). The
  // UI is wired so flipping `disabled` off later is all it takes to ship them.
  const [cleanup, setCleanup] = useState<string>("tombstone");
  const [network, setNetwork] = useState<string>(activeNetwork().id);

  const handleOpen = () => {
    setSymbol(getSymbol());
    setDecimals(getDecimals());
    setCleanup(getUtxoCleanup());
    setNetwork(activeNetwork().id);
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
          bottom: 16,
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
          onClick={() => setOpen(false)}
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

            <div>
              <p style={{ fontSize: "0.8rem", marginBottom: "10px", display: "flex", alignItems: "center", gap: "6px" }}>
                Network
                <LockOutlinedIcon sx={{ fontSize: "0.8rem", opacity: 0.5 }} />
              </p>
              <TextField
                select
                size="small"
                value={network}
                disabled
                onChange={(e) => setNetwork(e.target.value)}
                sx={{ ...inputSx, width: "100%" }}
              >
                {NETWORKS.map((n) => (
                  <MenuItem key={n.id} value={n.id}>{n.chain.name}</MenuItem>
                ))}
              </TextField>
            </div>

            {privacy && (
            <div>
              <p style={{ fontSize: "0.8rem", marginBottom: "10px", display: "flex", alignItems: "center", gap: "6px" }}>
                Spent addresses
                <LockOutlinedIcon sx={{ fontSize: "0.8rem", opacity: 0.5 }} />
                <Tooltip
                  arrow
                  title={
                    <span style={{ fontSize: "0.7rem", lineHeight: 1.6 }}>
                      One-time addresses never refund, so once drained they stop
                      being queried. <b>Keep</b> retains the spent record (history).{" "}
                      <b>Purge</b> also deletes the spent record to shrink local
                      storage — except notes that can only be spent from this
                      device, which are always kept (deleting them would lose the
                      funds for good).
                    </span>
                  }
                >
                  <InfoOutlinedIcon sx={{ fontSize: "0.8rem", opacity: 0.6, cursor: "help" }} />
                </Tooltip>
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

            <button
              onClick={() => setOpen(false)}
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
