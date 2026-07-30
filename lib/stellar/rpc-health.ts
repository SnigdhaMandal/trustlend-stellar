export type RpcHealthStatus = "checking" | "healthy" | "degraded" | "down";

export interface RpcHealthResult {
  status: RpcHealthStatus;
  message: string;
  lastChecked: number;
}

const SOROBAN_RPC_URL =
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL ??
  "https://soroban-testnet.stellar.org";

function parseErrorMessage(err: unknown): string {
  if (err instanceof TypeError) {
    return "Network error — RPC endpoint unreachable.";
  }
  if (err instanceof DOMException && err.name === "AbortError") {
    return "Request timed out — RPC endpoint is slow or unresponsive.";
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

export async function checkRpcHealth(): Promise<RpcHealthResult> {
  const now = Date.now();
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    const res = await fetch(SOROBAN_RPC_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getHealth",
        params: {},
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      return {
        status: "down",
        message: `RPC endpoint returned ${res.status} ${res.statusText}. Some features may be unavailable.`,
        lastChecked: now,
      };
    }

    const json = (await res.json()) as {
      result?: { status?: string };
      error?: unknown;
    };

    if (json.error) {
      return {
        status: "degraded",
        message: "RPC endpoint returned an unexpected response.",
        lastChecked: now,
      };
    }

    return { status: "healthy", message: "", lastChecked: now };
  } catch (err) {
    const msg = parseErrorMessage(err);
    const isTimeout =
      msg.toLowerCase().includes("timed out") ||
      msg.toLowerCase().includes("abort");
    return {
      status: isTimeout ? "degraded" : "down",
      message: isTimeout
        ? "RPC endpoint is slow or unresponsive. Transactions may be delayed."
        : "RPC endpoint unreachable. Please try again later.",
      lastChecked: now,
    };
  }
}
