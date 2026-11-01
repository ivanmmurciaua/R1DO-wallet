// Main-thread client for the Hegota rail PQ worker (Comlink), same lazy pattern as
// pool/railgun.ts. The worker is created on first use and reused. Type-only imports from the
// worker, so none of the worker code (signer wasm included) enters the main bundle.
//
// Scheme selection: the user's post-quantum scheme ("leanSphincs-s" default, or "ML-DSA-44") is
// stored per device user at localStorage `r1do/frame/scheme/<user>` (user = LOCAL_LAST_USER, as the
// Frame components read it). Every worker call takes the scheme explicitly; the functions here fill
// it in from storage when the caller does not pass one, so page.tsx's deriveAccount(prf) and
// stealthMeta(prf) keep their signatures. A stealth spend is the exception: it routes by the
// TICKET's scheme, never the current selection, so switching never strands a ticket.
import * as Comlink from "comlink";
import { LOCAL_LAST_USER } from "@/app/constants";
import type {
  PqWorkerApi, PqScheme, PqAccount, PqAccountStatus, PqSpendResult, FrameTxDesc, FrameDesc,
  PqStealthMeta, PqStealthPayment, PqRailStatus, PqFallbackReason, PqSendEvent, PqSendEventCb,
} from "./pq.worker";

type Addr = `0x${string}`;

let worker: Worker | null = null;
let api: Comlink.Remote<PqWorkerApi> | null = null;

function getApi(): Comlink.Remote<PqWorkerApi> {
  if (!api) {
    worker = new Worker(new URL("./pq.worker.ts", import.meta.url), { type: "module" });
    api = Comlink.wrap<PqWorkerApi>(worker);
  }
  return api;
}

/** Drop the worker (and any key material still in its memory). The next call starts a new one. */
export function terminate(): void {
  worker?.terminate();
  worker = null;
  api = null;
}

// ---------------------------------------------------------------------------------------------
// Scheme selection (main thread only; every storage access is guarded)
// ---------------------------------------------------------------------------------------------

export const PQ_SCHEMES: readonly PqScheme[] = ["leanSphincs-s", "ML-DSA-44"];
export const DEFAULT_SCHEME: PqScheme = "leanSphincs-s";
const SCHEME_EVENT = "r1do:frame-scheme";
const schemeKey = (user: string): string => `r1do/frame/scheme/${user}`;
const isScheme = (x: unknown): x is PqScheme => x === "leanSphincs-s" || x === "ML-DSA-44";

function currentUser(): string | null {
  try {
    return typeof localStorage !== "undefined" ? localStorage.getItem(LOCAL_LAST_USER) : null;
  } catch {
    return null;
  }
}

/** The selected scheme of `user` (default: the logged-in user); leanSphincs-s if none / unreadable. */
export function getScheme(user: string | null = currentUser()): PqScheme {
  if (!user) return DEFAULT_SCHEME;
  try {
    const v = localStorage.getItem(schemeKey(user));
    return isScheme(v) ? v : DEFAULT_SCHEME;
  } catch {
    return DEFAULT_SCHEME;
  }
}

/** Store the logged-in user's scheme and notify the mounted rail views (same tab). */
export function setScheme(scheme: PqScheme, user: string | null = currentUser()): void {
  if (!user) return;
  try {
    localStorage.setItem(schemeKey(user), scheme);
  } catch {
    // Storage unavailable: the selection lasts only for this view.
  }
  try {
    window.dispatchEvent(new CustomEvent<PqScheme>(SCHEME_EVENT, { detail: scheme }));
  } catch {
    /* no window (SSR) */
  }
}

/** Subscribe to scheme changes made through setScheme(); returns the unsubscribe function. */
export function onSchemeChange(cb: (scheme: PqScheme) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const h = (e: Event) => {
    const d = (e as CustomEvent<unknown>).detail;
    if (isScheme(d)) cb(d);
  };
  window.addEventListener(SCHEME_EVENT, h);
  return () => window.removeEventListener(SCHEME_EVENT, h);
}

