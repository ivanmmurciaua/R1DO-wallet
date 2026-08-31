/* rpcManager.ts — in-browser RPC bench + role classification.

   Validates a candidate JSON-RPC endpoint with the SAME battery as
   scripts/rpc-bench.sh, but from the BROWSER — so it also catches what curl
   cannot: CORS (a node that curl reaches but the browser refuses is useless
   here) and the real browser getLogs caps.

   Roles are assigned AUTOMATICALLY from the results (the user never tags):
     · any node that passes chainId + light reads + a ≥17 JSON-RPC batch is a
       usable general failover node (goes into rpcUrls);
     · if it also serves a wide archive eth_getLogs range it earns the "logs"
       role, with the probed window (goes into logsRpcUrls);
     · if it survives a 20× burst with no 429 it earns the "scan" role (goes
       into scanRpcUrls, the fan-out shards).

   Mutations (add/remove/disable) are persisted via networks.ts's override
   store; like a network switch, they take effect on RELOAD. */

import {
  activeChainId,
  readRpcOverride,
  writeRpcOverride,
  type CustomRpc,
  type NetworkId,
  type RpcRole,
} from "./networks";

// Multicall3 — canonical, same address on every chain. A safe, always-present
// target for getBalance/eth_call/getCode/getLogs probes.
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const GET_BLOCK_NUMBER = "0x42cbb15c"; // Multicall3.getBlockNumber() selector

export type CheckName =
  | "chainId"
  | "getBalance"
  | "eth_call"
  | "getCode"
  | "getLogs"
  | "getLogsNoFilter"
  | "batch"
  | "burst";

export type BenchCheck = { name: CheckName; ok: boolean; detail: string };

export type BenchResult = {
  url: string;
  reachable: boolean; // returned a valid chainId for the ACTIVE chain
  accepted: boolean; // usable as at least a general failover node
  roles: RpcRole[]; // logs / scan (general is implicit for any accepted node)
  window?: number; // probed getLogs window (blocks) when the logs role is earned
  checks: BenchCheck[];
  summary: string;
};

const hex = (n: number) => "0x" + Math.max(0, Math.floor(n)).toString(16);
const fmtWin = (w: number) => (w >= 1_000_000 ? `${w / 1_000_000}M` : `${Math.round(w / 1000)}k`);

type CallOut = { ok: boolean; result?: unknown; error?: string; httpStatus: number };

async function rpcCall(url: string, method: string, params: unknown[], timeoutMs = 12000): Promise<CallOut> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    const httpStatus = res.status;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON body */
    }
    if (body && body.error) return { ok: false, error: String(body.error.message ?? body.error), httpStatus };
    if (!res.ok) return { ok: false, error: `HTTP ${httpStatus}`, httpStatus };
    return { ok: true, result: body?.result, httpStatus };
  } catch (e) {
    // fetch rejects on CORS failure, DNS/network error, or the abort timeout —
    // all disqualifying for in-browser use.
    const name = (e as Error)?.name;
    return {
      ok: false,
      error: name === "AbortError" ? "timeout" : `blocked / CORS (${(e as Error)?.message ?? "fetch failed"})`,
      httpStatus: 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

async function rpcBatch(url: string, count: number, timeoutMs = 15000): Promise<boolean> {
  const reqs = Array.from({ length: count }, (_, i) => ({
    jsonrpc: "2.0",
    id: i + 1,
    method: "eth_chainId",
    params: [] as unknown[],
  }));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reqs),
      signal: ctrl.signal,
    });
    if (!res.ok) return false;
    const body = await res.json();
    // A conformant node returns an array of the SAME length, none erroring. Nodes
    // that cap batches return a shorter array, an object, or an error.
    return (
      Array.isArray(body) &&
      body.length === count &&
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      body.every((r: any) => r && r.error == null && r.result != null)
    );
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function burst(url: string, n = 20): Promise<{ ok: number; r429: number; other: number; non200: number }> {
  const one = async (): Promise<number> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 12000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [MULTICALL3, "latest"] }),
        signal: ctrl.signal,
      });
      return res.status;
    } catch {
      return 0;
    } finally {
      clearTimeout(timer);
    }
  };
  const statuses = await Promise.all(Array.from({ length: n }, one));
  const ok = statuses.filter((s) => s === 200).length;
  const r429 = statuses.filter((s) => s === 429).length;
  const non200 = statuses.filter((s) => s !== 200).length;
  return { ok, r429, other: non200 - r429, non200 };
}

// Largest getLogs block span (from [1M, 500k, 100k, 50k]) the node serves cleanly
// with an address filter (small payload — probes the block-span CAP, not size).
// 0 = caps below 50k → too small to be a useful scanner node.
async function probeWindow(url: string, head: number): Promise<number> {
  for (const w of [1_000_000, 500_000, 100_000, 50_000]) {
    const from = head > w ? head - w : 0;
    const r = await rpcCall(url, "eth_getLogs", [{ address: MULTICALL3, fromBlock: hex(from), toBlock: hex(head) }], 20000);
    if (r.ok) return w;
  }
  return 0;
}

/** Run the full battery against `url` for the ACTIVE chain. `onProgress` fires
    after each check so the UI can stream results live. */
