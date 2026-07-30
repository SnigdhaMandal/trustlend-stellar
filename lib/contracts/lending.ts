/**
 * lib/contracts/lending.ts
 *
 * TypeScript client for the LendingContract.
 */

import {
  callContract,
  simulateContractCall,
  addressToScVal,
  u32ToScVal,
  i128ToScVal,
  bytesToScVal,
} from "@/lib/stellar/soroban";
import type { LoanRecord, LoanStatus, PaymentRecord, InterestRateModel, CollateralEntry } from "@/types/contracts";

const CONTRACT_ID = process.env.NEXT_PUBLIC_LENDING_CONTRACT_ID!;

if (!CONTRACT_ID) {
  console.warn(
    "[TrustLend] NEXT_PUBLIC_LENDING_CONTRACT_ID is not set. " +
      "Deploy the contract and add the ID to .env.local"
  );
}

// ─── Read functions ───────────────────────────────────────────────────────────


// ─── Multi-asset collateral vault functions ────────────────────────────────

/**
 * Deposit collateral to the borrower's vault position.
 */
export async function depositCollateral(
  borrowerAddress: string,
  assetAddress: string,
  amountStroops: bigint,
) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "deposit_collateral",
    args: [
      addressToScVal(borrowerAddress),
      addressToScVal(assetAddress),
      i128ToScVal(amountStroops),
    ],
    callerAddress: borrowerAddress,
  });
}

/**
 * Withdraw collateral from the borrower's vault position.
 */
export async function withdrawCollateral(
  borrowerAddress: string,
  assetAddress: string,
  amountStroops: bigint,
) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "withdraw_collateral",
    args: [
      addressToScVal(borrowerAddress),
      addressToScVal(assetAddress),
      i128ToScVal(amountStroops),
    ],
    callerAddress: borrowerAddress,
  });
}

/**
 * Get all collateral entries for a borrower.
 */
export async function getUserCollateralEntries(
  borrowerAddress: string,
  callerAddress: string,
): Promise<{ asset: string; amount: bigint }[]> {
  const raw = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_user_collateral_entries",
    args: [addressToScVal(borrowerAddress)],
    callerAddress,
  });
  return (raw as { asset: string; amount: string }[]).map((e) => ({
    asset: e.asset,
    amount: BigInt(e.amount),
  }));
}

/**
 * Get the total borrowing power for a borrower in base asset units.
 */
export async function getBorrowingPower(
  borrowerAddress: string,
  callerAddress: string,
): Promise<bigint> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_borrowing_power",
    args: [addressToScVal(borrowerAddress)],
    callerAddress,
  });
  return BigInt(result as string | number);
}

/**
 * Get the total collateral value (not LTV-adjusted) for a borrower.
 */
export async function getTotalCollateralValue(
  borrowerAddress: string,
  callerAddress: string,
): Promise<bigint> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_total_collateral_value",
    args: [addressToScVal(borrowerAddress)],
    callerAddress,
  });
  return BigInt(result as string | number);
}

/**
 * Configure collateral parameters for an asset (multisig admin only).
 */
export async function setAssetCollateralConfig(
  adminAddress: string,
  assetAddress: string,
  config: { collateralFactorBps: number; hasPriceOracle: boolean; volatilityBps: number },
) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "set_asset_collateral_config",
    args: [
      addressToScVal(adminAddress),
      addressToScVal(assetAddress),
      {
        collateral_factor_bps: u32ToScVal(config.collateralFactorBps),
        has_price_oracle: config.hasPriceOracle,
        volatility_bps: u32ToScVal(config.volatilityBps),
      },
    ],
    callerAddress: adminAddress,
  });
}

/**
 * Get the collateral configuration for an asset.
 */