// ---------------------------------------------------------------------------------------------
// Worker calls
// ---------------------------------------------------------------------------------------------

/** A send-progress callback crosses into the worker as a Comlink proxy (functions do not clone). */
const proxied = (cb?: PqSendEventCb) => (cb ? Comlink.proxy(cb) : undefined);

/** One-line UI text for a send event, e.g. "resubmitting (2/3)...". */
export function sendEventText(e: PqSendEvent): string {
  return `the node dropped the tx, resubmitting the same signed tx (${e.attempt}/${e.max})...`;
}

/** Derive the transparent account of `scheme` (default: the stored selection) from the 32-byte PRF root. */
export function deriveAccount(prf: Uint8Array, scheme: PqScheme = getScheme()): Promise<PqAccount> {
  return getApi().deriveAccount(scheme, prf);
}

/** On-chain status (deployed?, balance, nonce = signatures used) from the PUBLIC address, no PRF. */
export function readStatus(address: Addr): Promise<PqAccountStatus> {
  return getApi().readStatus(address);
}

/** The scheme's paymaster presence/balance, spend mode (self-pay if missing, not gating this class or
    underfunded) and budget thresholds (null for ML-DSA-44). */
export function railStatus(scheme: PqScheme = getScheme()): Promise<PqRailStatus> {
  return getApi().railStatus(scheme);
}

/** Deploy-if-needed (open sponsor) + paymaster-sponsored spend of `valueWei` to `to` from the
    transparent account of `scheme` (self-pay fallback if its paymaster is missing, does not gate
    this class or is underfunded). `sweep` sends the whole balance (minus the gas reserve in
    self-pay); `valueWei` is then ignored. `onEvent` hears send progress (rebroadcasts). */
export function spend(
  prf: Uint8Array, to: Addr, valueWei: bigint, sweep = false, scheme: PqScheme = getScheme(), onEvent?: PqSendEventCb,
): Promise<PqSpendResult> {
  return getApi().spend(scheme, prf, to, sweep ? "max" : valueWei.toString(), proxied(onEvent));
}

/** STEALTH: the ML-KEM meta-address (encapsulation key) a payment is encrypted to (same for both schemes). */
export function stealthMeta(prf: Uint8Array, scheme: PqScheme = getScheme()): Promise<PqStealthMeta> {
  return getApi().stealthMeta(scheme, prf);
}

/** STEALTH receive: a fresh one-time account of `scheme` + its ticket {ct, viewTag}. Store the
    ticket (with its scheme) at once: it is the only way to spend that account later. */
export function stealthNewPayment(prf: Uint8Array, scheme: PqScheme = getScheme()): Promise<PqStealthPayment> {
  return getApi().stealthNewPayment(scheme, prf);
}

/** What a stealth spend needs from a stored ticket. A ticket without a scheme predates the
    selection and is leanSphincs-s. */
export interface PqTicketRef { scheme?: PqScheme; stealthAddress: Addr; ct: Addr; viewTag: Addr }

/** STEALTH spend from a ticket's account, routed by the TICKET's scheme; refuses before any tx if
    the ticket does not derive `ticket.stealthAddress`. Sponsored by that scheme's paymaster. */
export function stealthSpend(
  prf: Uint8Array, ticket: PqTicketRef, to: Addr, valueWei: bigint, sweep = false, onEvent?: PqSendEventCb,
): Promise<PqSpendResult> {
  const scheme: PqScheme = ticket.scheme === "ML-DSA-44" ? "ML-DSA-44" : "leanSphincs-s";
  return getApi().stealthSpend(
    scheme, prf, ticket.ct, ticket.viewTag, ticket.stealthAddress, to, sweep ? "max" : valueWei.toString(), proxied(onEvent),
  );
}

export type {
  PqScheme, PqAccount, PqAccountStatus, PqSpendResult, FrameTxDesc, FrameDesc,
  PqStealthMeta, PqStealthPayment, PqRailStatus, PqFallbackReason, PqSendEvent, PqSendEventCb,
};
