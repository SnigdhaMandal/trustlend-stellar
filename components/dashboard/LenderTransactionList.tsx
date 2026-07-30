"use client";

import { useEffect, useState, useRef, useCallback } from "react";
import { buildStellarTxVerificationUrl, isLikelyTxHash } from "@/lib/stellar/explorer";

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

interface LenderTransactionListProps {
  apiEndpoint: string;
  initialTransactions?: LenderTransaction[];
  initialHasMore?: boolean;
}

const COLORS = {
  purple: {
    bg: "rgba(126,47,208,0.04)",
    border: "rgba(126,47,208,0.12)",
    iconBg: "rgba(126,47,208,0.1)",
    text: "#7e2fd0",
  },
  green: {
    bg: "rgba(34,207,157,0.04)",
    border: "rgba(34,207,157,0.12)",
    iconBg: "rgba(34,207,157,0.1)",
    text: "#22cf9d",
  },
  blue: {
    bg: "rgba(59,130,246,0.04)",
    border: "rgba(59,130,246,0.12)",
    iconBg: "rgba(59,130,246,0.1)",
    text: "#3b82f6",
  },
  gray: {
    bg: "rgba(107,114,128,0.04)",
    border: "rgba(107,114,128,0.12)",
    iconBg: "rgba(107,114,128,0.1)",
    text: "#6b7280",
  },
};

const ICONS = {
  funding: { icon: "🏦", colorClass: "purple", sign: "-" },
  repayment: { icon: "📥", colorClass: "green", sign: "+" },
  deposit: { icon: "🌊", colorClass: "blue", sign: "-" },
  withdrawal: { icon: "💸", colorClass: "green", sign: "+" },
};

export function LenderTransactionList({
  apiEndpoint,
  initialTransactions = [],
  initialHasMore = true,
}: LenderTransactionListProps) {
  const [transactions, setTransactions] = useState<LenderTransaction[]>(initialTransactions);
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
          const existingIds = new Set(prev.map((t) => t.id));
          const newTxns = data.transactions.filter(
            (t: LenderTransaction) => !existingIds.has(t.id)
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
        const hasTx = isLikelyTxHash(tx.txHash);
        const styleConfig = ICONS[tx.type] || ICONS.funding;
        const c = COLORS[styleConfig.colorClass as keyof typeof COLORS];

        return (
          <div
            key={tx.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "1rem",
              padding: "0.9rem 1rem",
              borderRadius: "0.65rem",
              background: c.bg,
              border: `1px solid ${c.border}`,
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
                background: c.iconBg,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: "1.1rem",
              }}
            >
              {styleConfig.icon}
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
                {tx.label}
              </p>
              <p
                style={{
                  margin: "0.15rem 0 0",
                  fontSize: "0.75rem",
                  color: "#9ca3af",
                  fontFamily: "monospace",
                }}
              >
                {tx.subLabel}
                {tx.subLabel && " · "}
                {tx.date ? new Date(String(tx.date)).toLocaleString() : "—"}
              </p>
            </div>

            {/* Amount */}
            <div style={{ textAlign: "right", flexShrink: 0 }}>
              <p
                style={{
                  margin: 0,
                  fontWeight: 800,
                  fontSize: "0.95rem",
                  color: c.text,
                }}
              >
                {styleConfig.sign}
                {Number(tx.amount).toFixed(2)} {tx.currency}
              </p>
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
                  background: c.bg,
                  border: `1px solid ${c.border}`,
                  fontSize: "0.75rem",
                  fontWeight: 700,
                  color: c.text,
                  textDecoration: "none",
                  whiteSpace: "nowrap",
                  flexShrink: 0,
                }}
              >
                ✅ Verify on Stellar ↗
              </a>
            ) : (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "0.3rem",
                  padding: "0.35rem 0.75rem",
                  borderRadius: "0.4rem",
                  background: COLORS.gray.bg,
                  border: `1px solid ${COLORS.gray.border}`,
                  fontSize: "0.72rem",
                  color: COLORS.gray.text,
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