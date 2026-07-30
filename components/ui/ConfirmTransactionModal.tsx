"use client";

import { useState, useEffect, useCallback, useRef } from "react";

import { Loader2, AlertTriangle, ChevronDown, ChevronUp } from "lucide-react";
import { SimulationPreview } from "@/components/ui/SimulationPreview";
import { simulatePreview } from "@/lib/stellar/simulation";
import type { SimulationResult } from "@/lib/stellar/simulation";
import { FocusTrap } from "@/components/ui/FocusTrap";

// ─── Action item descriptor ────────────────────────────────────────────────

export interface TransactionAction {
  /** Label shown in the modal header (e.g. "Create Loan Request") */
  label: string;
  /** Contract ID string */
  contractId: string;
  /** Method name on the contract */
  method: string;
  /** Arguments to encode and pass to the contract */
  args: unknown[];
  /** Caller / source Stellar address */
  callerAddress: string;
  /** Optional wallet balance before the tx (for before/after display) */
  walletBalanceXlm?: number;
  /** Optional details shown in an expandable section */
  details?: Record<string, string | number | bigint>;
}

interface ConfirmTransactionModalProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => Promise<void>;
  action: TransactionAction | null;
  confirming?: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function normalizeValue(val: string | number | bigint): string {
  if (typeof val === "bigint") {
    // Assume stroops if > 1e6
    if (val > 1_000_000n) {
      return `${(Number(val) / 10_000_000).toFixed(2)} XLM`;
    }
    return val.toString();
  }
  if (typeof val === "number") {
    return val.toLocaleString();
  }
  return val;
}

// ─── Component ──────────────────────────────────────────────────────────────

