// Hegota rail PQ worker. Key generation and signing are CPU-heavy, so they run off the main thread
// (same Comlink pattern as pool/railgun.worker.ts). The passkey-PRF root arrives as 32 bytes; every
// key is derived here with its own domain tag, independent of delta1's existing keys. Secret keys
// NEVER leave the worker: only addresses, public key words and mined tx hashes/decodes come out.
//
// Two account classes, chosen by the user per account and passed EXPLICITLY on every call (the
// worker holds no selection state; pqClient.ts reads it from storage):
//   "leanSphincs-s" (lssRail.ts, default): hash-based SphincsFrameAccountS, verify in the VERIFY
//       prefix (~50K gas), sponsored by the leanSphincs keyless paymaster.
//   "ML-DSA-44" (mldsaRail.ts): lattice AccountMldsaS, verify in an atomic DEFAULT frame (~1.25M gas),
//       sponsored by its own keyless paymaster; stealth accounts are DKSAP-blinded ML-DSA keys.
// Both: deployed by the open sponsor on first spend, self-pay fallback if their paymaster is
// missing, not gating or underfunded, one transparent account plus a fresh one-time stealth account
// per payment from an ML-KEM ticket {ct, viewTag} (one shared meta-address).
import * as Comlink from "comlink";
import type { Hex } from "viem";
import * as lss from "./lssRail";
import * as mldsa from "./mldsaRail";
import { type PqScheme, type PqSendEventCb } from "./railCore";

/** The rail module for `scheme`. Anything that is not exactly "ML-DSA-44" (incl. a ticket stored
    before schemes existed) is leanSphincs-s, the default. */
const rail = (scheme: PqScheme | undefined) => (scheme === "ML-DSA-44" ? mldsa : lss);

const api = {
  /** Transparent account identity + deterministic address (public material only). */
  deriveAccount: (scheme: PqScheme, prf: Uint8Array) => rail(scheme).deriveAccount(prf),
  /** On-chain status from the PUBLIC address (no PRF): deployed?, balance, nonce (= signatures used). */
  readStatus: (address: Hex) => lss.readStatus(address),
  /** The scheme's paymaster presence/balance, spend mode and (leanSphincs-s only) signature budget. */
  railStatus: (scheme: PqScheme) => rail(scheme).railStatus(),
  /** Deploy-if-needed (sponsored) + paymaster-sponsored spend; valueWei "max" = whole balance.
      `onEvent` (a Comlink proxy) hears send progress, e.g. a dropped tx being rebroadcast. */
  spend: (scheme: PqScheme, prf: Uint8Array, to: Hex, valueWei: string, onEvent?: PqSendEventCb) =>
    rail(scheme).spend(prf, to, valueWei, onEvent),
  /** ML-KEM meta-address (encapsulation key, public; the same for both schemes). */
  stealthMeta: (scheme: PqScheme, prf: Uint8Array) => rail(scheme).stealthMeta(prf),
  /** Fresh one-time stealth account of `scheme` + its ticket {ct, viewTag} (public material only). */
  stealthNewPayment: (scheme: PqScheme, prf: Uint8Array) => rail(scheme).stealthNewPayment(prf),
  /** Spend from a ticket's account; `scheme` must be the TICKET's scheme (checked against
      stealthAddress first; same TX1/TX2 as transparent). */
  stealthSpend: (
    scheme: PqScheme, prf: Uint8Array, ct: Hex, viewTag: Hex, stealthAddress: Hex, to: Hex, valueWei: string, onEvent?: PqSendEventCb,
  ) => rail(scheme).stealthSpend(prf, ct, viewTag, stealthAddress, to, valueWei, onEvent),
};

export type PqWorkerApi = typeof api;
export type {
  PqScheme, PqAccount, PqStealthMeta, PqStealthPayment, PqRailStatus, PqFallbackReason,
  PqAccountStatus, PqSpendResult, FrameTxDesc, FrameDesc, PqSendEvent, PqSendEventCb,
} from "./railCore";
Comlink.expose(api);