export async function getAssetCollateralConfig(
  assetAddress: string,
  callerAddress: string,
): Promise<{ collateralFactorBps: number; hasPriceOracle: boolean; volatilityBps: number }> {
  const raw = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_asset_collateral_config",
    args: [addressToScVal(assetAddress)],
    callerAddress,
  });
  const r = raw as Record<string, unknown>;
  return {
    collateralFactorBps: Number(r.collateral_factor_bps ?? 7500),
    hasPriceOracle: Boolean(r.has_price_oracle ?? false),
    volatilityBps: Number(r.volatility_bps ?? 0),
  };
}

/**
 * Set the authorized price oracle address (multisig admin only).
 */
export async function setPriceOracle(
  adminAddress: string,
  oracleAddress: string,
) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "set_price_oracle",
    args: [addressToScVal(adminAddress), addressToScVal(oracleAddress)],
    callerAddress: adminAddress,
  });
}

/**
 * Get the authorized price oracle address.
 */
export async function getPriceOracle(
  callerAddress: string,
): Promise<string> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_price_oracle",
    args: [],
    callerAddress,
  });
  return result as string;
}

export async function getLoan(
  loanId: number,
  callerAddress: string
): Promise<LoanRecord> {
  const raw = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_loan",
    args: [u32ToScVal(loanId)],
    callerAddress,
  });
  return decodeLoan(raw);
}

export async function getLoanCount(callerAddress: string): Promise<number> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_loan_count",
    args: [],
    callerAddress,
  });
  return Number(result);
}

export async function isLoanOverdue(
  loanId: number,
  callerAddress: string
): Promise<boolean> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "is_overdue",
    args: [u32ToScVal(loanId)],
    callerAddress,
  });
  return result as boolean;
}

export async function getDaysOverdue(
  loanId: number,
  callerAddress: string
): Promise<bigint> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "days_overdue",
    args: [u32ToScVal(loanId)],
    callerAddress,
  });
  return BigInt(result as string | number);
}

export async function getPaymentCount(
  loanId: number,
  callerAddress: string
): Promise<number> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_payment_count",
    args: [u32ToScVal(loanId)],
    callerAddress,
  });
  return Number(result);
}

export async function getPayment(
  loanId: number,
  paymentIndex: number,
  callerAddress: string
): Promise<PaymentRecord> {
  const raw = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_payment",
    args: [u32ToScVal(loanId), u32ToScVal(paymentIndex)],
    callerAddress,
  });
  return decodePayment(raw);
}

/** Current platform fee in basis-points of interest (default 100 = 1 %). */
export async function getPlatformFeeBps(callerAddress: string): Promise<number> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_platform_fee_bps",
    args: [],
    callerAddress,
  });
  return Number(result);
}

/** Address of the linked Governance contract (the only fee changer). */
export async function getGovernance(callerAddress: string): Promise<string> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_governance",
    args: [],
    callerAddress,
  });
  return result as string;
}

/** Current flash-loan fee in basis-points of the borrowed amount (default 9 = 0.09%). */
export async function getFlashLoanFeeBps(callerAddress: string): Promise<number> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_flash_loan_fee_bps",
    args: [],
    callerAddress,
  });
  return Number(result);
}

/** Address of the linked MultiSigAdmin contract (issue #73). */
export async function getMultisigAdmin(callerAddress: string): Promise<string> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_multisig_admin",
    args: [],
    callerAddress,
  });
  return result as string;
}

// ─── Write functions ──────────────────────────────────────────────────────────

/**
 * One-time admin bootstrap: link the MultiSigAdmin contract. After this,
 * `whitelistAsset` / `setFlashLoanFeeBps` / `setGovernance` can only be
 * called by that multisig — the plain admin key loses direct access
 * permanently.
 */
export async function setMultisigAdmin(adminAddress: string, multisigAddress: string) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "set_multisig_admin",
    args: [addressToScVal(adminAddress), addressToScVal(multisigAddress)],
    callerAddress: adminAddress,
  });
}

/**
 * One-time admin bootstrap: link the Governance contract. After this, the
 * platform fee can only be changed by a passed on-chain vote.
 */
