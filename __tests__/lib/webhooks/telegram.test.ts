import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildLoanTelegramMessage, sendTelegramMessage } from "@/lib/webhooks/telegram";
import { LoanNotificationPayload } from "@/lib/webhooks/types";

const basePayload: LoanNotificationPayload = {
  topic: "liquidation_critical",
  loanId: 7,
  borrower: "GABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
  principalStroops: 500_0000000n,
  durationDays: 14,
  interestRateBps: 900,
  collateralAsset: "XLM",
  collateralAmount: 1_000_0000000n,
  loanExplorerUrl: "https://stellar.expert/explorer/testnet/tx/def456",
  borrowerExplorerUrl: "https://stellar.expert/explorer/testnet/account/GABC",
  appUrl: "https://example.com/dashboard/admin/loans",
};

describe("buildLoanTelegramMessage", () => {
  it("includes the loan id, principal, and both links as HTML", () => {
    const message = buildLoanTelegramMessage(basePayload);
    expect(message).toContain("Loan Liquidated");
    expect(message).toContain("#7");
    expect(message).toContain("500.00 XLM");
    expect(message).toContain(basePayload.loanExplorerUrl);
    expect(message).toContain(basePayload.appUrl);
  });

  it("escapes HTML-significant characters in text content", () => {
    const message = buildLoanTelegramMessage({
      ...basePayload,
      borrower: "G<script>alert(1)</script>",
    });
    expect(message).not.toContain("<script>");
  });
});

describe("sendTelegramMessage", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn();
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("throws when no bot token is configured", async () => {
    await expect(sendTelegramMessage("12345", "hello", undefined)).rejects.toThrow(
      "TELEGRAM_BOT_TOKEN"
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("POSTs to the Telegram Bot API with the chat id and text", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true });
    await sendTelegramMessage("12345", "hello", "test-token");

    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.telegram.org/bottest-token/sendMessage",
      expect.objectContaining({ method: "POST" })
    );
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(call[1].body);
    expect(body).toMatchObject({ chat_id: "12345", text: "hello", parse_mode: "HTML" });
  });

  it("throws when Telegram responds non-OK", async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "chat not found",
    });
    await expect(sendTelegramMessage("bad-chat", "hi", "test-token")).rejects.toThrow("400");
  });
});
