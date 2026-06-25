"use client";

import { useEffect, useState } from "react";
import Box from "@mui/material/Box";

// Aviso de beta + descargo de responsabilidad. Overlay fijo arriba que TAPA a
// propósito los controles fijos (logout / switch de mundo): sin pulsar el acuse
// no puedes operar. Cerrable UNA vez con "I understand" — persistido en
// localStorage para no volver a molestar, dejando constancia de que el usuario
// lo ACEPTÓ (no solo lo vio). No reserva espacio en el body adrede.
const LOCAL_BETA_ACK = "r1do/beta-ack";

export function BetaBanner() {
  // Arranca visible para coincidir con el SSR (sin parpadeo de hidratación);
  // si ya hay acuse, el effect lo oculta.
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
