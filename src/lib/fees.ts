/*
  fees.ts — operator fee model (R1DO/delta1), single source of truth.

  Key separation: the UserOp gas is sponsored by Pimlico (gasless for the user).
  This is NOT the gas — it's what the operator charges (its revenue), collected
  IN-ASSET (in the asset being moved) and always SKIMMED ("what you type leaves
  you; the destination receives amount − fee; the fee goes to r1do-wallet").

  Single formula:  fee = max(nominalMargin, gasFloor)
    nominalMargin:  send → 0.1% of amount · shield/unshield → flat per asset
    gasFloor:       the REAL gas of the UserOp (read from the safeOperation
                    pre-submit), expressed in asset units. It only "bites" on
                    small amounts (dust send, where 0.1% → ~0); on normal amounts
                    the margin wins. Covers the gas the operator fronts to Pimlico.

  The gas is estimated in ETH. For a pure-ETH op there's nothing to convert (gas
  and fee in the same currency), so the oracle is NOT called. Only when a STABLE
  is involved do we need the ETH/USD price to express the gasFloor in stable
  units → that's why the oracle is LAZY: it's queried only in the non-ETH branch
  (see quoteFee).

  Railgun's 0.25% on shield/unshield is a SEPARATE charge the user already pays;
  it's not part of this module and isn't modelled here.

  SDK-free / stateless: pure arithmetic so it's trivial to reason about and test.
*/
import type { Asset } from "./assets";
import { ETH_USD_DECIMALS, getEthUsd } from "./oracle";

export type FeeOp = "send" | "shield" | "unshield" | "receive";

/** Send margin in basis points (10 bps = 0.1%). No cap for now. */
export const SEND_FEE_BPS = 10n;
const BPS_DENOM = 10_000n;

/** Shadow-world (Railgun) fee = the REAL gas × a markup. Cost-plus: it tracks the
 *  gas the operator fronts to Pimlico, NOT the value moved (no flat, no %-of-value).
 *  A shield of 10 or 10 000 USDC pays ~the same — the gas is the same.
 *  · shield  ×1.15 (fine — entering the pool)
 *  · unshield ×1.30 (gross — leaving; covers the heavier fan-out)
 *  (transfers 0zk→0zk are deliberately FREE — subsidised, not fee'd here.) */
const SHIELD_MARKUP_BPS = 11_500n; // ×1.15
const UNSHIELD_MARKUP_BPS = 13_000n; // ×1.30

const ONE_ETH_WEI = 10n ** 18n;

export type FeeQuote = {
  /** Total fee to charge, in the asset's smallest units. */
  fee: bigint;
  /** Nominal margin component (0.1% or flat), before the max with the floor. */
  margin: bigint;
  /** Gas-coverage component, already in asset units. */
  floor: bigint;
  /** Which of the two won (transparency / UI / tests). */
  boundBy: "margin" | "floor";
  /** Whether the ETH/USD price was needed to resolve the floor. */
  usedOracle: boolean;
};

/** Send margin (0.1% of amount). Shield/unshield no longer use a nominal margin —
 *  they're pure gas × markup (see computeFee) — so this only serves send/receive. */
function nominalMargin(op: FeeOp, amount: bigint): bigint {
  return op === "send" ? (amount * SEND_FEE_BPS) / BPS_DENOM : 0n;
}

/**
 * Convert the gas (in ETH wei) to the fee asset's units.
 *  - NATIVE asset (ETH): gas is ALREADY in its unit (wei) → direct, no oracle.
 *  - STABLE: gas(ETH) × price(ETH/USD) → USD ≈ stable units (≈$1). Requires
 *    `ethUsd` (price scaled to ETH_USD_DECIMALS).
 */
function gasFloorInAsset(gasWei: bigint, asset: Asset, ethUsd?: bigint): bigint {
  if (gasWei <= 0n) return 0n;
  if (asset.kind === "native") return gasWei; // native ETH: wei == native unit (18 dec)
  if (ethUsd === undefined || ethUsd <= 0n) {
    throw new Error("gasFloorInAsset: ethUsd required for a non-native asset (stable)");
  }
  // gasWei (1e18 ETH) × ethUsd (1e<ETH_USD_DECIMALS> USD) → USD, then down to the
  // stable's decimals. All integer math, lossless except the final truncation.
  const assetScale = 10n ** BigInt(asset.decimals);
  const usdScale = 10n ** BigInt(ETH_USD_DECIMALS);
  return (gasWei * ethUsd * assetScale) / (ONE_ETH_WEI * usdScale);
}

/**
 * PURE fee computation. `gasWei` = the UserOp's real gas (from the safeOperation);
 * `ethUsd` is only required when `asset` is non-native. Does no I/O — the caller
 * decides whether to query the oracle (see quoteFee for the lazy version).
 */
export function computeFee(args: {
  op: FeeOp;
  asset: Asset;
  amount: bigint;
  gasWei: bigint;
  ethUsd?: bigint;
}): FeeQuote {
  const { op, asset, amount, gasWei, ethUsd } = args;

  if (op === "receive") {
    return { fee: 0n, margin: 0n, floor: 0n, boundBy: "margin", usedOracle: false };
  }

  const needsOracle = asset.kind !== "native" && gasWei > 0n;
  const gasInAsset = gasFloorInAsset(gasWei, asset, ethUsd);

  // Shadow ops (shield/unshield): cost-plus — fee = gas × markup. No flat, no
  // %-of-value. gasWei 0 (no estimate yet) → fee 0; the caller MUST read real gas.
  if (op === "shield" || op === "unshield") {
    const markup = op === "shield" ? SHIELD_MARKUP_BPS : UNSHIELD_MARKUP_BPS;
    const fee = (gasInAsset * markup) / BPS_DENOM;
    return { fee, margin: 0n, floor: gasInAsset, boundBy: "floor", usedOracle: needsOracle };
  }

  // send: fee = max(0.1% × amount, gas). The margin is the profit and already
  // covers the gas when it exceeds it; the gas only floors small (dust) amounts.
  const margin = nominalMargin(op, amount);
  const boundBy = gasInAsset > margin ? "floor" : "margin";
  return {
    fee: boundBy === "floor" ? gasInAsset : margin,
    margin,
    floor: gasInAsset,
    boundBy,
    usedOracle: needsOracle,
  };
}

/**
 * Lazy version: resolves the oracle (Chainlink ETH/USD on mainnet, lib/oracle.ts)
 * ONLY when the asset is non-native, then delegates to computeFee. This is the
 * recommended entry point for call sites.
 */
export async function quoteFee(args: {
  op: FeeOp;
  asset: Asset;
  amount: bigint;
  gasWei: bigint;
}): Promise<FeeQuote> {
  const { op, asset } = args;
  // Pure ETH or receive → the oracle is never touched.
  const ethUsd =
    op !== "receive" && asset.kind !== "native" && args.gasWei > 0n
      ? await getEthUsd()
      : undefined;
  return computeFee({ ...args, ethUsd });
}
