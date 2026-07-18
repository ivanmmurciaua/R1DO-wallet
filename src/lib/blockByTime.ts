// Date → block resolution for the calendar deep-scan.
//
// The stealth scanner only ever speaks blocks, but a user recovering payments on
// a new device thinks in dates ("I've had this wallet since March"). This maps
// one to the other.
//
// Binary search over block timestamps, on the same public RPCs the scanner
// already uses. Deliberately NOT an explorer API (getblocknobytime): that would
// re-introduce an API key in the bundle (the /api/etherscan proxy is still a
// pending follow-up), tie the deep-scan to chains an explorer happens to cover,
// and put a third party between the user and their own payment history. A search
// costs ~32 header reads / ~5s once per deep-scan (measured on Arbitrum One) —
// noise next to the scan it precedes.
//
// It needs no block-time constant either, so it stays correct on any chain we add
// (and on Arbitrum, whose block rate is neither fixed nor comparable to L1's).

import { createPublicClient, http, fallback } from "viem";
import { activeChain, activeRpcUrls } from "@/lib/networks";

// One read can hit a cold, rate-limited or slightly-lagging RPC.
const READ_RETRIES = 4;
const RETRY_DELAY_MS = 250;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Rotate which RPC is PRIMARY, exactly as the scanner does: viem's fallback only
// moves on when a transport ERRORS, and it always re-starts at transport[0]. A
// node that is merely behind answers eth_getBlockByNumber with a valid JSON-RPC
// `result: null` — no error, so no rotation, and a retry would just hammer the
// same node into the same null. Rotating the order per attempt puts a DIFFERENT
// node first each time (fallback still covers hard failures within an attempt).
const clientAt = (rot: number) => {
  const urls = activeRpcUrls();
  const r = ((rot % urls.length) + urls.length) % urls.length;
  const rotated = [...urls.slice(r), ...urls.slice(0, r)];
  return createPublicClient({ chain: activeChain(), transport: fallback(rotated.map((u) => http(u))) });
};

// Header-only reads (no transactions) — cheap, and not pruned the way historical
// state is, so old blocks stay reachable on public RPCs (probed on Arbitrum: all
// four serve block 0).
//
// `rot` is threaded through by the caller so a tip and its header are read from
// the SAME node: nodes disagree about the tip by a block or two, and asking node
// B for the block number node A just reported is exactly how the null above
// happens. A node is always self-consistent — it has the tip it just named.
async function timestampAt(block: bigint, rot: number): Promise<bigint> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < READ_RETRIES; attempt++) {
    try {
      const b = await clientAt(rot + attempt).getBlock({ blockNumber: block, includeTransactions: false });
      return b.timestamp;
    } catch (e) {
      // Includes BlockNotFoundError (the null case) — retryable, next node.
      lastErr = e;
      if (attempt < READ_RETRIES - 1) await sleep(RETRY_DELAY_MS);
    }
  }
  throw new Error(
    `blockByTime: could not read block ${block} after ${READ_RETRIES} attempts` +
      `${lastErr instanceof Error ? ` (${lastErr.message})` : ""}`,
  );
}

// The chain tip AND its timestamp, read from one node so they always agree.
async function tip(): Promise<{ block: bigint; timestamp: bigint; rot: number }> {
  let lastErr: unknown = null;
  for (let rot = 0; rot < READ_RETRIES; rot++) {
    try {
      const client = clientAt(rot);
      const block = await client.getBlockNumber();
      const { timestamp } = await client.getBlock({ blockNumber: block, includeTransactions: false });
      return { block, timestamp, rot };
    } catch (e) {
      lastErr = e;
      await sleep(RETRY_DELAY_MS);
    }
  }
  throw new Error(
    `blockByTime: could not read the chain tip` +
      `${lastErr instanceof Error ? ` (${lastErr.message})` : ""}`,
  );
}

export interface ResolvedBlock {
  /** First block whose timestamp is >= the requested instant. */
  block: bigint;
  /** That block's actual timestamp (seconds) — may sit after the request if the chain had a gap. */
  timestamp: bigint;
  /** Header reads spent resolving it (diagnostics / RPC-budget logging). */
  reads: number;
}

