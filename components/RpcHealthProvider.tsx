"use client";

import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
} from "react";
import type { RpcHealthStatus } from "@/lib/stellar/rpc-health";
import { checkRpcHealth } from "@/lib/stellar/rpc-health";

interface RpcHealthContextValue {
  status: RpcHealthStatus;
  message: string;
  lastChecked: number;
  isHealthy: boolean;
  isDismissed: boolean;
  dismiss: () => void;
}

const RpcHealthContext = createContext<RpcHealthContextValue | null>(null);

const POLL_INTERVAL = 60_000;

export function RpcHealthProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [status, setStatus] = useState<RpcHealthStatus>("checking");
  const [message, setMessage] = useState("");
  const [lastChecked, setLastChecked] = useState(0);
  const [dismissedStatus, setDismissedStatus] =
    useState<RpcHealthStatus | null>(null);
  const mountedRef = useRef(true);

  const check = useCallback(async () => {
    const result = await checkRpcHealth();
    if (!mountedRef.current) return;
    setStatus(result.status);
    setMessage(result.message);
    setLastChecked(result.lastChecked);
    if (result.status === "healthy") {
      setDismissedStatus(null);
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    check();
    const interval = setInterval(check, POLL_INTERVAL);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
    };
  }, [check]);

  const dismiss = useCallback(() => {
    setDismissedStatus(status);
  }, [status]);

  const isDismissed =
    dismissedStatus === status && status !== "healthy";
  const isHealthy = status === "healthy" || status === "checking";

  return (
    <RpcHealthContext.Provider
      value={{ status, message, lastChecked, isHealthy, isDismissed, dismiss }}
    >
      {children}
    </RpcHealthContext.Provider>
  );
}

export function useRpcHealth(): RpcHealthContextValue {
  const ctx = useContext(RpcHealthContext);
  if (!ctx) {
    throw new Error("useRpcHealth must be used within an RpcHealthProvider");
  }
  return ctx;
}
