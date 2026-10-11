// Main-thread client for the Hegota rail PQ worker (Comlink), same lazy pattern as
// pool/railgun.ts. The worker is created on first use and reused.
import * as Comlink from "comlink";
import type {
  PqWorkerApi, PqAccount, PqAccountStatus, PqSpendResult, FrameTxDesc, FrameDesc,
  PqStealthMeta, PqStealthPayment, PqNickResolution,
} from "./pq.worker";

let worker: Worker | null = null;
let api: Comlink.Remote<PqWorkerApi> | null = null;

function getApi(): Comlink.Remote<PqWorkerApi> {
  if (!api) {
    worker = new Worker(new URL("./pq.worker.ts", import.meta.url), { type: "module" });
    api = Comlink.wrap<PqWorkerApi>(worker);
  }
  return api;
}

/** Derive the rail account's PQ identity (and deterministic address) from the 32-byte PRF root. */
export function deriveAccount(prf: Uint8Array): Promise<PqAccount> {
  return getApi().deriveAccount(prf);
}

/** Read the on-chain status (deployed?, balance) from the PUBLIC address, no PRF needed. */
export function readStatus(address: `0x${string}`): Promise<PqAccountStatus> {
  return getApi().readStatus(address);
}

/** Path A spend: deploy-if-needed (sponsored) + self-pay ML-DSA spend of `valueWei` to `to`.
    The user funds nothing; the account pays its own spend from its received balance.
    `sweep` sends the whole balance minus the gas reserve (the `valueWei` argument is ignored). */
export function spend(prf: Uint8Array, to: `0x${string}`, valueWei: bigint, sweep = false): Promise<PqSpendResult> {
  return getApi().spend(prf, to, sweep ? "max" : valueWei.toString());
}

/** STEALTH: the displayable meta-address (ML-KEM encapsulation key hex) for the UI to show. */
export function stealthMeta(prf: Uint8Array): Promise<PqStealthMeta> {
  return getApi().stealthMeta(prf);
}

/** STEALTH sender-to-self: a fresh one-time stealth address + off-chain ticket {ct, viewTag}. */
export function stealthNewPayment(prf: Uint8Array): Promise<PqStealthPayment> {
  return getApi().stealthNewPayment(prf);
}

/** STEALTH recipient side: recover from the ticket, then deploy-if-needed + blinded self-pay
    spend of `valueWei` to `to`. Mirrors the proven spike TX1+TX2. */
export function stealthSpend(
  prf: Uint8Array, ct: `0x${string}`, viewTag: `0x${string}`, to: `0x${string}`, valueWei: bigint, sweep = false,
): Promise<PqSpendResult> {
  return getApi().stealthSpend(prf, ct, viewTag, to, sweep ? "max" : valueWei.toString());
}

/** PAY-BY-NICK: resolve @nick -> meta-address OFF-CHAIN, authenticated by EIP-8272 recent
    roots (free view call, no gas, no PRF). Returns ok=false with a reason on a miss. */
export function resolveNick(name: string): Promise<PqNickResolution> {
  return getApi().resolveNick(name);
}

export type {
  PqAccount, PqAccountStatus, PqSpendResult, FrameTxDesc, FrameDesc,
  PqStealthMeta, PqStealthPayment, PqNickResolution,
};
