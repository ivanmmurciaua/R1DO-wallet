"use client";
import { useEffect, useState } from "react";

// Matrix-style scramble (ported from ~/cv): katakana + hex + symbols, fixed
// length so width stays stable. Re-randomizes every 90ms while mounted — used
// to mask hidden balances/amounts. Mounting = animating; honors
// prefers-reduced-motion (renders a single static scramble, no timer).
const GLITCH_CHARS = "ｱｲｳｴｵｶｷｸｹｺｻｼ0123456789ABCDEFabcdef$%&*+-/\\|<>=?";

const randomGlitch = (n: number): string => {
  let s = "";
  for (let i = 0; i < n; i++) s += GLITCH_CHARS[(Math.random() * GLITCH_CHARS.length) | 0];
  return s;
};

export function GlitchText({ length = 6 }: { length?: number }) {
  const [text, setText] = useState(() => randomGlitch(length));
  useEffect(() => {
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
    if (reduce) {
      setText(randomGlitch(length));
      return;
    }
    const id = setInterval(() => setText(randomGlitch(length)), 90);
    return () => clearInterval(id);
  }, [length]);
  return <>{text}</>;
}
