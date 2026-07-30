"use client";

import { useRpcHealth } from "@/components/RpcHealthProvider";
import { X, AlertTriangle, WifiOff } from "lucide-react";

export function RpcWarningBanner() {
  const { status, message, isDismissed, dismiss } = useRpcHealth();

  if (status === "healthy" || status === "checking" || isDismissed) return null;

  const isDown = status === "down";

  return (
    <div
      className="rpc-banner"
      data-variant={isDown ? "down" : "degraded"}
      role="alert"
      aria-live="polite"
    >
      <span className="rpc-banner-icon">
        {isDown ? <WifiOff size={18} /> : <AlertTriangle size={18} />}
      </span>
      <div className="rpc-banner-body">
        <p className="rpc-banner-title">
          {isDown ? "RPC Endpoint Unavailable" : "RPC Endpoint Degraded"}
        </p>
        <p className="rpc-banner-message">{message}</p>
      </div>
      <button
        className="rpc-banner-dismiss"
        onClick={dismiss}
        aria-label="Dismiss warning"
      >
        <X size={16} />
      </button>
    </div>
  );
}
