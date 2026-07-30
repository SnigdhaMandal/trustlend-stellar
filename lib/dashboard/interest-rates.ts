// ─── Interest Rate Model utilities ───────────────────────────────────────────
// Pure, dependency-free module for computing fixed/floating interest rates,
// switch fees, cooldowns, and rate recalculations.
//
// Interest Rate Models:
//   • Fixed  — locked at loan creation based on pool utilization snapshot
//   • Floating — dynamically updated: baseRate + (utilization × slope)

// ─── Constants ───────────────────────────────────────────────────────────────

/** Base rate for the floating model in basis-points (5%). */
export const FLOATING_BASE_RATE_BPS = 500;

/** Slope for the floating utilization curve in basis-points (20% at 100% utilization). */
export const FLOATING_SLOPE_BPS = 2000;

/** Fee charged when switching rate models, in bps of remaining debt (0.5%). */
export const RATE_SWITCH_FEE_BPS = 50;

/** Cooldown between rate model switches in seconds (24 hours). */
export const RATE_SWITCH_COOLDOWN_SECS = 86_400;

/** Minimum floating rate — floor to prevent zero-rate loans. */
export const MIN_FLOATING_RATE_BPS = 200;

/** Maximum floating rate — ceiling to cap extreme utilization scenarios. */
export const MAX_FLOATING_RATE_BPS = 5000;

// ─── Types ───────────────────────────────────────────────────────────────────

export type InterestRateModel = "Fixed" | "Floating";

export interface FloatingRateParams {
  /** Total amount currently borrowed from the pool. */
  totalBorrowed: number;
  /** Total liquidity available in the pool (borrowed + idle). */
  totalLiquidity: number;
  /** Override base rate in bps (defaults to FLOATING_BASE_RATE_BPS). */
  baseRateBps?: number;
  /** Override slope in bps (defaults to FLOATING_SLOPE_BPS). */
  slopeBps?: number;
}

export interface RemainingInterestParams {
  /** Principal still outstanding in stroops. */
  remainingPrincipalStroops: bigint;
  /** New interest rate in basis-points. */
  newRateBps: number;
  /** Remaining days until loan maturity. */
  remainingDays: number;
}

// ─── Rate Computation ────────────────────────────────────────────────────────

/**
 * Compute the pool utilization ratio (0..1).
 * Returns 0 if totalLiquidity is zero or negative.
 */
export function computeUtilization(totalBorrowed: number, totalLiquidity: number): number {
  if (totalLiquidity <= 0) return 0;
  return Math.min(1, Math.max(0, totalBorrowed / totalLiquidity));
}

/**
 * Compute the floating interest rate in basis-points based on pool utilization.
 *
 * Formula: baseRate + floor(utilization × slope)
 * Clamped to [MIN_FLOATING_RATE_BPS, MAX_FLOATING_RATE_BPS].
 */
export function computeFloatingRate(params: FloatingRateParams): number {
  const baseRate = params.baseRateBps ?? FLOATING_BASE_RATE_BPS;
  const slope = params.slopeBps ?? FLOATING_SLOPE_BPS;
  const utilization = computeUtilization(params.totalBorrowed, params.totalLiquidity);

  const rawRate = baseRate + Math.floor(utilization * slope);
  return Math.min(MAX_FLOATING_RATE_BPS, Math.max(MIN_FLOATING_RATE_BPS, rawRate));
}

/**
 * Compute the fixed rate by locking in the rate from average utilization over a window.
 *
 * Takes the average utilization (pre-computed by the caller) and runs the same
 * utilization curve, then adds a small premium (50 bps) for the predictability guarantee.
 */
export function computeFixedRate(
  avgUtilization: number,
  baseRateBps: number = FLOATING_BASE_RATE_BPS,
  slopeBps: number = FLOATING_SLOPE_BPS,
): number {
  const clampedUtil = Math.min(1, Math.max(0, avgUtilization));
  const baseFloating = baseRateBps + Math.floor(clampedUtil * slopeBps);
  // Fixed premium: 50 bps for predictability
  const fixedPremium = 50;
  const rawRate = baseFloating + fixedPremium;
  return Math.min(MAX_FLOATING_RATE_BPS, Math.max(MIN_FLOATING_RATE_BPS, rawRate));
}

// ─── JumpRateModel (matches on-chain pooled_lending contract) ──────────────

export interface JumpRateParams {
  totalBorrowed: bigint;
  totalSupply: bigint;
  baseRateBps: number;
  multiplierPerSlopeBps: number;
  jumpMultiplierBps: number;
  kinkBps: number;
  reserveFactorBps: number;
}

const MAX_BPS = 10_000;

/**
 * Compute utilization in basis points (0-10000).
 * Returns 0 if total_supply is zero or negative.
 */
