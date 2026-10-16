// EIP-8141 frame-transaction codec (TS port of the testbed's frametx8.py + pq-dksap
// Frame/Signature). Byte-identical RLP + sig_hash against the Python reference.
// Envelope layout is a migration variable: fees flat (hegota 3151908) or nested
// (privacy 8141), and recent_root_references present (hegota) or absent (privacy).
import { toRlp, keccak256, concat, type Hex } from 'viem';

// Local recursive RLP item type (viem does not export RecursiveArray in this version).
type RlpItem = Hex | RlpItem[];

export const FRAME_TX_TYPE = 0x06;
export const MODE_DEFAULT = 0, MODE_VERIFY = 1, MODE_SENDER = 2;
export const SCHEME_ARBITRARY = 0, SCHEME_SECP256K1 = 1, SCHEME_P256 = 2;
export const FLAG_NONE = 0x0, FLAG_APPROVE_EXECUTION = 0x1, FLAG_APPROVE_PAYMENT = 0x2,
  FLAG_APPROVE_EXECUTION_AND_PAYMENT = 0x3, FLAG_ATOMIC_BATCH = 0x4;

export interface Frame {
  mode: number; flags: number; target: string | null;
  executionGas: bigint | number; stateGas: bigint | number; value: bigint | number; data?: Hex;
}
export interface Signature { scheme: number; signer: string | null; msg?: Hex; signature?: Hex; }
export interface FrameTx {
  chainId: bigint | number; nonce: bigint | number; sender: string;
  frames: Frame[]; signatures: Signature[];
  nonceKeys?: (bigint | number)[];
  maxPriorityFeePerGas: bigint | number; maxFeePerGas: bigint | number; maxFeePerBlobGas?: bigint | number;
  blobVersionedHashes?: Hex[]; recentRootReferences?: RlpItem[];
  feeNested?: boolean; omitRecentRoots?: boolean;
}

// RLP of a non-negative integer: minimal big-endian, 0 -> empty byte string.
function num(n: bigint | number): Hex {
  const v = BigInt(n);
  if (v === 0n) return '0x';
  let h = v.toString(16);
  if (h.length % 2) h = '0' + h;
  return ('0x' + h) as Hex;
}
function addr(a: string | null | undefined): Hex {
  if (!a || a === '0x') return '0x';
  return a.toLowerCase() as Hex;
}
const bytes = (h: Hex | undefined): Hex => (h && h !== '0x' ? h : '0x');

function frameList(f: Frame): RlpItem {
  return [num(f.mode), num(f.flags), addr(f.target),
    [num(f.executionGas), num(f.stateGas)], num(f.value), bytes(f.data)];
}
function sigList(s: Signature, canonical: boolean): RlpItem {
  const sigBytes = canonical && (!s.msg || s.msg === '0x') ? '0x' : bytes(s.signature);
  return [num(s.scheme), addr(s.signer), bytes(s.msg), sigBytes];
}

function payloadList(tx: FrameTx, canonical: boolean): RlpItem {
  const head: RlpItem[] = [
    num(tx.chainId),
    (tx.nonceKeys ?? [0]).map(num),
    num(tx.nonce),
    addr(tx.sender),
    tx.frames.map(frameList),
    tx.signatures.map((s) => sigList(s, canonical)),
  ];
  const pri = num(tx.maxPriorityFeePerGas), fee = num(tx.maxFeePerGas), blob = num(tx.maxFeePerBlobGas ?? 0);
  const fees: RlpItem[] = tx.feeNested ? [[pri, fee, blob]] : [pri, fee, blob];
  const tail: RlpItem[] = [(tx.blobVersionedHashes ?? []) as RlpItem];
  if (!tx.omitRecentRoots) tail.push((tx.recentRootReferences ?? []) as RlpItem);
  return [...head, ...fees, ...tail];
}

const typeByte = ('0x0' + FRAME_TX_TYPE.toString(16)) as Hex;
export function encode(tx: FrameTx): Hex { return concat([typeByte, toRlp(payloadList(tx, false), 'hex')]); }
export function sigHash(tx: FrameTx): Hex { return keccak256(concat([typeByte, toRlp(payloadList(tx, true), 'hex')])); }
