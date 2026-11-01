// Live frame-tx submission: JSON-RPC, dynamic fees, raw send. The receipt wait (with the dropped-tx
// re-broadcast) lives in railCore.sendAndWait. The rail signs only with PQ keys, so the vendored
// secp256k1 frame signer is not carried here.
import { type Hex } from 'viem';

// Per-request timeout. A fetch the node never answers would otherwise never settle, and a caller
// holding a lock (railCore's serialized sponsored deploy) would wedge every later caller behind it.
// 25 s is far above a healthy devnet round trip (well under 1 s) yet short enough that a stuck UI
// action fails visibly. A timed-out request is aborted and rejects with RpcTimeoutError; it is NOT
// retried here (a node that held one request that long is not answering): polling callers treat it
// as a transient miss and poll again, one-shot callers surface it.
export const RPC_TIMEOUT_MS = 25_000;

/** No response within RPC_TIMEOUT_MS. For eth_sendRawTransaction the tx may still have reached the
    node: the caller must not assume it was not sent. */
export class RpcTimeoutError extends Error {}

async function postOnce<T>(url: string, method: string, params: unknown[]): Promise<{ result?: T; error?: { message: string } }> {
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // Raced against the fetch as well as aborting it, so a body read that ignores the signal still
  // cannot hang the caller.
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new RpcTimeoutError(`RPC timeout: ${method} got no response from the node within ${RPC_TIMEOUT_MS / 1000}s`));
    }, RPC_TIMEOUT_MS);
  });
  const request = (async () => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`); // transient (5xx / gateway): retry
    return await res.json() as { result?: T; error?: { message: string } };
  })();
  try {
    return await Promise.race([request, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export async function rpc<T>(url: string, method: string, params: unknown[], retries = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const j = await postOnce<T>(url, method, params);
      if (j.error) throw new Error(`${method}: ${j.error.message}`); // RPC logic error: do NOT retry
      return j.result as T;
    } catch (e) {
      // Only retry transient transport failures (fetch throw / non-2xx), never RPC logic errors
      // and never a timeout (see RPC_TIMEOUT_MS).
      if (e instanceof RpcTimeoutError) throw e;
      if (e instanceof Error && e.message.startsWith(`${method}:`)) throw e;
      lastErr = e;
      if (attempt < retries - 1) await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(`${method}: request failed`);
}

/** Dynamic fees. A fixed, self-inflation-proof fee derived from the chain's REAL base fee.
    eth_gasPrice echoes recent priority tips, so reading it and bumping (gasPrice*2) across
    runs ratchets the suggestion upward without bound. We read baseFeePerGas from the latest
    block (the true protocol cost) and add a FIXED tip, with headroom for a base-fee rise and
    a floor so a near-zero base fee still pays a sane fee. Adapts to real congestion; never
    compounds its own output. */
export interface Fees { gasPrice: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; }

// This devnet runs near-empty with a ~7 wei base fee, so a tiny tip mines fine and keeps the
// self-pay RESERVE (gasLimit * maxFee) low: at 0.1 gwei a ~16.8M-gas spend reserves ~0.0017
// ETH instead of ~0.034 at 2 gwei. The headroom still tracks a real base-fee rise.
export const FEE_TIP_WEI = 100_000_000n;     // 0.1 gwei priority tip (constant, not oracle-derived)
export const FEE_HEADROOM = 3n;              // cover a base-fee rise before the tx lands
export const FEE_FLOOR_WEI = 100_000_000n;   // 0.1 gwei floor

export async function networkFees(url: string): Promise<Fees> {
  const blk = await rpc<{ baseFeePerGas?: Hex } | null>(url, 'eth_getBlockByNumber', ['latest', false]);
  const baseFee = blk?.baseFeePerGas ? BigInt(blk.baseFeePerGas) : 0n;
  let maxFee = baseFee * FEE_HEADROOM + FEE_TIP_WEI;
  if (maxFee < FEE_FLOOR_WEI) maxFee = FEE_FLOOR_WEI;
  return { gasPrice: maxFee, maxFeePerGas: maxFee, maxPriorityFeePerGas: FEE_TIP_WEI };
}

export async function sendFrameTx(url: string, raw: Hex): Promise<Hex> { return rpc<Hex>(url, 'eth_sendRawTransaction', [raw]); }

export interface FrameReceipt { status?: Hex; transactionHash?: Hex; gasUsed?: Hex; contractAddress?: Hex | null; [k: string]: unknown; }
