import { useSyncExternalStore } from "react";

// Tiny global store for "a stealth scan is running right now". The login-time
// scan (runStealthScan in page.tsx) is fire-and-forget/background, so this lets
// any view show a "scanning…" hint without prop-drilling through page.tsx — and
// without touching PrivateView. Counter-based so overlapping scans (login +
// manual refresh) don't clear each other early.

let active = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export const beginScan = (): void => { active++; emit(); };
export const endScan = (): void => { active = Math.max(0, active - 1); emit(); };

export const useScanning = (): boolean =>
  useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => active > 0,
    () => false, // SSR snapshot — never scanning on the server
  );