export function computeUtilizationBps(totalBorrowed: bigint, totalSupply: bigint): number {
  if (totalSupply <= 0n || totalBorrowed <= 0n) return 0;
  const util = Number((totalBorrowed * BigInt(MAX_BPS)) / totalSupply);
  return Math.min(MAX_BPS, Math.max(0, util));
}

/**
 * Compute the borrow APY in basis points using the JumpRateModel.
 *
 * Below kink:  baseRate + (utilization / kink) * multiplier
 * Above kink:  baseRate + multiplier + ((utilization - kink) / (10000 - kink)) * jumpMultiplier
 */
export function computeJumpRateBorrowApy(params: JumpRateParams): number {
  const utilBps = computeUtilizationBps(params.totalBorrowed, params.totalSupply);
  if (utilBps === 0) return params.baseRateBps;

  if (utilBps <= params.kinkBps) {
    const slopeComponent = Math.floor((utilBps * params.multiplierPerSlopeBps) / params.kinkBps);
    return params.baseRateBps + slopeComponent;
  }

  const excess = utilBps - params.kinkBps;
  const denominator = MAX_BPS - params.kinkBps;
  const jumpComponent = Math.floor((excess * params.jumpMultiplierBps) / denominator);
  return params.baseRateBps + params.multiplierPerSlopeBps + jumpComponent;
}

/**
 * Compute the supply APY in basis points using the JumpRateModel.
 *
 * supplyRate = borrowRate * utilization * (1 - reserveFactor)
 */
export function computeJumpRateSupplyApy(params: JumpRateParams): number {
  const utilBps = computeUtilizationBps(params.totalBorrowed, params.totalSupply);
  if (utilBps === 0) return 0;

  const borrowApy = computeJumpRateBorrowApy(params);
  if (borrowApy === 0) return 0;

  const rfAdjustment = MAX_BPS - params.reserveFactorBps;
  return Math.floor((borrowApy * utilBps * rfAdjustment) / MAX_BPS / MAX_BPS);
}

// ─── Switch Logic ────────────────────────────────────────────────────────────

/**
 * Calculate the fee for switching rate models.
 * Fee = 0.5% (RATE_SWITCH_FEE_BPS / 10_000) of remaining debt.
 */
export function calculateSwitchFee(remainingDueStroops: bigint): bigint {
  if (remainingDueStroops <= 0n) return 0n;
  return (remainingDueStroops * BigInt(RATE_SWITCH_FEE_BPS)) / 10_000n;
}

/**
 * Check if a rate model switch is allowed (24h cooldown).
 *
 * @param lastSwitchTimestamp  Unix timestamp (seconds) of the last switch, or 0 if never switched.
 * @param nowTimestamp         Current Unix timestamp (seconds).
 * @returns Object with `allowed` boolean and `remainingSeconds` until next allowed switch.
 */
export function canSwitchRateModel(
  lastSwitchTimestamp: number,
  nowTimestamp: number,
): { allowed: boolean; remainingSeconds: number } {
  if (lastSwitchTimestamp === 0) {
    return { allowed: true, remainingSeconds: 0 };
  }

  const elapsed = nowTimestamp - lastSwitchTimestamp;
  if (elapsed >= RATE_SWITCH_COOLDOWN_SECS) {
    return { allowed: true, remainingSeconds: 0 };
  }

  return {
    allowed: false,
    remainingSeconds: RATE_SWITCH_COOLDOWN_SECS - elapsed,
  };
}

// ─── Interest Recalculation ──────────────────────────────────────────────────

/**
 * Recalculate remaining interest for a loan when the rate changes.
 *
 * Formula: remainingPrincipal × newRateBps × remainingDays / (10_000 × 365)
 *
 * Returns the new interest amount in stroops.
 */
export function recalculateRemainingInterest(params: RemainingInterestParams): bigint {
  const { remainingPrincipalStroops, newRateBps, remainingDays } = params;

  if (remainingPrincipalStroops <= 0n || newRateBps <= 0 || remainingDays <= 0) {
    return 0n;
  }

  return (
    (remainingPrincipalStroops * BigInt(newRateBps) * BigInt(remainingDays)) /
    (10_000n * 365n)
  );
}

// ─── Display Helpers ─────────────────────────────────────────────────────────

/** Human-readable label for a rate model. */
export function formatRateModelLabel(model: InterestRateModel): string {
  switch (model) {
    case "Fixed":
      return "Fixed Rate";
    case "Floating":
      return "Floating Rate";
  }
}

/** Display colour for a rate model badge. */
export function getRateModelColor(model: InterestRateModel): string {
  switch (model) {
    case "Fixed":
      return "#7e2fd0"; // project purple
    case "Floating":
      return "#22cf9d"; // project teal
  }
}

/** Format basis-points as a human-readable percentage string. */
export function bpsToPercent(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}
