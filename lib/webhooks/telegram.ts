/**
 * Telegram formatting + delivery for loan/liquidation alerts (issue #108).
 * Telegram has no embed concept, so this builds an HTML-formatted message
 * (bold/links) that approximates the same structured content as the Discord
 * embed in `lib/webhooks/discord.ts`.
 */

import { LoanNotificationPayload } from "@/lib/webhooks/types";

const STROOPS_PER_XLM = 10_000_000n;

function formatXlm(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_XLM;
  const frac = stroops % STROOPS_PER_XLM;
  const fracStr = (frac < 0n ? -frac : frac).toString().padStart(7, "0").slice(0, 2);
  return `${whole}.${fracStr} XLM`;
}

function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const TOPIC_META: Record<LoanNotificationPayload["topic"], { title: string; badge: string }> = {
  large_loan: { title: "Large Loan Originated", badge: "💰" },
  liquidation_warning: { title: "Loan Entering Liquidation Territory", badge: "⚠️" },
  liquidation_critical: { title: "Loan Liquidated", badge: "🚨" },
};

export function buildLoanTelegramMessage(payload: LoanNotificationPayload): string {
  const meta = TOPIC_META[payload.topic];

  const lines = [
    `${meta.badge} <b>${escapeHtml(meta.title)}</b>`,
    "",
    `Loan: <b>#${payload.loanId}</b>`,
    `Principal: <b>${formatXlm(payload.principalStroops)}</b>`,
    `Borrower: <a href="${payload.borrowerExplorerUrl}">${escapeHtml(shortAddress(payload.borrower))}</a>`,
    `Rate: ${(payload.interestRateBps / 100).toFixed(2)}%  •  Duration: ${payload.durationDays} days`,
  ];

  if (payload.ltvBps !== undefined) {
    lines.push(`Loan-to-Value: <b>${(payload.ltvBps / 100).toFixed(2)}%</b>`);
  }
  if (payload.thresholdBps !== undefined) {
    lines.push(`Liquidation Threshold: ${(payload.thresholdBps / 100).toFixed(2)}%`);
  }

  lines.push("", `<a href="${payload.loanExplorerUrl}">View on-chain</a> · <a href="${payload.appUrl}">Open in TrustLend</a>`);

  return lines.join("\n");
}

/**
 * Send a message via the Telegram Bot API. `chatId` is the subscription's
 * `target` (a numeric chat/channel id, as text). Requires `TELEGRAM_BOT_TOKEN`
 * unless `botToken` is passed explicitly (used by tests).
 */
export async function sendTelegramMessage(
  chatId: string,
  text: string,
  botToken: string | undefined = process.env.TELEGRAM_BOT_TOKEN
): Promise<void> {
  if (!botToken) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured — cannot send Telegram alert");
  }

  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });

  if (!res.ok) {
    throw new Error(`Telegram sendMessage responded ${res.status}: ${await res.text().catch(() => "")}`);
  }
}
