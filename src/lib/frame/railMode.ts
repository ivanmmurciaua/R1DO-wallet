/*
  railMode.ts — is the frame-native rail the ACTIVE network right now?

  The wallet stores the selected network as a single localStorage id and reloads the page
  on switch (see networks.ts ACTIVE_NETWORK_KEY). A frame-native network (hegota) lives in
  the SEPARATE FrameNetwork registry, not in the base 4337 NETWORKS list, so the base getters
  (activeNetwork/activeChain/...) would fall back to the default 4337 chain for a frame id.

  To keep the two paths cleanly separated, EVERY frame-vs-4337 branch reads frame mode from
  HERE (the raw persisted id, matched against the frame registry) and short-circuits BEFORE
  any base 4337 getter runs. When this returns a FrameNetwork the app renders the rail; when
  it returns null the app is on a 4337 network and behaves exactly as before.

  We import only the KEY constant from the base registry (read-only, stays in sync) and the
  frame registry; nothing here couples the base to the rail, so deleting src/lib/frame plus
  the single page-level branch removes the rail entirely.
*/
import { ACTIVE_NETWORK_KEY } from "@/lib/networks";
import { frameNetworkById, type FrameNetwork } from "./network";

/** The active FrameNetwork if a frame-native id is currently selected, else null. */
export function activeFrameNetwork(): FrameNetwork | null {
  let id: string | null = null;
  try {
    id = typeof localStorage !== "undefined" ? localStorage.getItem(ACTIVE_NETWORK_KEY) : null;
  } catch {
    return null; // storage unavailable (SSR / blocked) -> treat as not-rail (4337 default)
  }
  return id ? (frameNetworkById(id) ?? null) : null;
}

/** True when the frame-native rail is the active network (render the rail, skip the 4337 UI). */
export function isRailActive(): boolean {
  return activeFrameNetwork() !== null;
}
