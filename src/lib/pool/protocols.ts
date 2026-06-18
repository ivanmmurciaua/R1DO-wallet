/*
  protocols.ts — privacy-pool protocol registry (UI-facing).

  The wallet's private side is NOT tied to Railgun: it's one of several
  possible privacy protocols behind the future PoolAdapter. This registry
  keeps that promise at the UI level so no component hardcodes "RAILGUN".

  For now there is a SINGLE protocol (Railgun) and NO switcher — the active
  protocol is always the default. When a second protocol lands, add it to
  PROTOCOLS and surface a switcher; nothing in the UI strings changes.

  Standalone on purpose: NO SDK imports here, so importing this never pulls
  the Railgun engine into the login bundle.
*/

export type PoolProtocolId = "railgun";

export type PoolProtocol = {
  id: PoolProtocolId;
  /** Display name shown to the user. RAILGUN is always uppercase. */
  name: string;
};

export const PROTOCOLS: readonly PoolProtocol[] = [
  { id: "railgun", name: "RAILGUN" },
] as const;

/**
 * The protocol currently in use. No switcher yet → always the default
 * (first in the list). When the switcher exists this reads the user's choice.
 */
export function activeProtocol(): PoolProtocol {
  return PROTOCOLS[0];
}

/** Convenience: the active protocol's display name (e.g. "Railgun"). */
export function protocolName(): string {
  return activeProtocol().name;
}
