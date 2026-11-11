// Testnet faucet claim for the Hegota rail: one POST {address} to the network's faucet, which
// sends test funds to that address. Rail-owned and removable with src/lib/frame. The faucet host is
// already in the CSP connect-src allowlist (lib/csp.ts) and answers CORS for any origin.
import { HEGOTA } from "@/lib/frame/network";

export type FaucetResult = { ok: true; text: string } | { ok: false; text: string };

/** Claim test funds for `address`. Never throws: the result carries the faucet's own message. */
export async function claimFaucet(address: `0x${string}`): Promise<FaucetResult> {
  const url = HEGOTA.faucetUrl;
  if (!url) return { ok: false, text: "this network has no faucet" };
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address }),
    });
    const raw = await res.text();
    let detail = raw.trim();
    try {
      const j = JSON.parse(raw) as Record<string, unknown>;
      const pick = j.message ?? j.error ?? j.detail ?? j.txHash ?? j.tx_hash ?? j.hash;
      if (typeof pick === "string") detail = pick;
    } catch {
      /* plain-text body: keep it as is */
    }
    if (!res.ok) return { ok: false, text: detail || `faucet error (HTTP ${res.status})` };
    return { ok: true, text: detail };
  } catch (e: unknown) {
    return { ok: false, text: e instanceof Error ? e.message : "faucet unreachable" };
  }
}
