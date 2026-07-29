/**
 * Pure LTV/pricing helpers for the liquidation-territory sweep in
 * `lib/webhooks/event-listener.ts`. Deliberately self-contained (not shared
 * with `scripts/liquidation-keeper.ts`, which duplicates the same small
 * formula) so this feature has no import-time side effects from that CLI
 * script's `.env` loading — but it reads the same `LIQUIDATION_*` env vars
 * so operators only configure asset prices once.
 */

export interface AssetPriceEntry {
  symbol: string;
  priceUsd: number;
  decimals: number;
}

export function loadPriceTable(): Record<string, AssetPriceEntry> {
  const raw = process.env.LIQUIDATION_PRICE_TABLE_JSON;
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, AssetPriceEntry>;
  } catch (err) {
    console.warn("[webhooks] Could not parse LIQUIDATION_PRICE_TABLE_JSON — ignoring.", err);
    return {};
  }
}

export function resolveAssetPrice(
  priceTable: Record<string, AssetPriceEntry>,
  xlmPriceUsd: number,
  assetAddress: string
): AssetPriceEntry | null {
  if (assetAddress === "XLM" || assetAddress === "native") {
    return { symbol: "XLM", priceUsd: xlmPriceUsd, decimals: 7 };
  }
  return priceTable[assetAddress] ?? null;
}

/** Loan-to-value in basis points. See `scripts/liquidation-keeper.ts` for the on-chain twin of this formula. */
export function computeLtvBps(params: {
  remainingDueStroops: bigint;
  xlmPriceUsd: number;
  collateralAmount: bigint;
  collateralDecimals: number;
  collateralPriceUsd: number;
}): number {
  const debtUsd = (Number(params.remainingDueStroops) / 1e7) * params.xlmPriceUsd;
  const collateralUsd =
    (Number(params.collateralAmount) / 10 ** params.collateralDecimals) * params.collateralPriceUsd;

  if (collateralUsd <= 0) return Number.MAX_SAFE_INTEGER;
  return Math.round((debtUsd / collateralUsd) * 10_000);
}

export type HealthZone = "healthy" | "warning" | "critical";

/**
 * `critical`: at/above the contract's hard liquidation threshold.
 * `warning`: within `bufferBps` below the threshold.
 * `healthy`: everything else.
 */
export function classifyHealthZone(
  ltvBps: number,
  thresholdBps: number,
  bufferBps: number
): HealthZone {
  if (ltvBps >= thresholdBps) return "critical";
  if (ltvBps >= thresholdBps - bufferBps) return "warning";
  return "healthy";
}

/** A zone transition is alert-worthy only when it gets strictly worse. */
const ZONE_RANK: Record<HealthZone, number> = { healthy: 0, warning: 1, critical: 2 };
export function isWorseningTransition(previous: string | null, current: HealthZone): boolean {
  const prevRank = previous && previous in ZONE_RANK ? ZONE_RANK[previous as HealthZone] : -1;
  return ZONE_RANK[current] > prevRank;
}