export async function setGovernance(adminAddress: string, governanceAddress: string) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "set_governance",
    args: [addressToScVal(adminAddress), addressToScVal(governanceAddress)],
    callerAddress: adminAddress,
  });
}

/** Update the flash-loan fee, capped on-chain at 500 bps (5%) (admin only). */
export async function setFlashLoanFeeBps(adminAddress: string, newFeeBps: number) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "set_flash_loan_fee_bps",
    args: [addressToScVal(adminAddress), u32ToScVal(newFeeBps)],
    callerAddress: adminAddress,
  });
}

/**
 * Execute an uncollateralized flash loan against the pool's balance of `token`.
 *
 * `receiverAddress` must be a deployed contract implementing the
 * `FlashLoanReceiver` callback interface (`execute_operation(token, amount,
 * fee, initiator, params)`). It must transfer back `amount + fee` of `token`
 * to this LendingContract before its callback returns, or the whole
 * transaction — including the initial disbursement — reverts on-chain.
 */
export async function flashLoan(
  callerAddress: string,
  receiverAddress: string,
  tokenAddress: string,
  amountStroops: bigint,
  params: Uint8Array = new Uint8Array()
) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "flash_loan",
    args: [
      addressToScVal(receiverAddress),
      addressToScVal(tokenAddress),
      i128ToScVal(amountStroops),
      bytesToScVal(params),
    ],
    callerAddress,
  });
}

/**
 * Borrower creates a loan request.
 * `interestRateBps` and `maxLoanAmount` should be fetched from the
 * ReputationContract first and passed here.
 */
export async function createLoanRequest(
  borrowerAddress: string,
  amountStroops: bigint,
  durationDays: number,
  interestRateBps: number,
  maxLoanAmountStroops: bigint,
  collateralEntries: { asset: string; amount: bigint }[],
  rateModel: InterestRateModel = "Fixed",
): Promise<number> {
  // Build the LoanRequestInput struct
  const collateralEntriesScVal = collateralEntries.map((e) => ({
    asset: addressToScVal(e.asset),
    amount: i128ToScVal(e.amount),
  }));
  const rateModelScVal = { type: "symbol", value: rateModel };
  const requestInput = {
    amount: i128ToScVal(amountStroops),
    duration_days: u32ToScVal(durationDays),
    interest_rate_bps: u32ToScVal(interestRateBps),
    max_loan_amount: i128ToScVal(maxLoanAmountStroops),
    collateral_entries: collateralEntriesScVal,
    rate_model: rateModelScVal,
  };
  const result = await callContract({
    contractId: CONTRACT_ID,
    method: "create_loan_request",
    args: [
      addressToScVal(borrowerAddress),
      requestInput,
    ],
    callerAddress: borrowerAddress,
  });
  return Number(result);
}

/**
 * Whitelist a new collateral asset (admin only)
 */
export async function whitelistAsset(
  adminAddress: string,
  assetAddress: string
) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "whitelist_asset",
    args: [
      addressToScVal(adminAddress),
      addressToScVal(assetAddress),
    ],
    callerAddress: adminAddress,
  });
}

/**
 * Check if an asset is whitelisted
 */
export async function isAssetWhitelisted(
  assetAddress: string,
  callerAddress: string
): Promise<boolean> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "is_asset_whitelisted",
    args: [addressToScVal(assetAddress)],
    callerAddress,
  });
  return result as boolean;
}

/**
 * Lender approves a pending loan.
 * `escrowId` is the ID returned from `createEscrowHold()`.
 */
export async function approveLoan(
  lenderAddress: string,
  loanId: number,
  escrowId: number
) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "approve_loan",
    args: [
      addressToScVal(lenderAddress),
      u32ToScVal(loanId),
      u32ToScVal(escrowId),
    ],
    callerAddress: lenderAddress,
  });
}

/**
 * Lender revokes their approval within the 1-hour window.
 */
