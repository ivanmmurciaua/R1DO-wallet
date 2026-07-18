// Calendar deep-scan — the opt-in "check for earlier payments" sweep.
//
// The problem it solves: the scan cursor is per-device (localStorage) and the
// UTXOs live in this device's IndexedDB, but the passkey syncs. Register on a
// phone, log in on a PC with the same passkey and it works — yet the PC starts
// its cursor at "now", so every payment received before that moment is invisible
// there. Nothing is lost on-chain; the money is simply unseen. The other two
// worlds don't have this: public balances are a live getBalance, and Railgun
// rescans its own tree from the mnemonic. Stealth has only our scanner, so this
// IS the historical rescan.
//
// Design: it drives the same scanStealthPayments the forward scan does, differing
// only in its range and in what it does per window — the one thing it added there
// is an optional toBlock, so a sweep is a bounded WINDOW the user places anywhere
// in the past rather than a backlog running to the tip. That is what makes a
// payment from a month ago findable in 20 minutes instead of two hours.
//
// Deliberately it does NOT touch the scan cursor — that stays exactly what it is
// today ("scanned forward up to here"), written only by the forward scan. Nothing
// records which windows a sweep covered, so nothing can record it WRONG: the cost
// of forgetting is a repeated scan, while the cost of a wrong range is a payment
// nobody ever sees again. This sweep's own progress is an in-memory
// counter that dies with the page; the UTXOs it finds are persisted per window.
// So a deep-scan is not resumable across sessions — re-run it and the dedup makes
// the repeat cheap in storage (never in RPC). That is the trade: an ephemeral
// counter costs a re-run, a persisted range that goes wrong costs a silent gap.

import { derivePQKeysFromPRF, scanStealthPayments } from "@/lib/stealth";
import { blockAfterCalendarDay, blockForCalendarDay } from "@/lib/blockByTime";
import { hydrateStealthStore, mergeStealthUTXOsDurable, saveMetaAddress } from "@/lib/localstorage";
import { beginScan, endScan, isScanning, setScanProgress } from "@/lib/scanState";

export interface DeepScanResult {
  /** NEW UTXOs this sweep turned up (already deduped against what was stored). */
  found: number;
  fromBlock: bigint;
  latestBlock: bigint;
}

/** Thrown when a sweep is requested while any scan is already running. */
export class ScanBusyError extends Error {
  constructor() {
    super("A scan is already running — wait for it to finish before scanning by date.");
    this.name = "ScanBusyError";
  }
}

// How many calendar days ONE sweep covers, starting at the picked day.
//
// Note what this is not: a floor on how far back the picker may go. A sweep is a
// window the user places anywhere in the past — pick a day last month and it
// covers that day and the four after it. Bounding the SPAN rather than the
// lookback is what makes an old payment findable at all: "I was paid around the
// 3rd" is a 5-day question, not a 30-day one, and sweeping the whole month to
// answer it is work nobody asked for.
//
// A cost ceiling. It was set when a sweep cost ~4.5 min per day swept, which made
// 5 days (~22 min) about the most a user would sit through — progress is in-memory
// (see the module header), so a closed tab costs the whole sweep.
//
// Pacing the fan-out and curating the rpcs (stealth.ts / networks.ts) moved that to
// roughly 3 min per day swept — better, not different in kind, and close to the floor
// a free public fleet allows. The cost is not the RATE, it is the VOLUME: getLogs is
// filtered on Pimlico's SHARED verifying paymaster, so a sweep downloads every
// Pimlico customer's UserOp just to check whether it is ours. A real scan logged
// 11,733 candidates fetched across ~600k blocks to find exactly 0. At the ~34 tx/s
// public nodes tolerate, that is ~3 min per day of chain, permanently.
//
// So this ceiling is NOT a tuning problem, and whoever finds it annoying next should
// not go looking for a faster loop — that road has been walked and it ends at a wall
// of 429s. Filtering on an R1DO-owned paymaster makes the fan-out VANISH (every
// candidate would already be a Δ payment), which turns a 30-day sweep into ~11
// getLogs calls. That is the lever. Everything else is arithmetic around a constant
// that shouldn't be there.
//
// TEMP (2026-07-18): raised 5 → 30 to measure a full-month sweep on Sepolia now that
// the R1DO-owned paymaster removed the fan-out (the lever above is now real, not
// hypothetical). If a month sweeps fast, this becomes the argument to keep it raised;
// revert to 5 (or a measured value) if the month test disappoints.
export const MAX_DEEP_SCAN_DAYS = 30;

