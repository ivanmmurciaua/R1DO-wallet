"use client";

import { useEffect, useState } from "react";
import Box from "@mui/material/Box";

// Beta notice + liability disclaimer. Fixed top overlay that DELIBERATELY covers
// the fixed controls (logout / world switch): without tapping the acknowledgement
// you can't operate. Dismissible ONCE via "I understand" — persisted in
// localStorage so it won't nag again, while keeping a record that the user
// ACCEPTED it (not just saw it). It intentionally reserves no space in the body.
const LOCAL_BETA_ACK = "r1do/beta-ack";

export function BetaBanner() {
  // Starts visible to match the SSR (no hydration flash); if there's already an
  // acknowledgement, the effect hides it.
  const [acknowledged, setAcknowledged] = useState(false);

  useEffect(() => {
    if (typeof localStorage !== "undefined" && localStorage.getItem(LOCAL_BETA_ACK)) {
      setAcknowledged(true);
    }
  }, []);

  if (acknowledged) return null;

  const dismiss = () => {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(LOCAL_BETA_ACK, "1");
    }
    setAcknowledged(true);
  };

  return (
    <Box
      role="alert"
      sx={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: 2000,
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        justifyContent: "center",
        columnGap: 1.5,
        rowGap: 0.5,
        px: 1.5,
        py: 0.75,
        backgroundColor: "#7A1F1F",
        color: "#fff",
        fontFamily: "var(--font-geist-mono), monospace",
        fontSize: { xs: "0.62rem", sm: "0.7rem" },
        letterSpacing: "0.03em",
        textAlign: "center",
        lineHeight: 1.25,
        overflowWrap: "anywhere",
      }}
    >
      <Box component="span" sx={{ userSelect: "none" }}>
        BETA — use at your own risk. Don&apos;t deposit funds you can&apos;t
        afford to lose. No liability for misuse.
      </Box>
      <Box
        component="button"
        type="button"
        onClick={dismiss}
        sx={{
          flexShrink: 0,
          background: "transparent",
          border: "1px solid rgba(255,255,255,0.6)",
          borderRadius: "2px",
          color: "#fff",
          fontFamily: "inherit",
          fontSize: "inherit",
          letterSpacing: "inherit",
          padding: "2px 8px",
          cursor: "pointer",
          whiteSpace: "nowrap",
          "&:hover": { background: "rgba(255,255,255,0.12)" },
        }}
      >
        I understand
      </Box>
    </Box>
  );
}
