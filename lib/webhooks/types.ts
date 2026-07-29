/**
 * Shared types for the Discord/Telegram loan & liquidation webhook feature
 * (issue #108). Kept dependency-free so both server code and tests can
 * import it cheaply.
 */

export const WEBHOOK_CHANNELS = ["discord", "telegram"] as const;
export type WebhookChannel = (typeof WEBHOOK_CHANNELS)[number];

/**
 * - `large_loan`           — a new loan request at/above the size threshold.
 * - `liquidation_warning`  — an active loan's LTV crossed into the buffer
 *                            zone below the contract's dynamic liquidation
 *                            threshold (edge-triggered, not repeated).
 * - `liquidation_critical` — a loan was actually marked defaulted on-chain.
 */
export const WEBHOOK_TOPICS = [
  "large_loan",
  "liquidation_warning",
  "liquidation_critical",
] as const;
export type WebhookTopic = (typeof WEBHOOK_TOPICS)[number];

export function isWebhookChannel(value: unknown): value is WebhookChannel {
  return typeof value === "string" && (WEBHOOK_CHANNELS as readonly string[]).includes(value);
}

export function isWebhookTopic(value: unknown): value is WebhookTopic {
  return typeof value === "string" && (WEBHOOK_TOPICS as readonly string[]).includes(value);
}

export interface WebhookSubscription {
  id: string;
  label: string | null;
  channel: WebhookChannel;
  target: string;
  topics: WebhookTopic[];
  minLoanAmountStroops: string | null;
  enabled: boolean;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface WebhookSubscriptionInput {
  label?: string | null;
  channel: WebhookChannel;
  target: string;
  topics: WebhookTopic[];
  minLoanAmountStroops?: string | null;
  enabled?: boolean;
}

/** Everything a message formatter needs to render a loan/liquidation alert. */
export interface LoanNotificationPayload {
  topic: WebhookTopic;
  loanId: number;
  borrower: string;
  /** Principal in stroops (1 XLM = 10_000_000 stroops). */
  principalStroops: bigint;
  durationDays: number;
  interestRateBps: number;
  collateralAsset: string;
  collateralAmount: bigint;
  /** Loan-to-value in basis points, if known (liquidation topics only). */
  ltvBps?: number;
  /** The contract's dynamic liquidation threshold, in bps. */
  thresholdBps?: number;
  loanExplorerUrl: string;
  borrowerExplorerUrl: string;
  appUrl: string;
}
