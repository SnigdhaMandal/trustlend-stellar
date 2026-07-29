/**
 * Soroban event listener for the Discord/Telegram webhook feature (issue #108).
 *
 * Two complementary mechanisms, both driven by `runWebhookListenerOnce`:
 *
 * 1. Contract-event scan — polls the Lending contract via Soroban RPC
 *    `getEvents` from a persisted ledger cursor (`webhook_listener_state`),
 *    and alerts on `(loan, request)` events at/above the large-loan
 *    threshold and `(loan, default)` events (a loan actually liquidated).
 * 2. Loan-health sweep — since "falling into liquidation territory" isn't
 *    itself an emitted event, this bounded-size sweep re-evaluates the most
 *    recent Active loans' LTV against the contract's dynamic liquidation
 *    threshold (same formula as `scripts/liquidation-keeper.ts`) and alerts
 *    only on the edge transition into the warning zone.
 *
 * Designed to run either as a single cron-triggered pass
 * (`/api/cron/webhook-listener`) or in a loop (`scripts/webhook-listener.ts
 * --interval=N`).
 */

import { rpc, scValToNative } from "@stellar/stellar-sdk";
import { SupabaseClient } from "@supabase/supabase-js";
import { addr, invokeReadOnly, u32 } from "@/lib/stellar/server-contract";
import {
  getListenerLastLedger,
  getLoanHealthZone,
  recordNotification,
  setListenerLastLedger,
  setLoanHealthZone,
  wasAlreadyNotified,
} from "@/lib/db/webhooks";
import { notifyTopic } from "@/lib/webhooks/dispatch";
import { LoanNotificationPayload } from "@/lib/webhooks/types";
import {
  classifyHealthZone,
  computeLtvBps,
  isWorseningTransition,
  loadPriceTable,
  resolveAssetPrice,
} from "@/lib/webhooks/loan-health";

const SOROBAN_RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ?? "https://soroban-testnet.stellar.org";

// Hard cap on getEvents pages per run so a serverless invocation can't run
// away — the cursor persists, so a backlog is simply drained over more runs.
const MAX_PAGES_PER_RUN = 10;

// ─── Config ───────────────────────────────────────────────────────────────────

interface ListenerConfig {
  lendingContractId: string;
  reputationContractId: string;
  adminAddress: string;
  largeLoanThresholdStroops: bigint;
  warningBufferBps: number;
  healthSweepLimit: number;
  xlmPriceUsd: number;
  defaultAssetVolatilityBps: number;
}

function loadListenerConfig(): ListenerConfig {
  const thresholdXlm = Number(process.env.WEBHOOK_LARGE_LOAN_THRESHOLD_XLM ?? 10_000);
  return {
    lendingContractId: process.env.NEXT_PUBLIC_LENDING_CONTRACT_ID ?? "",
    reputationContractId: process.env.NEXT_PUBLIC_REPUTATION_CONTRACT_ID ?? "",
    adminAddress: process.env.NEXT_PUBLIC_ADMIN_ADDRESS ?? "",
    largeLoanThresholdStroops: BigInt(Math.round(thresholdXlm * 1e7)),
    warningBufferBps: Number(process.env.WEBHOOK_LIQUIDATION_WARNING_BUFFER_BPS ?? 500),
    healthSweepLimit: Number(process.env.WEBHOOK_HEALTH_SWEEP_LIMIT ?? 50),
    xlmPriceUsd: Number(process.env.LIQUIDATION_XLM_PRICE_USD ?? 0.12),
    defaultAssetVolatilityBps: Number(process.env.LIQUIDATION_DEFAULT_ASSET_VOLATILITY_BPS ?? 2000),
  };
}

// ─── Explorer / app links ─────────────────────────────────────────────────────