export async function revokeLoanApproval(
  lenderAddress: string,
  loanId: number
) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "revoke_approval",
    args: [addressToScVal(lenderAddress), u32ToScVal(loanId)],
    callerAddress: lenderAddress,
  });
}

/**
 * Admin activates a loan once the disbursement PAYMENT is confirmed.
 */
export async function activateLoan(adminAddress: string, loanId: number) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "activate_loan",
    args: [addressToScVal(adminAddress), u32ToScVal(loanId)],
    callerAddress: adminAddress,
  });
}

/**
 * Admin records a repayment after the borrower's PAYMENT op is confirmed.
 * Returns the new loan status.
 */
export async function recordPayment(
  adminAddress: string,
  loanId: number,
  amountStroops: bigint
): Promise<LoanStatus> {
  const result = await callContract({
    contractId: CONTRACT_ID,
    method: "record_payment",
    args: [
      addressToScVal(adminAddress),
      u32ToScVal(loanId),
      i128ToScVal(amountStroops),
    ],
    callerAddress: adminAddress,
  });
  return extractEnumVariant(result) as LoanStatus;
}

/**
 * Admin marks a loan as defaulted.
 */
export async function markLoanDefaulted(adminAddress: string, loanId: number) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "mark_defaulted",
    args: [addressToScVal(adminAddress), u32ToScVal(loanId)],
    callerAddress: adminAddress,
  });
}

// ─── Rate model functions ─────────────────────────────────────────────────────

/**
 * Borrower switches their loan between Fixed and Floating rate models.
 * Charges a 0.5% fee on remaining debt and enforces a 24h cooldown.
 */
export async function switchRateModel(
  borrowerAddress: string,
  loanId: number,
) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "switch_rate_model",
    args: [addressToScVal(borrowerAddress), u32ToScVal(loanId)],
    callerAddress: borrowerAddress,
  });
}

/**
 * Admin updates the floating rate for a loan. Only applies to Floating-rate loans.
 * Recalculates remaining interest with the new rate.
 */
export async function updateFloatingRate(
  adminAddress: string,
  loanId: number,
  newRateBps: number,
) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "update_floating_rate",
    args: [
      addressToScVal(adminAddress),
      u32ToScVal(loanId),
      u32ToScVal(newRateBps),
    ],
    callerAddress: adminAddress,
  });
}

// ─── Decoders ─────────────────────────────────────────────────────────────────

function decodeLoan(raw: unknown): LoanRecord {
  const r = raw as Record<string, unknown>;
  return {
    id: Number(r.id),
    borrower: r.borrower as string,
    lender: r.lender as string,
    amount: BigInt(r.amount as string | number),
    durationDays: Number(r.duration_days),
    interestRateBps: Number(r.interest_rate_bps),
    totalDue: BigInt(r.total_due as string | number),
    remainingDue: BigInt(r.remaining_due as string | number),
    createdAt: BigInt(r.created_at as string | number),
    dueAt: BigInt(r.due_at as string | number),
    status: extractEnumVariant(r.status) as LoanStatus,
    escrowId: Number(r.escrow_id),
    platformFee: BigInt(r.platform_fee as string | number),
    rateModel: (extractEnumVariant(r.rate_model) as InterestRateModel) ?? "Fixed",
    baseRateBps: Number(r.base_rate_bps ?? r.interest_rate_bps),
    lastRateUpdate: BigInt((r.last_rate_update ?? r.created_at ?? 0) as string | number),
  };
}

function decodePayment(raw: unknown): PaymentRecord {
  const r = raw as Record<string, unknown>;
  return {
    loanId: Number(r.loan_id),
    amount: BigInt(r.amount as string | number),
    paidAt: BigInt(r.paid_at as string | number),
  };
}

function extractEnumVariant(val: unknown): string {
  if (val && typeof val === "object") {
    return Object.keys(val as object)[0];
  }
  return String(val);
}
