"use client";
import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { Box, CircularProgress } from "@mui/material";

type Props = {
  value: string;
  /** Side length of the white tile in px (the QR fills it, minus quiet-zone padding). */
  size?: number;
};

/**
 * Renders `value` as a scannable QR code. Always dark-on-white inside a white
 * tile — independent of the active world theme — so it scans reliably even in
 * the dark (kage) world. SVG output keeps it crisp at any size.
 */
export function QrCode({ value, size = 220 }: Props) {
  const [svg, setSvg] = useState<string>("");

  useEffect(() => {
    let active = true;
    QRCode.toString(value, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 1,
      color: { dark: "#0C0D0F", light: "#FFFFFF" },
    })
      .then((s) => { if (active) setSvg(s); })
      .catch(() => { if (active) setSvg(""); });
    return () => { active = false; };
  }, [value]);

  const tile = {
    width: size,
    height: size,
    bgcolor: "#FFFFFF",
    borderRadius: 2,
    p: 1.25,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    boxShadow: "0 4px 20px rgba(0,0,0,0.12)",
  } as const;

  if (!svg) {
    return (
      <Box sx={tile}>
        <CircularProgress size={28} sx={{ color: "#0C0D0F" }} />
      </Box>
    );
  }

  return (
    <Box
      sx={{ ...tile, "& svg": { width: "100%", height: "100%", display: "block" } }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