function explorerNetwork(): string {
  const n = (process.env.NEXT_PUBLIC_STELLAR_NETWORK ?? "testnet").toLowerCase();
  return n === "public" || n === "mainnet" ? "public" : "testnet";
}
function txExplorerUrl(hash: string): string {
  return `https://stellar.expert/explorer/${explorerNetwork()}/tx/${hash}`;
}
function accountExplorerUrl(address: string): string {
  return `https://stellar.expert/explorer/${explorerNetwork()}/account/${address}`;
}
function appLoansUrl(): string {
  const base = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
  return `${base}/dashboard/admin/loans`;
}

// ─── Decoding helpers ─────────────────────────────────────────────────────────

function toBigInt(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  if (typeof v === "string") return BigInt(v);
  return 0n;
}
function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") return parseInt(v, 10) || 0;
  return 0;
}
function extractEnumVariant(val: unknown): string {
  if (val && typeof val === "object") return Object.keys(val as object)[0];
  return String(val);
}

// ─── On-chain reads ───────────────────────────────────────────────────────────

interface OnchainLoan {
  id: number;
  borrower: string;
  status: string;
  remainingDue: bigint;
  durationDays: number;
  interestRateBps: number;
  collateralAsset: string;
  collateralAmount: bigint;
}

async function getOnchainLoan(cfg: ListenerConfig, loanId: number): Promise<OnchainLoan | null> {
  try {
    const raw = (await invokeReadOnly({
      contractId: cfg.lendingContractId,
      method: "get_loan",
      args: [u32(loanId)],
      sourceAddress: cfg.adminAddress,
    })) as Record<string, unknown>;

    return {
      id: Number(raw.id),
      borrower: raw.borrower as string,
      status: extractEnumVariant(raw.status),
      remainingDue: toBigInt(raw.remaining_due),
      durationDays: toNumber(raw.duration_days),
      interestRateBps: toNumber(raw.interest_rate_bps),
      collateralAsset: raw.collateral_asset as string,
      collateralAmount: toBigInt(raw.collateral_amount),
    };
  } catch (err) {
    console.warn(`[webhook-listener] Failed to read on-chain loan #${loanId}:`, err);
    return null;
  }
}

async function getLoanCount(cfg: ListenerConfig): Promise<number> {
  const result = await invokeReadOnly({
    contractId: cfg.lendingContractId,
    method: "get_loan_count",
    args: [],
    sourceAddress: cfg.adminAddress,
  });
  return Number(result);
}

async function getReputationScore(cfg: ListenerConfig, borrower: string): Promise<number> {
  const result = await invokeReadOnly({
    contractId: cfg.reputationContractId,
    method: "get_reputation_score",
    args: [addr(borrower)],
    sourceAddress: cfg.adminAddress,
  });
  return Number(result);
}

async function getLiquidationThresholdBps(
  cfg: ListenerConfig,
  reputationScore: number,
  assetVolatilityBps: number
): Promise<number> {
  const result = await invokeReadOnly({
    contractId: cfg.lendingContractId,
    method: "calculate_liquidation_threshold",
    args: [u32(reputationScore), u32(assetVolatilityBps)],
    sourceAddress: cfg.adminAddress,
  });
  return Number(result);
}

// ─── Summary ──────────────────────────────────────────────────────────────────

export interface ListenerSummary {
  scannedEvents: number;
  largeLoanAlerts: number;
  liquidationCriticalAlerts: number;
  liquidationWarningAlerts: number;
  healthSweepScanned: number;
  errors: number;
}

function emptySummary(): ListenerSummary {
  return {
    scannedEvents: 0,
    largeLoanAlerts: 0,
    liquidationCriticalAlerts: 0,
    liquidationWarningAlerts: 0,
    healthSweepScanned: 0,
    errors: 0,
  };
}

// ─── Main entry point ─────────────────────────────────────────────────────────

