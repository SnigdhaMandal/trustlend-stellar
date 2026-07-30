"use client";

import { TransactionList } from "@/components/dashboard/TransactionList";

interface ClientTransaction {
  id: string;
  type: "loan_requested" | "funding_received" | "repayment_made";
  loanId: string;
  amount: number;
  date: string;
  txHash: string;
  loanStatus: string;
}

interface BorrowerHistoryClientProps {
  initialTransactions: ClientTransaction[];
  hasMore: boolean;
  nextCursor: string | null;
}

export function BorrowerHistoryClient({
  initialTransactions,
  hasMore,
  nextCursor,
}: BorrowerHistoryClientProps) {
  return (
    <TransactionList
      apiEndpoint="/api/borrower/transactions"
      initialTransactions={initialTransactions}
      initialHasMore={hasMore}
    />
  );
}