// Live frame-tx submission + secp256k1 frame signature (wire v(1, bare 0/1)||r(32)||s(32)).
import { sign } from 'viem/accounts';
import { type Hex } from 'viem';
import { sigHash, encode, type FrameTx, type Signature } from "./frametx";

export async function k1FrameSignature(sigHashHex: Hex, privateKey: Hex): Promise<Hex> {
  const s = await sign({ hash: sigHashHex, privateKey });
  const v = s.yParity === 0 ? '00' : '01';
  const r = s.r.slice(2).padStart(64, '0');
  const ss = s.s.slice(2).padStart(64, '0');
  return ('0x' + v + r + ss) as Hex;
}

export async function rpc<T>(url: string, method: string, params: unknown[], retries = 3): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`); // transient (5xx / gateway): retry
      const j = await res.json() as { result?: T; error?: { message: string } };
      if (j.error) throw new Error(`${method}: ${j.error.message}`); // RPC logic error: do NOT retry
      return j.result as T;
    } catch (e) {
      // Only retry transient transport failures (fetch throw / non-2xx), never RPC logic errors.
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

/** Dynamic gas LIMIT for a normal tx: ask the node (eth_estimateGas) and add a buffer, so
    we never hardcode a limit that is too low (a short limit reverts, e.g. a CREATE needs
    ~220k, not the 21k/200k one might guess) nor absurdly high. The buffer absorbs estimate
    drift and state changes between estimate and inclusion. */
export async function gasFor(
  url: string,
  req: { from?: Hex; to?: Hex; data?: Hex; value?: Hex },
  bufferPct = 25,
): Promise<bigint> {
  const est = BigInt(await rpc<Hex>(url, 'eth_estimateGas', [req]));
  return (est * BigInt(100 + bufferPct)) / 100n;
}

export async function sendFrameTx(url: string, raw: Hex): Promise<Hex> { return rpc<Hex>(url, 'eth_sendRawTransaction', [raw]); }

export interface FrameReceipt { status?: Hex; transactionHash?: Hex; gasUsed?: Hex; contractAddress?: Hex | null; [k: string]: unknown; }

export async function waitReceipt(url: string, hash: Hex, tries = 180): Promise<FrameReceipt> {
  for (let i = 0; i < tries; i++) {
    const r = await rpc<FrameReceipt | null>(url, 'eth_getTransactionReceipt', [hash]);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error('receipt timeout');
}

/** Sign a single-k1 frame tx as `sender` and return the raw bytes. */
export async function signAndEncodeK1(tx: FrameTx, privateKey: Hex): Promise<Hex> {
  const sig = await k1FrameSignature(sigHash(tx), privateKey);
  (tx.signatures[0] as Signature).signature = sig;
  return encode(tx);
}
