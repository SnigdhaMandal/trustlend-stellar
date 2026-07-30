"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { formatCurrency } from "@/lib/utils/formatting";
import { buildStellarTxVerificationUrl, isLikelyTxHash } from "@/lib/stellar/explorer";

interface Transaction {
  id: string;
  type: "loan_requested" | "funding_received" | "repayment_made";
  loanId: string;
  amount: number;
  date: string;
  txHash: string;
  loanStatus: string;
}

interface TransactionListProps {
  apiEndpoint: string;
  initialTransactions?: Transaction[];
  initialHasMore?: boolean;
}

export function TransactionList({
  apiEndpoint,
  initialTransactions = [],
  initialHasMore = true,
}: TransactionListProps) {
  const [transactions, setTransactions] = useState<Transaction[]>(initialTransactions);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [isLoading, setIsLoading] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const observerTarget = useRef<HTMLDivElement>(null);

  const loadMore = useCallback(async () => {
    if (isLoading || !hasMore) return;

    setIsLoading(true);
    try {
      const url = new URL(apiEndpoint, window.location.origin);
      if (cursor) {
        url.searchParams.set("cursor", cursor);
        url.searchParams.set("direction", "next");
      }

      const res = await fetch(url.toString());
      if (!res.ok) throw new Error("Failed to fetch");

      const data = await res.json();

      if (data.transactions.length === 0) {
        setHasMore(false);
      } else {
        setTransactions((prev) => {
          // Avoid duplicates
          const existingIds = new Set(prev.map((t) => t.id));
          const newTxns = data.transactions.filter(
            (t: Transaction) => !existingIds.has(t.id)
          );
          return [...prev, ...newTxns];
        });
        setHasMore(data.hasMore);
        setCursor(data.nextCursor || null);
      }
    } catch (err) {
      console.error("Error loading more transactions:", err);
    } finally {
      setIsLoading(false);
    }
  }, [apiEndpoint, cursor, hasMore, isLoading]);

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !isLoading) {
          loadMore();
        }
      },
      { threshold: 0.1, rootMargin: "100px" }
    );

    if (observerTarget.current) {
      observer.observe(observerTarget.current);
    }

    return () => observer.disconnect();
  }, [hasMore, isLoading, loadMore]);

  if (transactions.length === 0) {
    return (
      <div style={{ textAlign: "center", padding: "2.5rem", opacity: 0.5 }}>
        <div style={{ fontSize: "2.5rem", marginBottom: "0.75rem" }}>📋</div>
        <p>No transactions yet.</p>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0.6rem" }}>
      {transactions.map((tx) => {
        const isRequested = tx.type === "loan_requested";
        const isFunding = tx.type === "funding_received";
        const isRepayment = tx.type === "repayment_made";
        const hasTx = isLikelyTxHash(tx.txHash);

        return (
          <div
            key={tx.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "1rem",
              padding: "0.9rem 1rem",
              borderRadius: "0.65rem",
              background: isRequested
                ? "rgba(245,166,35,0.08)"
                : isFunding
                  ? "rgba(126,47,208,0.04)"
                  : "rgba(34,207,157,0.04)",
              border: `1px solid ${
                isRequested
                  ? "rgba(245,166,35,0.28)"
                  : isFunding
                    ? "rgba(126,47,208,0.12)"
                    : "rgba(34,207,157,0.12)"
              }`,
              flexWrap: "wrap",
            }}
          >
            {/* Icon */}
            <div
              style={{
                width: "38px",
                height: "38px",
                borderRadius: "50%",
                flexShrink: 0,
                background: isRequested
                  ? "rgba(245,166,35,0.14)"
                  : isFunding
                    ? "rgba(126,47,208,0.1)"
                    : "rgba(34,207,157,0.1)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "1.1rem",
              }}
            >
              {isRequested ? "📝" : isFunding ? "📥" : "📤"}
            </div>

            {/* Details */}
            <div style={{ flex: 1, minWidth: "200px" }}>
              <p
                style={{
                  margin: 0,
                  fontWeight: 700,
                  fontSize: "0.88rem",
                  color: "#111827",
                }}
              >
                {isRequested
                  ? "Loan Request Created"
                  : isFunding
                    ? "Funding Received"
                    : "Repayment Made"}
              </p>
              <p
                style={{
                  margin: "0.15rem 0 0",
                  fontSize: "0.75rem",
                  color: "#9ca3af",
                  fontFamily: "monospace",
                }}
              >
                Loan #{tx.loanId.slice(0, 8)}
                {" · "}
                {tx.date ? new Date(tx.date).toLocaleString() : "—"}
              </p>
            </div>

            {/* Amount */}
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              <p
                style={{
                  margin: 0,
                  fontWeight: 800,
                  fontSize: "0.95rem",
                  color: isRequested ? "#d97706" : isFunding ? "#7e2fd0" : "#22cf9d",
                }}
              >
                {isRequested ? "" : isRepayment ? "-" : "+"}
                {formatCurrency(tx.amount)}
              </p>
              <span
                style={{
                  fontSize: "0.7rem",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  color:
                    tx.loanStatus === "repaid"
                      ? "#22cf9d"
                      : tx.loanStatus === "active" || tx.loanStatus === "funded"
                        ? "#f5a623"
                        : "#9ca3af",
                }}
              >
                {tx.loanStatus || "—"}
              </span>
            </div>

            {/* Verify link */}
            {hasTx ? (
              <a
                href={buildStellarTxVerificationUrl(tx.txHash)}
                target="_blank"
                rel="noreferrer"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.3rem",
                  padding: "0.35rem 0.75rem",
                  borderRadius: "0.4rem",
                  background: "rgba(34,207,157,0.1)",
                  border: "1px solid rgba(34,207,157,0.25)",
                  fontSize: "0.75rem",
                  fontWeight: 700,
                  color: "#22cf9d",
                  textDecoration: "none",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                }}
              >
                ✅ Verify on Stellar ↗
              </a>
            ) : isFunding ? (
              <span
                style={{
                  fontSize: "0.72rem",
                  color: "#d1d5db",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                }}
              >
                ⏳ Awaiting TX
              </span>
            ) : isRequested ? (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.3rem",
                  padding: "0.35rem 0.75rem",
                  borderRadius: "0.4rem",
                  background: "rgba(245,166,35,0.12)",
                  border: "1px solid rgba(245,166,35,0.28)",
                  fontSize: "0.72rem",
                  color: "#d97706",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                }}
              >
                🧾 Request recorded
              </span>
            ) : (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.3rem",
                  padding: "0.35rem 0.75rem",
                  borderRadius: "0.4rem",
                  background: "rgba(107,114,128,0.08)",
                  border: "1px solid rgba(107,114,128,0.15)",
                  fontSize: "0.72rem",
                  color: "#6b7280",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                }}
              >
                📋 Off-chain record
              </span>
            )}
          </div>
        );
      })}

      {/* Loading indicator / Intersection target */}
      <div
        ref={observerTarget}
        style={{
          padding: "1rem",
          display: "flex",
          justifyContent: "center",
          alignItems: "center",
          gap: "0.5rem",
        }}
      >
        {isLoading && (
          <span style={{ fontSize: "0.9rem", color: "#6b7280" }}>
            Loading more...
          </span>
        )}
        {!hasMore && transactions.length > 0 && (
          <span style={{ fontSize: "0.8rem", color: "#9ca3af" }}>
            No more transactions
          </span>
        )}
      </div>
    </div>
  );
}