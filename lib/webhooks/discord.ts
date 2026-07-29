/**
 * Discord embed formatting + delivery for loan/liquidation alerts (issue #108).
 * Upgrades the plain-text `content` posts in `scripts/liquidation-keeper.ts`
 * to real embeds with structured fields.
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

const TOPIC_META: Record<
  LoanNotificationPayload["topic"],
  { title: string; color: number; badge: string }
> = {
  large_loan: { title: "Large Loan Originated", color: 0xf1c40f, badge: "💰" },
  liquidation_warning: { title: "Loan Entering Liquidation Territory", color: 0xe67e22, badge: "⚠️" },
  liquidation_critical: { title: "Loan Liquidated", color: 0xe74c3c, badge: "🚨" },
};

export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title: string;
  description: string;
  color: number;
  url?: string;
  fields: DiscordEmbedField[];
  footer: { text: string };
  timestamp: string;
}

export function buildLoanDiscordEmbed(payload: LoanNotificationPayload): { embeds: DiscordEmbed[] } {
  const meta = TOPIC_META[payload.topic];

  const fields: DiscordEmbedField[] = [
    { name: "Loan", value: `#${payload.loanId}`, inline: true },
    { name: "Principal", value: formatXlm(payload.principalStroops), inline: true },
    { name: "Borrower", value: `[${shortAddress(payload.borrower)}](${payload.borrowerExplorerUrl})`, inline: true },
    { name: "Rate", value: `${(payload.interestRateBps / 100).toFixed(2)}%`, inline: true },
    { name: "Duration", value: `${payload.durationDays} days`, inline: true },
  ];

  if (payload.ltvBps !== undefined) {
    fields.push({ name: "Loan-to-Value", value: `${(payload.ltvBps / 100).toFixed(2)}%`, inline: true });
  }
  if (payload.thresholdBps !== undefined) {
    fields.push({
      name: "Liquidation Threshold",
      value: `${(payload.thresholdBps / 100).toFixed(2)}%`,
      inline: true,
    });
  }

  fields.push({ name: "Details", value: `[Open in TrustLend](${payload.appUrl})`, inline: false });

  return {
    embeds: [
      {
        title: `${meta.badge} ${meta.title}`,
        description: buildDescription(payload),
        color: meta.color,
        url: payload.loanExplorerUrl,
        fields,
        footer: { text: "TrustLend" },
        timestamp: new Date().toISOString(),
      },
    ],
  };
}

function buildDescription(payload: LoanNotificationPayload): string {
  switch (payload.topic) {
    case "large_loan":
      return `A loan of **${formatXlm(payload.principalStroops)}** was just requested.`;
    case "liquidation_warning":
      return `This loan's health factor has dropped close to the liquidation threshold. It may be liquidated soon if collateral value doesn't recover or the debt isn't repaid.`;
    case "liquidation_critical":
      return `This loan has been marked defaulted and liquidated on-chain.`;
    default:
      return "";
  }
}

/** POST an embed payload to a Discord incoming-webhook URL. Throws on non-OK. */
export async function sendDiscordWebhook(
  webhookUrl: string,
  body: { embeds: DiscordEmbed[] }
): Promise<void> {
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Discord webhook responded ${res.status}: ${await res.text().catch(() => "")}`);
  }
}