export function ConfirmTransactionModal({
  open,
  onClose,
  onConfirm,
  action,
  confirming = false,
}: ConfirmTransactionModalProps) {
  const [simResult, setSimResult] = useState<SimulationResult | null>(null);
  const [simLoading, setSimLoading] = useState(false);
  const [simError, setSimError] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const detailsEntries = action?.details
    ? Object.entries(action.details)
    : [];
  const mountedRef = useRef(true);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const confirmButtonRef = useRef<HTMLButtonElement>(null);

  // Close on Escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open && !confirming) {
        onClose();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, confirming, onClose]);

  // Return focus to trigger when modal closes
  useEffect(() => {
    if (!open) {
      const trigger = document.querySelector('[data-confirm-trigger]') as HTMLElement;
      trigger?.focus();
    } else {
      // Focus the confirm button when modal opens
      setTimeout(() => confirmButtonRef.current?.focus(), 0);
    }
  }, [open]);

  // Reset & run simulation when modal opens or action changes
  useEffect(() => {
    mountedRef.current = true;
    if (!open || !action) {
      setSimResult(null);
      setSimLoading(false);
      setSimError(null);
      return;
    }

    let cancelled = false;
    const run = async () => {
      setSimLoading(true);
      setSimError(null);
      try {
        const result = await simulatePreview(
          action.contractId,
          action.method,
          action.args,
          action.callerAddress,
        );
        if (!cancelled && mountedRef.current) {
          setSimResult(result);
          if (!result.success) {
            setSimError(result.error ?? "Simulation returned no data");
          }
        }
      } catch (err) {
        if (!cancelled && mountedRef.current) {
          setSimError((err as Error).message);
          setSimResult({
            success: false,
            method: action.method,
            contractId: action.contractId,
            feeStroops: 0,
            feeXlm: "0",
            resources: { instructions: 0, readBytes: 0, writeBytes: 0, ledgerFootprintEntries: 0 },
            error: (err as Error).message,
            latestLedger: 0,
          });
        }
      } finally {
        if (!cancelled && mountedRef.current) {
          setSimLoading(false);
        }
      }
    };

    run();

    return () => {
      cancelled = true;
    };
  }, [open, action]);

  // Re-simulate on re-open
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const handleConfirm = useCallback(async () => {
    await onConfirm();
  }, [onConfirm]);

  if (!open || !action) return null;

  const isSimFailed = simResult && !simResult.success;
  const hasDetails = detailsEntries.length > 0;


  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 9998,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
      }}
    >
      {/* Backdrop */}
      <div
        onClick={!confirming ? onClose : undefined}
        style={{
          position: "absolute",
          inset: 0,
          background: "rgba(0,0,0,0.55)",
          backdropFilter: "blur(4px)",
          animation: "modalFadeIn 200ms ease",
        }}
      />

      {/* Modal */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Confirm ${action.label}`}
        style={{
          position: "relative",
          zIndex: 1,
          width: "min(440px, 100%)",
          maxHeight: "90dvh",
          overflowY: "auto",
          background: "linear-gradient(180deg, #1a1a2e, #16213e)",
          border: `1px solid ${isSimFailed ? "rgba(255,77,77,0.3)" : "rgba(167,139,250,0.2)"}`,
          borderRadius: "1.2rem",
          padding: "1.5rem",
          boxShadow: `0 24px 60px rgba(0,0,0,0.5), 0 0 0 1px ${isSimFailed ? "rgba(255,77,77,0.15)" : "rgba(167,139,250,0.1)"}`,
          animation: "modalSlideUp 300ms cubic-bezier(0.175, 0.885, 0.32, 1.275)",
          color: "#e6e8f0",
        }}
      >
        {/* ── Header ───────────────────────────────────────────── */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "0.75rem", marginBottom: "1.2rem" }}>
          <div>
            <p style={{ margin: 0, fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.1em", opacity: 0.5, fontWeight: 700 }}>
              Transaction Preview
            </p>
            <h2 style={{ margin: "0.25rem 0 0", fontSize: "1.1rem", fontWeight: 800, lineHeight: 1.2 }}>
              {action.label}
            </h2>
            <p style={{ margin: "0.15rem 0 0", fontSize: "0.72rem", fontFamily: "monospace", opacity: 0.5 }}>
              {action.method}
            </p>
          </div>

          <button
            onClick={onClose}
            disabled={confirming}
            style={{
              background: "rgba(255,255,255,0.06)",
              border: "1px solid rgba(255,255,255,0.08)",
              borderRadius: "999px",
              width: "32px",
              height: "32px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: "rgba(255,255,255,0.5)",
              cursor: confirming ? "not-allowed" : "pointer",
              fontSize: "0.9rem",
              flexShrink: 0,
            }}
          >
            ✕
          </button>
        </div>

        {/* ── Simulation preview ───────────────────────────────── */}
        <SimulationPreview
          result={simResult}
          loading={simLoading}
          methodLabel={action.label}
        />

        {/* ── Warning banner for failed sim ────────────────────── */}
        {isSimFailed && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
              marginTop: "0.75rem",
              padding: "0.6rem 0.75rem",
              borderRadius: "0.65rem",
              background: "rgba(255,77,77,0.1)",
              border: "1px solid rgba(255,77,77,0.2)",
              fontSize: "0.78rem",
              color: "#ff6b6b",
            }}
          >
            <AlertTriangle size={16} />
            <span style={{ fontWeight: 600 }}>
              Warning: Simulation predicts a reversion. The transaction may fail on-chain.
            </span>
          </div>
        )}

        {/* ── Expandable details ──────────────────────────────── */}
        {hasDetails && (
          <div style={{ marginTop: "0.75rem" }}>
            <button
              onClick={() => setDetailsOpen(!detailsOpen)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "0.35rem",
                background: "transparent",
                border: "none",
                color: "rgba(255,255,255,0.5)",
                fontSize: "0.75rem",
                fontWeight: 600,
                cursor: "pointer",
                padding: "0.25rem 0",
                width: "100%",
              }}
            >
              {detailsOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {detailsOpen ? "Hide" : "Show"} Action Details
            </button>

            {detailsOpen && (
              <div
                style={{
                  background: "rgba(0,0,0,0.2)",
                  borderRadius: "0.6rem",
                  padding: "0.6rem 0.75rem",
                  display: "grid",
                  gap: "0.35rem",
                  fontSize: "0.75rem",
                  fontFamily: "monospace",
                }}
              >
                {detailsEntries.map(([key, val]) => (
                  <div key={key} style={{ display: "flex", justifyContent: "space-between", gap: "0.5rem" }}>
                    <span style={{ opacity: 0.5 }}>{key}</span>
                    <span style={{ fontWeight: 600, textAlign: "right" }}>{normalizeValue(val)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Wallet address ───────────────────────────────────── */}
        <p
          style={{
            margin: "0.75rem 0 0",
            fontSize: "0.68rem",
            opacity: 0.4,
            textAlign: "center",
            fontFamily: "monospace",
            wordBreak: "break-all",
          }}
        >
          Signing with: {action.callerAddress}
        </p>

        {/* ── Sim error message ────────────────────────────────── */}
        {simError && !simLoading && (
          <p
            style={{
              margin: "0.5rem 0 0",
              fontSize: "0.7rem",
              color: "#ff6b6b",
              textAlign: "center",
              opacity: 0.7,
            }}
          >
            {simError}
          </p>
        )}

        {/* ── Actions ──────────────────────────────────────────── */}
        <div
          style={{
            display: "flex",
            gap: "0.6rem",
            marginTop: "1.2rem",
          }}
        >
          <button
            onClick={onClose}
            disabled={confirming}
            style={{
              flex: 1,
              minHeight: "44px",
              borderRadius: "0.8rem",
              border: "1px solid rgba(255,255,255,0.12)",
              background: "rgba(255,255,255,0.06)",
              color: "rgba(255,255,255,0.7)",
              fontSize: "0.85rem",
              fontWeight: 700,
              cursor: confirming ? "not-allowed" : "pointer",
              opacity: confirming ? 0.5 : 1,
            }}
          >
            Cancel
          </button>

          <button
            onClick={handleConfirm}
            disabled={simLoading || confirming}
            style={{
              flex: 1,
              minHeight: "44px",
              borderRadius: "0.8rem",
              border: "none",
              background: isSimFailed
                ? "linear-gradient(135deg, #ff6b6b, #ee5a24)"
                : "linear-gradient(135deg, #a78bfa, #34d399)",
              color: "#ffffff",
              fontSize: "0.85rem",
              fontWeight: 800,
              cursor: simLoading || confirming ? "not-allowed" : "pointer",
              opacity: simLoading || confirming ? 0.6 : 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: "0.4rem",
            }}
          >
            {confirming ? (
              <>
                <Loader2 size={16} style={{ animation: "simSpin 1s linear infinite" }} />
                Confirming...
              </>
            ) : isSimFailed ? (
              "Sign Anyway"
            ) : (
              "Confirm & Sign"
            )}
          </button>
        </div>

        <style
          dangerouslySetInnerHTML={{
            __html: `
              @keyframes modalFadeIn { from { opacity: 0; } to { opacity: 1; } }
              @keyframes modalSlideUp { from { opacity: 0; transform: translateY(24px) scale(0.96); } to { opacity: 1; transform: translateY(0) scale(1); } }
              @keyframes simSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
            `,
          }}
        />
      </div>
    </div>
  );
}