export async function runWebhookListenerOnce(supabase: SupabaseClient): Promise<ListenerSummary> {
  const cfg = loadListenerConfig();
  const summary = emptySummary();

  if (!cfg.lendingContractId || !cfg.reputationContractId || !cfg.adminAddress) {
    throw new Error(
      "Missing NEXT_PUBLIC_LENDING_CONTRACT_ID / NEXT_PUBLIC_REPUTATION_CONTRACT_ID / NEXT_PUBLIC_ADMIN_ADDRESS"
    );
  }

  const server = new rpc.Server(SOROBAN_RPC_URL, {
    allowHttp: SOROBAN_RPC_URL.startsWith("http://"),
  });

  try {
    await scanContractEvents(server, supabase, cfg, summary);
  } catch (err) {
    summary.errors++;
    console.error("[webhook-listener] Event scan failed:", err);
  }

  try {
    await sweepLoanHealth(cfg, supabase, summary);
  } catch (err) {
    summary.errors++;
    console.error("[webhook-listener] Health sweep failed:", err);
  }

  return summary;
}

// ─── 1. Contract-event scan ───────────────────────────────────────────────────

async function scanContractEvents(
  server: rpc.Server,
  supabase: SupabaseClient,
  cfg: ListenerConfig,
  summary: ListenerSummary
): Promise<void> {
  const health = await server.getHealth();
  const stored = await getListenerLastLedger(supabase);
  const startLedger = Math.max(stored + 1, health.oldestLedger);

  if (startLedger > health.latestLedger) return; // nothing new since last run

  let cursor: string | undefined;
  let pagesLeft = MAX_PAGES_PER_RUN;

  for (;;) {
    const response = cursor
      ? await server.getEvents({
          filters: [{ type: "contract", contractIds: [cfg.lendingContractId] }],
          cursor,
          limit: 100,
        })
      : await server.getEvents({
          filters: [{ type: "contract", contractIds: [cfg.lendingContractId] }],
          startLedger,
          limit: 100,
        });

    summary.scannedEvents += response.events.length;

    for (const event of response.events) {
      await handleLendingEvent(event, supabase, cfg, summary);
    }

    pagesLeft--;
    if (response.events.length < 100 || pagesLeft <= 0) break;
    cursor = response.cursor;
  }

  await setListenerLastLedger(supabase, health.latestLedger);
}

async function handleLendingEvent(
  event: rpc.Api.EventResponse,
  supabase: SupabaseClient,
  cfg: ListenerConfig,
  summary: ListenerSummary
): Promise<void> {
  const topic = event.topic.map((t) => scValToNative(t) as unknown as string);
  if (topic[0] !== "loan") return;

  const rawValue = scValToNative(event.value);
  const params: unknown[] = Array.isArray(rawValue) ? rawValue : [rawValue];

  if (topic[1] === "request") {
    await handleLoanRequested(event, params, supabase, cfg, summary);
  } else if (topic[1] === "default") {
    await handleLoanDefaulted(event, params, supabase, cfg, summary);
  }
}

async function handleLoanRequested(
  event: rpc.Api.EventResponse,
  params: unknown[],
  supabase: SupabaseClient,
  cfg: ListenerConfig,
  summary: ListenerSummary
): Promise<void> {
  const loanId = toNumber(params[0]);
  const borrower = String(params[1]);
  const amount = toBigInt(params[2]);
  const durationDays = toNumber(params[3]);
  const interestRateBps = toNumber(params[4]);

  if (amount < cfg.largeLoanThresholdStroops) return;

  const dedupeKey = `large_loan:${event.id}`;
  if (await wasAlreadyNotified(supabase, dedupeKey)) return;

  const loan = await getOnchainLoan(cfg, loanId);

  const payload: LoanNotificationPayload = {
    topic: "large_loan",
    loanId,
    borrower,
    principalStroops: amount,
    durationDays,
    interestRateBps,
    collateralAsset: loan?.collateralAsset ?? "",
    collateralAmount: loan?.collateralAmount ?? 0n,
    loanExplorerUrl: txExplorerUrl(event.txHash),
    borrowerExplorerUrl: accountExplorerUrl(borrower),
    appUrl: appLoansUrl(),
  };

  await notifyTopic(supabase, payload);
  await recordNotification(supabase, dedupeKey, "large_loan", loanId);
  summary.largeLoanAlerts++;
}

