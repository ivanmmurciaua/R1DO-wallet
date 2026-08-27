/* R1DO × Railgun — PoolAdapter (main-thread PROXY).
 *
 * The Railgun engine itself lives in `./railgun.worker.ts` and runs inside a Web
 * Worker: scanning, IndexedDB writes and snarkjs proving all happen OFF the main
 * thread, so the heavy recovery rescan never freezes the UI (the mobile-freeze
 * fix). This file is the thin surface the app talks to — it forwards every call
 * to the worker over Comlink, and resolves the two things the worker cannot read
 * itself (a Worker has no window/localStorage): the active network + RPC list,
 * and a picked calendar date → block number.
 *
 * The public API is unchanged EXCEPT the former synchronous getters
 * (isEngineBooted/getPoolFees/getPoolWallet/getRelayKey/getPoolTokenBalances)
 * are now async — everything across a worker boundary is. Their few call sites
 * (all in PrivateView, all already in async flows) `await` them.
 */

import * as Comlink from "comlink";
import { NetworkName } from "@railgun-community/shared-models";

import { activeNetwork, activeRpcUrls, type NetworkId } from "@/lib/networks";
import { blockForCalendarDay } from "@/lib/blockByTime";
import type {
  PoolWorkerApi,
  PoolConfig,
  PoolWallet,
  OpenedPoolWallet,
  PoolBalances,
  TokenBuckets,
  PoolActivity,
  ShieldCall,
} from "./railgun.worker";

export type {
  PoolWallet,
  OpenedPoolWallet,
  PoolBalances,
  TokenBuckets,
  PoolActivity,
  ShieldCall,
};

// ── worker (lazy, client-only) ────────────────────────────────────────────────
// Created on first use so SSR / module import never tries to spawn a Worker
// server-side (the private world is client-only anyway).
let worker: Worker | null = null;
let api: Comlink.Remote<PoolWorkerApi> | null = null;
function getApi(): Comlink.Remote<PoolWorkerApi> {
  if (!api) {
    worker = new Worker(new URL("./railgun.worker.ts", import.meta.url), {
      type: "module",
    });
    api = Comlink.wrap<PoolWorkerApi>(worker);
  }
  return api;
}

/** Hard-stop the engine worker: terminate the thread (dropping its heavy
    IndexedDB write load + its callback stream) and reset the singletons so the
    next entry boots a fresh engine. Leaving the worker alive after the private
    view closes keeps it hammering IndexedDB during a scan, which on mobile
    serializes the whole IndexedDB backend and starves other DB opens — that is
    what left the credential store's "open" timing out and the app stuck loading.
    Committed scan data survives (IndexedDB writes are atomic); the scan resumes
    incrementally on the next boot. Synchronous + main-thread, so it works even
    when the worker is too busy to answer a Comlink call. */
export function terminateWorker(): void {
  if (worker) {
    worker.terminate();
    worker = null;
    api = null;
  }
}

// Also kill it as the page unloads (F5 / navigation): the browser tears a Worker
// down anyway, but terminating here nudges it to stop issuing new IndexedDB
// writes sooner, so the backend has less to flush and the next load's DB opens
// aren't starved. `pagehide` fires on mobile Safari where `beforeunload` doesn't.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => terminateWorker());
}

// ── config the worker can't read (window/localStorage live here) ──────────────
const RAILGUN_NETWORK: Partial<Record<NetworkId, NetworkName>> = {
  sepolia: NetworkName.EthereumSepolia,
  arbitrum: NetworkName.Arbitrum,
};
function resolveConfig(): PoolConfig {
  const id = activeNetwork().id;
  const networkName = RAILGUN_NETWORK[id];
  if (!networkName)
    throw new Error(`[pool] RAILGUN has no deployment for network "${id}"`);
  return { networkName, rpcUrls: activeRpcUrls() };
}

// ── lifecycle ─────────────────────────────────────────────────────────────────
export async function bootEngine(): Promise<void> {
  await getApi().bootEngine(resolveConfig());
}
export function isEngineBooted(): Promise<boolean> {
  return getApi().isEngineBooted();
}
export function getPoolFees(): Promise<{ shieldBps: number; unshieldBps: number }> {
  return getApi().getPoolFees();
}

