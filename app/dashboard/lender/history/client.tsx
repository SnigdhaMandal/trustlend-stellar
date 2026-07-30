"use client";

import { LenderTransactionList } from "@/components/dashboard/LenderTransactionList";

interface LenderTransaction {
  id: string;
  label: string;
  subLabel: string;
  amount: number;
  currency: string;
  date: string;
  status: string;
  txHash: string;
  type: "funding" | "repayment" | "deposit" | "withdrawal";
}

interface LenderHistoryClientProps {
  initialTransactions: LenderTransaction[];
  hasMore: boolean;
}

export function LenderHistoryClient({
  initialTransactions,
  hasMore,
}: LenderHistoryClientProps) {
  return (
    <LenderTransactionList
      apiEndpoint="/api/lender/transactions"
      initialTransactions={initialTransactions}
      initialHasMore={hasMore}
    />
  );
}