async function handleLoanDefaulted(
  event: rpc.Api.EventResponse,
  params: unknown[],
  supabase: SupabaseClient,
  cfg: ListenerConfig,
  summary: ListenerSummary
): Promise<void> {
  const loanId = toNumber(params[0]);

  const dedupeKey = `liquidation_critical:${event.id}`;
  if (await wasAlreadyNotified(supabase, dedupeKey)) return;

  const loan = await getOnchainLoan(cfg, loanId);
  if (!loan) return;

  const payload: LoanNotificationPayload = {
    topic: "liquidation_critical",
    loanId,
    borrower: loan.borrower,
    principalStroops: loan.remainingDue,
    durationDays: loan.durationDays,
    interestRateBps: loan.interestRateBps,
    collateralAsset: loan.collateralAsset,
    collateralAmount: loan.collateralAmount,
    loanExplorerUrl: txExplorerUrl(event.txHash),
    borrowerExplorerUrl: accountExplorerUrl(loan.borrower),
    appUrl: appLoansUrl(),
  };

  await notifyTopic(supabase, payload);
  await recordNotification(supabase, dedupeKey, "liquidation_critical", loanId);
  summary.liquidationCriticalAlerts++;
}

// ─── 2. Loan-health sweep (edge-triggered "entering liquidation territory") ──

async function sweepLoanHealth(
  cfg: ListenerConfig,
  supabase: SupabaseClient,
  summary: ListenerSummary
): Promise<void> {
  const count = await getLoanCount(cfg);
  if (count === 0) return;

  const priceTable = loadPriceTable();
  const startId = Math.max(1, count - cfg.healthSweepLimit + 1);

  for (let loanId = count; loanId >= startId; loanId--) {
    summary.healthSweepScanned++;

    const loan = await getOnchainLoan(cfg, loanId);
    if (!loan || loan.status !== "Active") continue;

    const collateralPrice = resolveAssetPrice(priceTable, cfg.xlmPriceUsd, loan.collateralAsset);
    if (!collateralPrice) continue;

    const reputationScore = await getReputationScore(cfg, loan.borrower);
    const thresholdBps = await getLiquidationThresholdBps(
      cfg,
      reputationScore,
      cfg.defaultAssetVolatilityBps
    );
    const ltvBps = computeLtvBps({
      remainingDueStroops: loan.remainingDue,
      xlmPriceUsd: cfg.xlmPriceUsd,
      collateralAmount: loan.collateralAmount,
      collateralDecimals: collateralPrice.decimals,
      collateralPriceUsd: collateralPrice.priceUsd,
    });

    const zone = classifyHealthZone(ltvBps, thresholdBps, cfg.warningBufferBps);
    const previousZone = await getLoanHealthZone(supabase, loanId);

    if (zone !== previousZone) {
      await setLoanHealthZone(supabase, loanId, zone);
    }

    // Only alert on the edge transition into "warning". "critical" is left to
    // the `(loan, default)` event handler above (the actual liquidation) —
    // alerting on every sweep before the keeper acts would just be noise.
    if (zone === "warning" && isWorseningTransition(previousZone, zone)) {
      const payload: LoanNotificationPayload = {
        topic: "liquidation_warning",
        loanId,
        borrower: loan.borrower,
        principalStroops: loan.remainingDue,
        durationDays: loan.durationDays,
        interestRateBps: loan.interestRateBps,
        collateralAsset: loan.collateralAsset,
        collateralAmount: loan.collateralAmount,
        ltvBps,
        thresholdBps,
        loanExplorerUrl: accountExplorerUrl(loan.borrower),
        borrowerExplorerUrl: accountExplorerUrl(loan.borrower),
        appUrl: appLoansUrl(),
      };
      await notifyTopic(supabase, payload);
      summary.liquidationWarningAlerts++;
    }
  }
}
