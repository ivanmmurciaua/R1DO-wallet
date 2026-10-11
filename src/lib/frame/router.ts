/*
  router.ts — the single seam between a network id and the frame-native rail.

  This is the ONLY place that maps an id string onto a frame backend. It knows
  nothing about the base 4337 networks (Sepolia, Arbitrum): those are served by
  the existing wallet code and must stay untouched. A non-frame id simply yields
  null here, so the caller falls back to its normal path.

  When the rail is wired into the app (a later phase), the base code gains exactly
  ONE line that consults this router before its usual backend selection. Removing
  the rail is then: delete this folder and that one seam line.
*/

import { frameNetworkById } from "./network";
import { createFrameReadBackend, type FrameReadBackend } from "./backend";

/** True when `networkId` names a frame-native network served by this rail. */
export function isFrameNetwork(networkId: string): boolean {
  return frameNetworkById(networkId) !== undefined;
}

/**
 * Return a read-only backend for a frame-native `networkId` (e.g. "hegota"),
 * or null when the id is not frame-native. Callers treat null as "not mine" and
 * fall through to their existing (4337) backend selection.
 */
export function frameBackendFor(networkId: string): FrameReadBackend | null {
  const network = frameNetworkById(networkId);
  if (!network) return null;
  return createFrameReadBackend(network);
}
