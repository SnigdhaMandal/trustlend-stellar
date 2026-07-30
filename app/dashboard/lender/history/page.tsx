import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { getLenderDashboardMetrics, presentLenderMetrics } from "@/lib/dashboard/metrics";
import { getServerSupabaseClient, getServiceRoleClient } from "@/lib/supabase/server";
import { lenderNavLinks } from "@/lib/dashboard/lender-links";
import { ExportCsvButton } from "@/components/dashboard/ExportCsvButton";
import { LenderHistoryClient } from "./client";

export default async function LenderHistoryPage() {
  const { user } = await requireAuthenticatedUser("lender");
  const metrics = await getLenderDashboardMetrics(user.id);
  const supabase = await getServerSupabaseClient();
  const srClient = getServiceRoleClient();

  // Profile data
  const { data: profile } = supabase
    ? await supabase.from("profiles").select("full_name").eq("id", user.id).maybeSingle()
    : { data: null };

  // Fetch initial transactions with limit for server-side rendering
  const PAGE_SIZE = 20;

  let userTxsQuery = supabase
    ? supabase
        .from("ledger_transactions")
        .select("id, category, ref_type, ref_id, amount, currency, status, metadata, created_at")
        .eq("user_id", user.id)
        .order("created_at", { ascending: false })
        .limit(PAGE_SIZE + 1)
    : { data: [] };

  const { data: userTxs } = userTxsQuery;

  const hasMore = (userTxs?.length ?? 0) > PAGE_SIZE;
  const items = userTxs?.slice(0, PAGE_SIZE) ?? [];

  // Fetch incoming repayments
  const { data: allRepays } = srClient
    ? await srClient
        .from("ledger_transactions")
        .select("id, category, ref_type, ref_id, amount, currency, status, metadata, created_at")
        .eq("ref_type", "loan_repay")
        .order("created_at", { ascending: false })
        .limit(200)
    : { data: [] };

  const incomingRepays = (allRepays ?? []).filter((tx) => {
    try {
      const meta = JSON.parse(String(tx.metadata || "{}"));
      return String(meta.lenderUserId) === String(user.id) || String(meta.lenderAddress) === String(user.id);
    } catch { return false; }
  });

  // Merge and dedup
  const txMap = new Map();
  for (const t of items) txMap.set(t.id, t);
  for (const t of incomingRepays) txMap.set(t.id, t);

  const transactions = Array.from(txMap.values()).sort(
    (a, b) => new Date(String(b.created_at)).getTime() - new Date(String(a.created_at)).getTime()
  );

  // Format transactions
  const initialTransactions = transactions.map((tx) => {
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

  const exportData = initialTransactions.map((tx) => ({
    "Transaction ID": tx.id,
    "Type": tx.label,
    "Reference": tx.subLabel,
    "Amount": tx.amount.toFixed(2),
    "Currency": tx.currency,
    "Date": tx.date ? new Date(String(tx.date)).toLocaleString() : "",
    "Status": tx.status,
    "Stellar Tx Hash": tx.txHash,
  }));

  return (
    <WorkspaceFrame
      roleLabel="Lender Dashboard"
      heading="Transaction History"
      description="A full chronological record of every investment, pool deposit, and repayment — fully verifiable on-chain."
      email={user.email ?? null}
      userName={String(
        user.user_metadata?.full_name ?? profile?.full_name ?? ""
      )}
      metrics={presentLenderMetrics(metrics)}
      currentPath="/dashboard/lender/history"
      links={lenderNavLinks}
    >
      <div className="workspace-stack">
        {/* Transaction stream */}
        <article className="workspace-card workspace-card--full">
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "1.25rem",
            }}
          >
            <h2 className="workspace-card-title" style={{ margin: 0 }}>
              All Transactions
            </h2>
            <ExportCsvButton
              data={exportData}
              filename={`lender_transactions_${new Date().toISOString().slice(0, 10)}.csv`}
            />
          </div>

          <LenderHistoryClient
            initialTransactions={initialTransactions}
            hasMore={hasMore}
          />
        </article>
      </div>
    </WorkspaceFrame>
  );
}