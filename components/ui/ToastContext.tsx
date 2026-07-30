"use client";

import React, { createContext, useContext, useState, useCallback, useRef, useEffect, type ReactNode } from "react";

export type ToastType = "success" | "error" | "warning" | "info";

export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration?: number;
}

interface ToastContextValue {
  toasts: Toast[];
  toast: (toast: Omit<Toast, "id">) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_DURATION = 5000;
const TOAST_QUEUE_DELAY = 300;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [isShowing, setIsShowing] = useState(false);
  const queueRef = useRef<Toast[]>([]);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const shownIdsRef = useRef<Set<string>>(new Set());

  const processQueue = useCallback(() => {
    if (toasts.length >= 3 || queueRef.current.length === 0) {
      setIsShowing(false);
      return;
    }

    setIsShowing(true);

    const nextToast = queueRef.current.shift();
    if (!nextToast) return;

    const newToast: Toast = {
      ...nextToast,
      id: nextToast.id || `toast-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    };

    shownIdsRef.current.add(newToast.id);

    setToasts((prev) => [...prev, newToast]);

    const duration = newToast.duration ?? TOAST_DURATION;

    timeoutRef.current = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== newToast.id));
      shownIdsRef.current.delete(newToast.id);

      // Process next toast in queue
      setTimeout(() => {
        setToasts((prev) => {
          if (prev.length === 0) {
            processQueue();
          }
          return prev;
        });
      }, TOAST_QUEUE_DELAY);
    }, duration);
  }, [toasts.length]);

  const toast = useCallback((toastData: Omit<Toast, "id">): string => {
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    // Skip if already showing this toast
    if (shownIdsRef.current.has(id)) {
      return id;
    }

    const newToast: Toast = { ...toastData, id };

    // If we have space, show immediately
    if (toasts.length < 3 && queueRef.current.length === 0 && !isShowing) {
      shownIdsRef.current.add(id);
      setToasts((prev) => [...prev, newToast]);

      const duration = newToast.duration ?? TOAST_DURATION;
      timeoutRef.current = setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
        shownIdsRef.current.delete(id);

        // Check queue for more toasts
        if (queueRef.current.length > 0) {
          setTimeout(processQueue, TOAST_QUEUE_DELAY);
        } else if (toasts.length === 1) {
          setIsShowing(false);
        }
      }, duration);

      return id;
    }

    // Add to queue
    queueRef.current.push(newToast);

    // Start processing if not already
    if (!isShowing && toasts.length === 0) {
      processQueue();
    }

    return id;
  }, [toasts.length, isShowing, processQueue]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    shownIdsRef.current.delete(id);

    // Process queue after dismiss
    if (queueRef.current.length > 0 && toasts.length <= 1) {
      setTimeout(processQueue, TOAST_QUEUE_DELAY);
    }
  }, [toasts.length, processQueue]);

  const clear = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
    setToasts([]);
    queueRef.current = [];
    shownIdsRef.current.clear();
    setIsShowing(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  return (
    <ToastContext.Provider value={{ toasts, toast, dismiss, clear }}>
      {children}
      <ToastContainer />
    </ToastContext.Provider>
  );
}

function ToastContainer() {
  const { toasts, dismiss } = useContext(ToastContext)!;

  if (toasts.length === 0) return null;

  return (
    <div
      aria-live="polite"
      aria-atomic="true"
      className="toast-container"
      style={{
        position: "fixed",
        bottom: "1.5rem",
        right: "1.5rem",
        zIndex: 9999,
        display: "flex",
        flexDirection: "column",
        gap: "0.75rem",
        maxWidth: "400px",
        width: "100%",
        pointerEvents: "none",
      }}
    >
      {toasts.map((t, index) => (
        <ToastItem key={t.id} toast={t} onDismiss={dismiss} index={index} />
      ))}
    </div>
  );
}

interface ToastItemProps {
  toast: Toast;
  onDismiss: (id: string) => void;
  index: number;
}

function ToastItem({ toast, onDismiss, index }: ToastItemProps) {
  useEffect(() => {
    const timer = setTimeout(() => {
      onDismiss(toast.id);
    }, toast.duration ?? TOAST_DURATION);

    return () => clearTimeout(timer);
  }, [toast.id, toast.duration, onDismiss]);

  const icons: Record<ToastType, string> = {
    success: "✓",
    error: "✕",
    warning: "⚠",
    info: "ℹ",
  };

  const colors: Record<ToastType, string> = {
    success: "#22c55e",
    error: "#ef4444",
    warning: "#f59e0b",
    info: "#3b82f6",
  };

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="toast-item"
      style={{
        pointerEvents: "auto",
        transform: `translateY(${index * 10}px)`,
        opacity: 1,
        transition: "transform 0.3s ease, opacity 0.3s ease",
        background: "#1f2937",
        borderRadius: "0.75rem",
        padding: "1rem",
        boxShadow: "0 10px 40px rgba(0,0,0,0.3)",
        border: `1px solid ${colors[toast.type]}33`,
        display: "flex",
        gap: "0.75rem",
        alignItems: "flex-start",
      }}
    >
      <div
        style={{
          width: "24px",
          height: "24px",
          borderRadius: "50%",
          background: `${colors[toast.type]}20`,
          color: colors[toast.type],
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "12px",
          fontWeight: 700,
          flexShrink: 0,
        }}
      >
        {icons[toast.type]}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <p
          style={{
            margin: 0,
            fontWeight: 600,
            fontSize: "0.9rem",
            color: "#fff",
          }}
        >
          {toast.title}
        </p>
        {toast.message && (
          <p
            style={{
              margin: "0.25rem 0 0",
              fontSize: "0.8rem",
              color: "#9ca3af",
              lineHeight: 1.4,
            }}
          >
            {toast.message}
          </p>
        )}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
        style={{
          background: "transparent",
          border: "none",
          color: "#6b7280",
          cursor: "pointer",
          padding: "0.25rem",
          fontSize: "1rem",
          lineHeight: 1,
          flexShrink: 0,
        }}
      >
        ×
      </button>
    </div>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within a ToastProvider");
  }
  return context;
}