// The FIRST block at or after `date` — i.e. the lower bound, the exact block a
// scan must start from to cover everything that happened on/after that instant.
//
// Clamped, never throwing on range:
//   · date before genesis → block 0 (scan everything)
//   · date in the future  → the latest block (an empty range: nothing to scan)
//
// Ties are fine: chains with sub-second blocks (Arbitrum) give many blocks the
// same second, and a lower-bound search lands on the first of them — so no block
// inside the requested instant is ever skipped.
export async function blockAtOrAfter(date: Date): Promise<ResolvedBlock> {
  const target = BigInt(Math.floor(date.getTime() / 1000));
  let reads = 0;

  const { block: latest, timestamp: latestTs, rot } = await tip();
  reads += 1;
  if (latestTs <= target) return { block: latest, timestamp: latestTs, reads };

  // Arbitrum One's block 0 carries timestamp 0 (a classic-genesis quirk, probed
  // live), not a real date — so this only ever short-circuits a date at the epoch,
  // and `ts(0) < target` still holds for any real one, which is all the search
  // below needs.
  const genesisTs = await timestampAt(0n, rot);
  reads += 1;
  if (genesisTs >= target) return { block: 0n, timestamp: genesisTs, reads };

  // Invariant: ts(lo) < target <= ts(hi). Each step halves the gap, so it ends
  // with hi == lo + 1 and hi as the answer. Timestamps are non-decreasing by
  // consensus rule, which is what makes the search sound in the first place.
  let lo = 0n;
  let hi = latest;
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    const ts = await timestampAt(mid, rot + reads);
    reads += 1;
    if (ts < target) lo = mid;
    else hi = mid;
  }

  const timestamp = await timestampAt(hi, rot + reads);
  reads += 1;
  console.log(
    `[blockByTime] ${date.toISOString()} → block ${hi} (ts ${timestamp}) in ${reads} reads`,
  );
  return { block: hi, timestamp, reads };
}

// Safety margin applied to a picked CALENDAR DAY, in seconds (12h).
//
// A day is not an instant — it holds ~345k blocks on Arbitrum — so a picked day
// only tells us a boundary, and the boundary has to absorb two kinds of slop:
//
//  · Timezone. A picker hands over local midnight. For a user at UTC-5 that is
//    05:00 UTC, five hours AFTER the day they meant started in UTC.
//  · Human memory. "I think I set it up around March 1st" is not a timestamp.
//
// Both are one-directional risks, and the direction is what matters: scanning too
// early costs RPC calls and finds nothing; scanning too late silently misses a
// payment and the user never learns it existed. So a picked day always resolves
// to a block BEFORE it, never after — the whole point of the deep-scan is to stop
// losing money to gaps.
const DAY_MARGIN_SECONDS = 12 * 60 * 60;

// The block a deep-scan must start from to cover an entire picked calendar DAY.
// Use this for anything the user chose from a date picker; `blockAtOrAfter` is
// the raw primitive for an instant we actually know (e.g. a directory entry's
// own block timestamp).
export async function blockForCalendarDay(day: Date): Promise<ResolvedBlock> {
  // Floor to local midnight, then step back by the margin.
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  return blockAtOrAfter(new Date(start.getTime() - DAY_MARGIN_SECONDS * 1000));
}

// The block a deep-scan must stop at to have covered an entire picked calendar
// DAY — the mirror of blockForCalendarDay, for a sweep that ends in the past
// instead of at the tip. Same margin, same direction: it lands AFTER the day
// ended, so the day is covered whole even if the user's clock and the chain's
// disagree. A day past the tip resolves to the tip (blockAtOrAfter clamps), which
// is exactly right — a window reaching into the future just ends at now.
export async function blockAfterCalendarDay(day: Date): Promise<ResolvedBlock> {
  const endExclusive = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  return blockAtOrAfter(new Date(endExclusive.getTime() + DAY_MARGIN_SECONDS * 1000));
}
