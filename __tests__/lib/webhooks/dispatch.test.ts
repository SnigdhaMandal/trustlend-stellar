import { describe, it, expect, vi, beforeEach } from "vitest";

const mockListSubscriptionsForTopic = vi.fn();
vi.mock("@/lib/db/webhooks", () => ({
  listSubscriptionsForTopic: (...args: unknown[]) => mockListSubscriptionsForTopic(...args),
}));

const mockSendDiscordWebhook = vi.fn();
vi.mock("@/lib/webhooks/discord", () => ({
  buildLoanDiscordEmbed: () => ({ embeds: [] }),
  sendDiscordWebhook: (...args: unknown[]) => mockSendDiscordWebhook(...args),
}));

const mockSendTelegramMessage = vi.fn();
vi.mock("@/lib/webhooks/telegram", () => ({
  buildLoanTelegramMessage: () => "message",
  sendTelegramMessage: (...args: unknown[]) => mockSendTelegramMessage(...args),
}));

import { notifyTopic } from "@/lib/webhooks/dispatch";
import { LoanNotificationPayload } from "@/lib/webhooks/types";

const payload: LoanNotificationPayload = {
  topic: "large_loan",
  loanId: 1,
  borrower: "GABC",
  principalStroops: 1n,
  durationDays: 30,
  interestRateBps: 1000,
  collateralAsset: "XLM",
  collateralAmount: 1n,
  loanExplorerUrl: "https://example.com/tx",
  borrowerExplorerUrl: "https://example.com/account",
  appUrl: "https://example.com/app",
};

describe("notifyTopic", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an empty array when there are no subscriptions", async () => {
    mockListSubscriptionsForTopic.mockResolvedValue([]);
    const results = await notifyTopic({} as never, payload);
    expect(results).toEqual([]);
    expect(mockSendDiscordWebhook).not.toHaveBeenCalled();
  });

  it("dispatches to both discord and telegram subscriptions", async () => {
    mockListSubscriptionsForTopic.mockResolvedValue([
      { id: "sub-1", channel: "discord", target: "https://discord.example/webhook" },
      { id: "sub-2", channel: "telegram", target: "12345" },
    ]);
    mockSendDiscordWebhook.mockResolvedValue(undefined);
    mockSendTelegramMessage.mockResolvedValue(undefined);

    const results = await notifyTopic({} as never, payload);

    expect(mockSendDiscordWebhook).toHaveBeenCalledWith("https://discord.example/webhook", {
      embeds: [],
    });
    expect(mockSendTelegramMessage).toHaveBeenCalledWith("12345", "message");
    expect(results).toEqual([
      { subscriptionId: "sub-1", channel: "discord", ok: true },
      { subscriptionId: "sub-2", channel: "telegram", ok: true },
    ]);
  });

  it("isolates a failing subscription so the others still deliver", async () => {
    mockListSubscriptionsForTopic.mockResolvedValue([
      { id: "sub-1", channel: "discord", target: "https://discord.example/bad" },
      { id: "sub-2", channel: "telegram", target: "12345" },
    ]);
    mockSendDiscordWebhook.mockRejectedValue(new Error("Discord webhook responded 404"));
    mockSendTelegramMessage.mockResolvedValue(undefined);

    const results = await notifyTopic({} as never, payload);

    expect(results).toEqual([
      { subscriptionId: "sub-1", channel: "discord", ok: false, error: "Discord webhook responded 404" },
      { subscriptionId: "sub-2", channel: "telegram", ok: true },
    ]);
  });
});
