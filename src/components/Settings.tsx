"use client";
import { useState } from "react";
import SettingsIcon from "@mui/icons-material/Settings";
import { IconButton, Paper } from "@mui/material";

export function Settings() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <IconButton
        onClick={() => setOpen(true)}
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
              <p style={{ fontSize: "0.8rem" }}>
                Feel free to contact me if you have any feedback:
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

            <p style={{ fontSize: "0.78rem" }}>
              Thx for testing it ❤️
            </p>

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