/** Thrown when the requested day hasn't happened yet. */
export class FutureDayError extends Error {
  constructor() {
    super("That day hasn't happened yet — pick a day up to today.");
    this.name = "FutureDayError";
  }
}

/** Local midnight of `d`, offset by `days`. Local because a date picker speaks
    local and the user's idea of "the 3rd" is their own calendar's. */
const midnight = (d: Date, days = 0): Date =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);

/** The calendar days one sweep from `day` actually covers, inclusive on both
    ends. Pure — no RPC — so the UI can label the button honestly ("covers Jul 1
    → Jul 5") before committing the user to 20 minutes of scanning. `to` clamps to
    today: a window overhanging the future just ends at now. */
export const scanWindowFor = (day: Date): { from: Date; to: Date } => {
  const from = midnight(day);
  const last = midnight(day, MAX_DEEP_SCAN_DAYS - 1);
  const today = midnight(new Date());
  return { from, to: last > today ? today : last };
};

/** The picker's default: a window ending today, i.e. "check the last few days".
    The common case is a cursor that started at "now" on this device a moment ago,
    not an archaeology dig — that one the user aims by hand. */
export const defaultScanDay = (): Date => midnight(new Date(), -(MAX_DEEP_SCAN_DAYS - 1));

/** Latest day the picker accepts. */
export const latestScannableDay = (): Date => midnight(new Date());

// Sweep the MAX_DEEP_SCAN_DAYS-day window starting at `since` (a picked calendar
// day), merging anything found into this device's store.
//
// Rejects outright if a scan is in flight: two scans would fight over the single
// global progress slot (the bar would jump between two unrelated ranges) and
// double the per-window fan-out the scanner's throttling is tuned for. The caller
// should also disable the entry point on isScanning/useScanning — that is the UI
// half; this guard is the half that survives a double-click.
export async function runCalendarDeepScan(
  username: string,
  prfOutput: Uint8Array,
  since: Date,
): Promise<DeepScanResult> {
  if (isScanning()) throw new ScanBusyError();
  if (since.getTime() > latestScannableDay().getTime()) throw new FutureDayError();

  beginScan();
  try {
    await hydrateStealthStore(username);
    const keys = await derivePQKeysFromPRF(prfOutput);
    saveMetaAddress(username, keys.pqMetaAddress);

    // A picked day is not an instant — these resolve the window's two ends to
    // blocks safely OUTSIDE it (timezone + human memory both slop one way; see
    // blockByTime). A window ending today resolves `toBlock` past the tip, and
    // the scanner clamps it back — so "the last 5 days" needs no special case.
    const { from, to } = scanWindowFor(since);
    const [{ block: fromBlock }, { block: toBlock }] = await Promise.all([
      blockForCalendarDay(from),
      blockAfterCalendarDay(to),
    ]);
    console.log(
      `[deepScan] Sweeping ${from.toDateString()} → ${to.toDateString()} (blocks ${fromBlock} → ${toBlock})`,
    );

    let found = 0;
    const { latestBlock } = await scanStealthPayments(
      keys.spendingPrivateKey,
      keys.viewingPrivateKey,
      keys.mlkemDecapsKey,
      fromBlock,
      // Per window: persist what it found, ignore the window end. That second
      // argument is the cursor's business, and the cursor is not ours to move.
      async (windowUtxos) => {
        found += await mergeStealthUTXOsDurable(username, windowUtxos);
      },
      setScanProgress, // same determinate bar the forward scan drives
      toBlock, //        the ceiling that makes this a window instead of a backlog
    );

    console.log(`[deepScan] ✓ Done — ${found} UTXOs found up to block ${latestBlock}`);
    return { found, fromBlock, latestBlock };
  } finally {
    endScan();
  }
}
