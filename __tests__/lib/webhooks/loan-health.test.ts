import { describe, it, expect } from "vitest";
import {
  classifyHealthZone,
  computeLtvBps,
  isWorseningTransition,
  resolveAssetPrice,
} from "@/lib/webhooks/loan-health";

describe("computeLtvBps", () => {
  it("computes LTV in basis points from debt/collateral USD values", () => {
    // 1000 XLM debt @ $0.12 = $120; 2000 units collateral (7 decimals) @ $0.10 = $0.00002
    // Use simpler round numbers instead:
    const ltv = computeLtvBps({
      remainingDueStroops: 1_000_0000000n, // 1000 XLM
      xlmPriceUsd: 0.1, // $100 debt
      collateralAmount: 2_000_0000000n, // 2000 units, 7 decimals
      collateralDecimals: 7,
      collateralPriceUsd: 0.1, // $200 collateral
    });
    // debt $100 / collateral $200 = 0.5 => 5000 bps
    expect(ltv).toBe(5000);
  });

  it("returns MAX_SAFE_INTEGER when collateral value is zero", () => {
    const ltv = computeLtvBps({
      remainingDueStroops: 100n,
      xlmPriceUsd: 0.1,
      collateralAmount: 0n,
      collateralDecimals: 7,
      collateralPriceUsd: 0.1,
    });
    expect(ltv).toBe(Number.MAX_SAFE_INTEGER);
  });
});

describe("classifyHealthZone", () => {
  it("is healthy when well below threshold", () => {
    expect(classifyHealthZone(5000, 9000, 500)).toBe("healthy");
  });

  it("is warning within the buffer below threshold", () => {
    expect(classifyHealthZone(8600, 9000, 500)).toBe("warning");
  });

  it("is critical at or above threshold", () => {
    expect(classifyHealthZone(9000, 9000, 500)).toBe("critical");
    expect(classifyHealthZone(9500, 9000, 500)).toBe("critical");
  });
});

describe("isWorseningTransition", () => {
  it("is true going from null (never scanned) to warning", () => {
    expect(isWorseningTransition(null, "warning")).toBe(true);
  });

  it("is true going from healthy to warning", () => {
    expect(isWorseningTransition("healthy", "warning")).toBe(true);
  });

  it("is false staying in warning", () => {
    expect(isWorseningTransition("warning", "warning")).toBe(false);
  });

  it("is false recovering from critical to warning", () => {
    expect(isWorseningTransition("critical", "warning")).toBe(false);
  });
});

describe("resolveAssetPrice", () => {
  it("resolves XLM from the xlmPriceUsd param regardless of table", () => {
    const price = resolveAssetPrice({}, 0.12, "XLM");
    expect(price).toEqual({ symbol: "XLM", priceUsd: 0.12, decimals: 7 });
  });

  it("resolves a configured asset from the price table", () => {
    const table = { GABC: { symbol: "USDC", priceUsd: 1, decimals: 7 } };
    expect(resolveAssetPrice(table, 0.12, "GABC")).toEqual(table.GABC);
  });

  it("returns null for an unconfigured asset", () => {
    expect(resolveAssetPrice({}, 0.12, "GUNKNOWN")).toBeNull();
  });
});