export async function benchRpc(url: string, onProgress?: (c: BenchCheck) => void): Promise<BenchResult> {
  const checks: BenchCheck[] = [];
  const push = (c: BenchCheck) => {
    checks.push(c);
    onProgress?.(c);
  };
  const wantChainId = activeChainId();

  // 1. chainId — must reach it AND be the right chain. A CORS/network failure
  // surfaces here as an unreachable node (the common "it works in curl" trap).
  const cid = await rpcCall(url, "eth_chainId", []);
  const cidNum = cid.ok ? parseInt(String(cid.result), 16) : NaN;
  const chainOk = cid.ok && cidNum === wantChainId;
  push({
    name: "chainId",
    ok: chainOk,
    detail: cid.ok
      ? chainOk
        ? `chainId ${cidNum} ✓`
        : `wrong chain: ${cidNum} (want ${wantChainId})`
      : cid.error ?? "no response",
  });
  if (!chainOk) {
    return {
      url,
      reachable: false,
      accepted: false,
      roles: [],
      checks,
      summary: cid.error?.includes("CORS") ? "Blocked by CORS or unreachable from the browser" : "Wrong chain or unreachable",
    };
  }

  const bn = await rpcCall(url, "eth_blockNumber", []);
  const head = bn.ok ? parseInt(String(bn.result), 16) : 0;

  // 2-4. light reads (getCode is the one Pimlico can't do → why a public RPC is needed)
  const bal = await rpcCall(url, "eth_getBalance", [MULTICALL3, "latest"]);
  push({ name: "getBalance", ok: bal.ok, detail: bal.ok ? "ok" : bal.error ?? "err" });
  const call = await rpcCall(url, "eth_call", [{ to: MULTICALL3, data: GET_BLOCK_NUMBER }, "latest"]);
  push({ name: "eth_call", ok: call.ok, detail: call.ok ? "ok" : call.error ?? "err" });
  const code = await rpcCall(url, "eth_getCode", [MULTICALL3, "latest"]);
  push({ name: "getCode", ok: code.ok, detail: code.ok ? "ok" : code.error ?? "err" });

  // 5. archive getLogs over a real span (address-filtered → small payload)
  const logs = await rpcCall(
    url,
    "eth_getLogs",
    [{ address: MULTICALL3, fromBlock: hex(head - 3000), toBlock: hex(head) }],
    15000,
  );
  push({
    name: "getLogs",
    ok: logs.ok,
    detail: logs.ok ? `ok (${Array.isArray(logs.result) ? (logs.result as unknown[]).length : "?"} logs)` : logs.error ?? "err",
  });

  // 6. no-filter getLogs — result-cap stress (returns MANY logs)
  const logsNo = await rpcCall(url, "eth_getLogs", [{ fromBlock: hex(head - 2000), toBlock: hex(head) }], 15000);
  push({ name: "getLogsNoFilter", ok: logsNo.ok, detail: logsNo.ok ? "ok" : logsNo.error ?? "err (result cap?)" });

  // 7. JSON-RPC batch of 17 — viem/ethers batch by default; a node that caps
  // batches poisons the whole failover list.
  const batchOk = await rpcBatch(url, 17);
  push({ name: "batch", ok: batchOk, detail: batchOk ? "17/17 ✓" : "batch truncated / errored" });

  // 8. burst x20 — the ops workload must not 429.
  const b = await burst(url, 20);
  const burstClean = b.non200 === 0;
  push({ name: "burst", ok: burstClean, detail: `200=${b.ok} 429=${b.r429} other=${b.other}` });

  // ── verdict + roles ─────────────────────────────────────────────────────────
  const reads = bal.ok && call.ok && code.ok;
  const accepted = reads && batchOk; // usable as a general failover node
  const roles: RpcRole[] = [];
  let window: number | undefined;
  if (accepted && logs.ok) {
    const w = await probeWindow(url, head);
    if (w >= 50000) {
      roles.push("logs");
      window = w;
    }
  }
  if (accepted && burstClean) roles.push("scan");

  const summary = !accepted
    ? "Reachable but fails core reads/batch — not usable"
    : `Usable${roles.length ? " · " + roles.join(" + ") : " (general failover only)"}${window ? ` · getLogs ~${fmtWin(window)}` : ""}`;

  return { url, reachable: true, accepted, roles, window, checks, summary };
}

// ── override mutations (persisted; take effect on reload) ─────────────────────

/** Add (or replace) a custom RPC entry (persists + syncs the CSP cookie). */
export function upsertCustomRpc(id: NetworkId, entry: CustomRpc): void {
  const ov = readRpcOverride(id);
  const custom = ov.custom.filter((c) => c.url !== entry.url);
  custom.push(entry);
  writeRpcOverride(id, { ...ov, custom });
}

/** Add (or replace) a benched custom RPC for a network, with its earned roles. */
export function saveBenchedRpc(id: NetworkId, r: BenchResult): void {
  if (!r.accepted) return;
  upsertCustomRpc(id, { url: r.url, roles: r.roles, window: r.window });
}

/** Remove a user-added custom RPC. */
export function removeCustomRpc(id: NetworkId, url: string): void {
  const ov = readRpcOverride(id);
  writeRpcOverride(id, { ...ov, custom: ov.custom.filter((c) => c.url !== url) });
}

/** Enable/disable a curated (default) RPC without deleting it. */
export function setCuratedDisabled(id: NetworkId, url: string, disabled: boolean): void {
  const ov = readRpcOverride(id);
  const set = new Set(ov.disabled);
  if (disabled) set.add(url);
  else set.delete(url);
  writeRpcOverride(id, { ...ov, disabled: [...set] });
}
