import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { getServerSupabaseClient } from "@/lib/supabase/server";

const PAGE_SIZE = 20;

/**
 * GET /api/borrower/transactions?cursor=<cursor>&direction=<next|prev>
 *
 * Returns paginated transaction history for the authenticated borrower.
 * Cursor is the created_at timestamp of the last item.
 */
export async function GET(request: NextRequest) {
  try {
    const { user } = await requireAuthenticatedUser("borrower");
    const supabase = await getServerSupabaseClient();

    if (!supabase) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 500 });
    }

    const cursor = request.nextUrl.searchParams.get("cursor") || undefined;
    const direction = request.nextUrl.searchParams.get("direction") || "next";

    // Fetch loans with cursor-based pagination
    let loansQuery = supabase
      .from("loans")
      .select("id, status, principal_amount, repaid_amount, apr_bps, duration_days, due_at, created_at")
      .eq("borrower_id", user.id)
      .order("created_at", { ascending: false });

    if (cursor) {
      const cursorDate = new Date(cursor);
      if (direction === "next") {
        loansQuery = loansQuery.lt("created_at", cursor);
      } else {
        loansQuery = loansQuery.gt("created_at", cursor);
      }
    }

    loansQuery = loansQuery.limit(PAGE_SIZE + 1); // Fetch one extra to check if there are more

    const { data: loans, error: loansError } = await loansQuery;

    if (loansError) {
      console.error("Loans fetch error:", loansError);
      return NextResponse.json({ error: "Failed to fetch loans" }, { status: 500 });
    }

    const hasMore = (loans?.length ?? 0) > PAGE_SIZE;
    const items = loans?.slice(0, PAGE_SIZE) ?? [];

    // Fetch ledger transactions for these loans
    const loanIds = items.map((l) => String(l.id));

    const [ledgerRes, requestLedgerRes] = loanIds.length > 0
      ? await Promise.all([
          supabase
            .from("ledger_transactions")
            .select("ref_id, metadata, created_at, amount")
            .eq("ref_type", "loan_fund")
            .in("ref_id", loanIds),
          supabase
            .from("ledger_transactions")
            .select("ref_id, metadata, created_at, amount")
            .eq("ref_type", "loan_request")
            .in("ref_id", loanIds),
        ])
      : [{ data: [] }, { data: [] }];

    // Fetch repayments
    const repaymentsRes = loanIds.length > 0
      ? await supabase
          .from("loan_repayments")
          .select("id, loan_id, amount, created_at")
          .in("loan_id", loanIds)
          .order("created_at", { ascending: false })
          .limit(100)
      : { data: [] };

    // Build transaction feed
    const transactions: Array<{
      id: string;
      type: "loan_requested" | "funding_received" | "repayment_made";
      loanId: string;
      amount: number;
      date: string;
      txHash: string;
      loanStatus: string;
    }> = [];

    const requestTxMap: Record<string, { date: string; amount: number }> = {};
    for (const entry of requestLedgerRes.data ?? []) {
      if (!entry.ref_id) continue;
      requestTxMap[String(entry.ref_id)] = {
        date: String(entry.created_at ?? ""),
        amount: Number(entry.amount ?? 0),
      };
    }

    const loanTxMap: Record<string, { hash: string; amount: number; date: string }> = {};
    for (const entry of ledgerRes.data ?? []) {
      try {
        const meta = JSON.parse(String(entry.metadata ?? "{}"));
        if (String(entry.ref_id)) {
          loanTxMap[String(entry.ref_id)] = {
            hash: String(meta.txHash ?? ""),
            amount: Number(entry.amount ?? 0),
            date: String(entry.created_at ?? ""),
          };
        }
      } catch { /* ignore */ }
    }

    // Request events
    for (const loan of items) {
      const loanId = String(loan.id);
      const requestTx = requestTxMap[loanId];
      const amount = requestTx?.amount ?? Number(loan.principal_amount ?? 0);
      const date = requestTx?.date || String(loan.created_at ?? "");

      transactions.push({
        id: `request-${loanId}`,
        type: "loan_requested",
        loanId,
        amount,
        date,
        txHash: "",
        loanStatus: String(loan.status),
      });
    }

    // Funding events
    for (const loan of items) {
      const loanId = String(loan.id);
      const ledger = loanTxMap[loanId];
      if (ledger && ledger.amount > 0) {
        transactions.push({
          id: `fund-${loanId}`,
          type: "funding_received",
          loanId,
          amount: ledger.amount,
          date: ledger.date || String(loan.created_at ?? ""),
          txHash: ledger.hash,
          loanStatus: String(loan.status),
        });
      }
    }

    // Repayment events
    for (const r of repaymentsRes.data ?? []) {
      const loan = items.find((l) => String(l.id) === String(r.loan_id));
      if (!loan) continue;

      // Get repayment tx hash
      let txHash = "";
      try {
        const { data: repayTx } = await supabase
          .from("ledger_transactions")
          .select("metadata")
          .eq("ref_type", "loan_repay")
          .eq("ref_id", String(r.id))
          .maybeSingle();

        if (repayTx) {
          const meta = JSON.parse(String(repayTx.metadata ?? "{}"));
          txHash = String(meta.txHash ?? "");
        }
      } catch { /* ignore */ }

      transactions.push({
        id: `repay-${r.id}`,
        type: "repayment_made",
        loanId: String(r.loan_id),
        amount: Number(r.amount),
        date: String(r.created_at ?? ""),
        txHash,
        loanStatus: String(loan.status),
      });
    }

    // Sort by date descending
    transactions.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    // Get next cursor
    const nextCursor = transactions.length > 0
      ? transactions[transactions.length - 1].date
      : undefined;

    return NextResponse.json({
      transactions,
      hasMore,
      nextCursor,
    });
  } catch (err) {
    console.error("Transactions fetch error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}