// ── wallet ────────────────────────────────────────────────────────────────────
// `creationDate` (import / recovery) is resolved to a block HERE — the worker has
// no RPC-config/localStorage to run blockByTime itself — and the number is passed
// on. No date = a genuinely new 0zk (worker starts it near the tip).
export async function createPoolWallet(
  prf: Uint8Array,
  username: string,
  creationDate?: Date,
  wipeFirst?: boolean,
): Promise<OpenedPoolWallet> {
  const creationBlock = creationDate
    ? Number((await blockForCalendarDay(creationDate)).block)
    : undefined;
  return getApi().createPoolWallet(prf, username, creationBlock, wipeFirst);
}

/** Set the scan-start of a still-unscanned ("fresh") 0zk to a chosen calendar
    day — resolved to a block HERE (the worker has no blockByTime/localStorage).
    Call ONLY on a wallet createPoolWallet reported as `fresh`, and BEFORE
    startWatcher, so the first scan begins exactly at the chosen day. */
export async function setPoolScanStart(fromDate: Date): Promise<void> {
  const fromBlock = Number((await blockForCalendarDay(fromDate)).block);
  await getApi().setPoolScanStart(fromBlock);
}
export function getPoolWallet(username: string): Promise<PoolWallet | null> {
  return getApi().getPoolWallet(username);
}
export function getRelayKey(): Promise<`0x${string}` | null> {
  return getApi().getRelayKey();
}

// ── operations (tx builders) ──────────────────────────────────────────────────
export function populateShieldTx(
  amount: bigint,
): Promise<{ to: string; data: string; value: string }> {
  return getApi().populateShieldTx(amount);
}
export function populateShieldCalls(
  tokenAddress: string | null,
  amount: bigint,
): Promise<ShieldCall[]> {
  return getApi().populateShieldCalls(tokenAddress, amount);
}
export function populateTransferTx(
  toZkAddress: string,
  amount: bigint,
  onProgress?: (pct: number) => void,
  tokenAddress?: string,
) {
  return getApi().populateTransferTx(
    toZkAddress,
    amount,
    onProgress ? Comlink.proxy(onProgress) : undefined,
    tokenAddress,
  );
}
export function populateUnshieldTx(
  toAddress: string,
  amount: bigint,
  onProgress?: (pct: number) => void,
  tokenAddress?: string,
) {
  return getApi().populateUnshieldTx(
    toAddress,
    amount,
    onProgress ? Comlink.proxy(onProgress) : undefined,
    tokenAddress,
  );
}

// ── balance / activity subscriptions (worker → main via Comlink.proxy) ────────
export function onPoolBalances(cb: (b: PoolBalances) => void): void {
  void getApi().onPoolBalances(Comlink.proxy(cb));
}
export function getPoolTokenBalances(): Promise<Map<string, TokenBuckets>> {
  return getApi().getPoolTokenBalances();
}
export function onPoolTokenBalances(
  cb: (m: Map<string, TokenBuckets>) => void,
): void {
  void getApi().onPoolTokenBalances(Comlink.proxy(cb));
}
export function onPoolActivity(cb: (a: PoolActivity) => void): void {
  void getApi().onPoolActivity(Comlink.proxy(cb));
}

// ── watcher + sync ────────────────────────────────────────────────────────────
export function startWatcher(): void {
  void getApi().startWatcher();
}
export function stopWatcher(): void {
  void getApi().stopWatcher();
}
export function refreshNow(): Promise<void> {
  return getApi().refreshNow();
}
export function resyncPool(): Promise<void> {
  return getApi().resyncPool();
}

/** Recovery: reuse the loaded 0zk, move its scan-start back to `fromDate`, clear
    this network's balances and rescan to 100% (the lab path — no delete/recreate).
    The date → block resolve happens here; the heavy rescan runs in the worker so
    the UI stays alive. */
export async function recoverPoolBalances(
  prf: Uint8Array,
  username: string,
  fromDate: Date,
  onProgress?: (pct: number) => void,
): Promise<PoolWallet> {
  const fromBlock = Number((await blockForCalendarDay(fromDate)).block);
  return getApi().recoverPoolBalances(
    prf,
    username,
    fromBlock,
    onProgress ? Comlink.proxy(onProgress) : undefined,
  );
}

export async function resetPool(): Promise<void> {
  await getApi().resetPool();
}
