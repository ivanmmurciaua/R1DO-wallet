import { useSyncExternalStore } from "react";

// Tiny global store for "a stealth scan is running right now". The login-time
// scan (runStealthScan in page.tsx) is fire-and-forget/background, so this lets
// any view show a "scanning…" hint without prop-drilling through page.tsx — and
// without touching PrivateView. Counter-based so overlapping scans (login +
// manual refresh) don't clear each other early.

let active = 0;
// Determinate progress for the running scan (windows done / total). Null when we
// don't know a total yet (or no scan). A single object ref, replaced on each
// update so useSyncExternalStore's getSnapshot stays referentially stable.
let progress: { done: number; total: number } | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb); };

export const beginScan = (): void => { active++; emit(); };
export const endScan = (): void => {
  active = Math.max(0, active - 1);
  if (active === 0) progress = null; // clear once the last scan finishes
  emit();
};

/** Report scan progress (windows done / total). Total known upfront from the block
    range, so the UI can show a determinate bar instead of a bare spinner. */
export const setScanProgress = (done: number, total: number): void => {
  progress = { done, total };
  emit();
};

/** Imperative "is a scan running?" — for GUARDS, outside React (the hook below is
    for rendering). The calendar deep-scan refuses to start while any scan is in
    flight: two scans would fight over setScanProgress and double the RPC fan-out
    the throttling is calibrated for. Disabling the button is the UI half of that;
    this is the half that survives a double-click. */
export const isScanning = (): boolean => active > 0;

export const useScanning = (): boolean =>
  useSyncExternalStore(
    subscribe,
    () => active > 0,
    () => false, // SSR snapshot — never scanning on the server
  );

export const useScanProgress = (): { done: number; total: number } | null =>
  useSyncExternalStore(subscribe, () => progress, () => null);
