import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildLoanDiscordEmbed, sendDiscordWebhook } from "@/lib/webhooks/discord";
import { LoanNotificationPayload } from "@/lib/webhooks/types";

const basePayload: LoanNotificationPayload = {
  topic: "large_loan",
  loanId: 42,
  borrower: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
  principalStroops: 12_345_0000000n,
  durationDays: 30,
  interestRateBps: 1250,
  collateralAsset: "XLM",
  collateralAmount: 20_000_0000000n,
  loanExplorerUrl: "https://stellar.expert/explorer/testnet/tx/abc123",
  borrowerExplorerUrl: "https://stellar.expert/explorer/testnet/account/GABC",
  appUrl: "https://example.com/dashboard/admin/loans",
};

describe("buildLoanDiscordEmbed", () => {
  it("formats a large_loan embed with principal, borrower, rate, and links", () => {
    const { embeds } = buildLoanDiscordEmbed(basePayload);
    expect(embeds).toHaveLength(1);
    const embed = embeds[0];

    expect(embed.title).toContain("Large Loan Originated");
    expect(embed.url).toBe(basePayload.loanExplorerUrl);
    expect(embed.fields).toEqual(
      expect.arrayContaining([
        { name: "Loan", value: "#42", inline: true },
        { name: "Principal", value: "12345.00 XLM", inline: true },
        { name: "Rate", value: "12.50%", inline: true },
        { name: "Duration", value: "30 days", inline: true },
      ])
    );
  });

  it("includes LTV and threshold fields for liquidation topics", () => {
    const { embeds } = buildLoanDiscordEmbed({
      ...basePayload,
      topic: "liquidation_warning",
      ltvBps: 8700,
      thresholdBps: 9000,
    });
    expect(embeds[0].fields).toEqual(
      expect.arrayContaining([
        { name: "Loan-to-Value", value: "87.00%", inline: true },
        { name: "Liquidation Threshold", value: "90.00%", inline: true },
      ])
    );
    expect(embeds[0].color).toBe(0xe67e22);
  });

  it("uses a distinct color and title for liquidation_critical", () => {
    const { embeds } = buildLoanDiscordEmbed({ ...basePayload, topic: "liquidation_critical" });
    expect(embeds[0].title).toContain("Loan Liquidated");
    expect(embeds[0].color).toBe(0xe74c3c);
  });
});

describe("sendDiscordWebhook", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("POSTs the embed body and resolves on 2xx", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    const body = buildLoanDiscordEmbed(basePayload);
    await expect(sendDiscordWebhook("https://discord.example/webhook", body)).resolves.toBeUndefined();

    expect(global.fetch).toHaveBeenCalledWith(
      "https://discord.example/webhook",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("throws when Discord responds non-OK", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited",
    });
    const body = buildLoanDiscordEmbed(basePayload);
    await expect(sendDiscordWebhook("https://discord.example/webhook", body)).rejects.toThrow(
      "429"
    );
  });
});
