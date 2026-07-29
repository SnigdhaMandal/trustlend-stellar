#!/usr/bin/env -S npx tsx
// =============================================================================
// TrustLend — Discord/Telegram Loan & Liquidation Webhook Listener (issue #108)
// =============================================================================
// Standalone runner for `lib/webhooks/event-listener.ts`, for deployments that
// prefer a long-running background service over Vercel Cron (which only
// invokes `/api/cron/webhook-listener` every 5 minutes on the schedule in
// vercel.json, and needs a paid plan for anything more frequent than daily).
//
// ── Usage ────────────────────────────────────────────────────────────────────
//   npm run webhooks:listen                    # one-shot run (cron-friendly)
//   npm run webhooks:listen -- --interval=30    # background service, poll every 30s
//
// ── Required env ─────────────────────────────────────────────────────────────
//   NEXT_PUBLIC_LENDING_CONTRACT_ID, NEXT_PUBLIC_REPUTATION_CONTRACT_ID,
//   NEXT_PUBLIC_ADMIN_ADDRESS, NEXT_PUBLIC_SUPABASE_URL,
//   SUPABASE_SERVICE_ROLE_KEY
// See `.env.example` for the full WEBHOOK_* configuration surface.
// =============================================================================

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createClient } from "@supabase/supabase-js";
import { runWebhookListenerOnce } from "../lib/webhooks/event-listener";

// ─── .env loader (mirrors scripts/liquidation-keeper.ts) ─────────────────────

function loadEnv(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  const content = fs.readFileSync(filePath, "utf8");
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnv(path.resolve(process.cwd(), ".env.local"));
loadEnv(path.resolve(process.cwd(), ".env.contracts"));

// ─── CLI args ─────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const args: Record<string, string | boolean> = {};
  for (const raw of argv) {
    if (!raw.startsWith("--")) continue;
    const [key, ...rest] = raw.slice(2).split("=");
    args[key] = rest.length ? rest.join("=") : true;
  }
  return args;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const intervalRaw = (args.interval as string) ?? process.env.WEBHOOK_LISTENER_POLL_INTERVAL_SECS;
  const intervalSecs = intervalRaw ? Number(intervalRaw) : null;

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      "Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY — required to persist the " +
        "listener cursor and dedupe state."
    );
  }
  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  console.log(
    `[webhook-listener] Starting — interval=${intervalSecs ? `${intervalSecs}s` : "one-shot"}`
  );

  for (;;) {
    const start = Date.now();
    try {
      const summary = await runWebhookListenerOnce(supabase);
      console.log(
        `[webhook-listener] Run complete in ${Date.now() - start}ms:`,
        JSON.stringify(summary)
      );
    } catch (err) {
      console.error("[webhook-listener] Run failed:", err instanceof Error ? err.message : err);
      if (!intervalSecs) process.exitCode = 1;
    }

    if (!intervalSecs) break;
    await sleep(intervalSecs * 1000);
  }
}

const isDirectRun = (() => {
  try {
    return import.meta.url === `file://${process.argv[1]}`;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((err) => {
    console.error("[webhook-listener] Fatal error:", err);
    process.exit(1);
  });
}
