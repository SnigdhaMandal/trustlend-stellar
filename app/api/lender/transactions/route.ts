import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { getServerSupabaseClient, getServiceRoleClient } from "@/lib/supabase/server";

const PAGE_SIZE = 20;

/**
 * GET /api/lender/transactions?cursor=<cursor>&direction=<next|prev>
 *
 * Returns paginated transaction history for the authenticated lender.
 */
export async function GET(request: NextRequest) {
  try {
    const { user } = await requireAuthenticatedUser("lender");
    const supabase = await getServerSupabaseClient();
    const srClient = getServiceRoleClient();

    if (!supabase || !srClient) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 500 });
    }

    const cursor = request.nextUrl.searchParams.get("cursor") || undefined;
    const direction = request.nextUrl.searchParams.get("direction") || "next";

    // Fetch user-initiated transactions with cursor-based pagination
    let userTxsQuery = supabase
      .from("ledger_transactions")
      .select("id, category, ref_type, ref_id, amount, currency, status, metadata, created_at")
      .eq("user_id", user.id)
      .order("created_at", { ascending: false });

    if (cursor) {
      const cursorDate = new Date(cursor);
      if (direction === "next") {
        userTxsQuery = userTxsQuery.lt("created_at", cursor);
      } else {
        userTxsQuery = userTxsQuery.gt("created_at", cursor);
      }
    }

    userTxsQuery = userTxsQuery.limit(PAGE_SIZE + 1);

    const { data: userTxs, error: userTxsError } = await userTxsQuery;

    if (userTxsError) {
      console.error("User transactions fetch error:", userTxsError);
      return NextResponse.json({ error: "Failed to fetch transactions" }, { status: 500 });
    }

    const hasMore = (userTxs?.length ?? 0) > PAGE_SIZE;
    const items = userTxs?.slice(0, PAGE_SIZE) ?? [];

    // Fetch incoming repayments (where lender is the recipient)
    const { data: allRepays } = await srClient
      .from("ledger_transactions")
      .select("id, category, ref_type, ref_id, amount, currency, status, metadata, created_at")
      .eq("ref_type", "loan_repay")
      .order("created_at", { ascending: false })
      .limit(200);

    const incomingRepays = (allRepays ?? []).filter((tx) => {
      try {
        const meta = JSON.parse(String(tx.metadata || "{}"));
        return String(meta.lenderUserId) === String(user.id) || String(meta.lenderAddress) === String(user.id);
      } catch {
        return false;
      }
    });

    // Merge and dedup
    const txMap = new Map();
    for (const t of items) txMap.set(t.id, t);
    for (const t of incomingRepays) txMap.set(t.id, t);

    const transactions = Array.from(txMap.values()).sort(
      (a, b) => new Date(String(b.created_at)).getTime() - new Date(String(a.created_at)).getTime()
    );

    // Format transactions
    const formattedTransactions = transactions.map((tx) => {
      let txHash = "";
      let subLabel = "";
      try {
        const meta = JSON.parse(String(tx.metadata ?? "{}"));
        txHash = String(meta.txHash ?? "");
        if (meta.loanId) subLabel = `Loan #${String(meta.loanId).slice(0, 8)}`;
        else if (tx.ref_id) subLabel = `Ref #${String(tx.ref_id).slice(0, 8)}`;
      } catch { /* ok */ }

      let label = "Transaction";
      if (tx.ref_type === "loan_fund") label = "P2P Loan Deployed";
      else if (tx.ref_type === "loan_repay") label = "Repayment Received";
      else if (tx.category === "pool_deposit") label = "Pool Deposit";
      else if (tx.category === "pool_withdraw") label = "Pool Withdrawal";

      let type: "funding" | "repayment" | "deposit" | "withdrawal" = "funding";
      if (tx.ref_type === "loan_fund") type = "funding";
      else if (tx.ref_type === "loan_repay") type = "repayment";
      else if (tx.category === "pool_deposit") type = "deposit";
      else if (tx.category === "pool_withdraw") type = "withdrawal";

      return {
        id: tx.id,
        label,
        subLabel,
        amount: Number(tx.amount),
        currency: tx.currency || "XLM",
        date: String(tx.created_at),
        status: tx.status || "completed",
        txHash,
        type,
      };
    });

    const nextCursor = formattedTransactions.length > 0
      ? formattedTransactions[formattedTransactions.length - 1].date
      : undefined;

    return NextResponse.json({
      transactions: formattedTransactions,
      hasMore,
      nextCursor,
    });
  } catch (err) {
    console.error("Lender transactions fetch error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}