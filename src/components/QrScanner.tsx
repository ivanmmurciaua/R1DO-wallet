"use client";
import { useEffect, useRef, useState } from "react";
import { Box, Button, Typography, CircularProgress } from "@mui/material";
import jsQR from "jsqr";

type Props = {
  onResult: (text: string) => void;
  onClose: () => void;
};

/**
 * Full-screen camera QR scanner. Opens the rear camera (getUserMedia), draws
 * frames to an offscreen canvas and runs jsQR each frame; on the first decode it
 * fires onResult and the parent unmounts us. Camera is requested only while
 * mounted and every track is stopped on cleanup. Secure-context only (https /
 * localhost) — getUserMedia is unavailable otherwise.
 */
export function QrScanner({ onResult, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    const tick = () => {
      const video = videoRef.current;
      if (
        !cancelled &&
        video &&
        video.readyState === video.HAVE_ENOUGH_DATA &&
        ctx
      ) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = jsQR(img.data, img.width, img.height, {
          inversionAttempts: "dontInvert",
        });
        if (code?.data) {
          onResult(code.data);
          return; // stop the loop — parent unmounts us on result
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    (async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          setError("Camera isn't available on this device or browser.");
          return;
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        const video = videoRef.current;
        if (video) {
          video.srcObject = stream;
          await video.play().catch(() => {});
          setReady(true);
          rafRef.current = requestAnimationFrame(tick);
        }
      } catch (e) {
        console.warn("[QrScanner] camera error:", e);
        setError("Couldn't access the camera. Check permission and try again.");
      }
    })();

    return () => {
      cancelled = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Box
      sx={{
        position: "fixed",
        inset: 0,
        zIndex: 1400,
        bgcolor: "rgba(0,0,0,0.92)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        p: 2,
      }}
    >
      <Typography
        sx={{
          color: "#fff",
          mb: 2,
          fontSize: "0.8rem",
          letterSpacing: "0.08em",
          textTransform: "uppercase",
          opacity: 0.85,
        }}
      >
        Scan a QR address
      </Typography>

      {error ? (
        <Typography
          sx={{
            color: "#fff",
            maxWidth: 300,
            textAlign: "center",
            fontSize: "0.8rem",
            lineHeight: 1.6,
          }}
        >
          {error}
        </Typography>
      ) : (
        <Box
          sx={{
            position: "relative",
            width: "min(78vw, 320px)",
            aspectRatio: "1 / 1",
            borderRadius: 2,
            overflow: "hidden",
            border: "1px solid rgba(255,255,255,0.25)",
            bgcolor: "#000",
          }}
        >
          <video
            ref={videoRef}
            muted
            playsInline
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
          {!ready && (
            <Box
              sx={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <CircularProgress size={28} sx={{ color: "#fff" }} />
            </Box>
          )}
          <Box
            sx={{
              position: "absolute",
              inset: "14%",
              border: "2px solid rgba(255,255,255,0.7)",
              borderRadius: 1,
              pointerEvents: "none",
            }}
          />
        </Box>
      )}

      <Button
        onClick={onClose}
        variant="outlined"
        sx={{
          mt: 3,
          color: "#fff",
          borderColor: "rgba(255,255,255,0.4)",
          "&:hover": { borderColor: "#fff" },
        }}
      >
        Cancel
      </Button>
    </Box>
  );
}
