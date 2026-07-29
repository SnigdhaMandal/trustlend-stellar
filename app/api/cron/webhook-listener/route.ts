import { NextRequest, NextResponse } from "next/server";
import { getServiceRoleClient } from "@/lib/supabase/server";
import { runWebhookListenerOnce } from "@/lib/webhooks/event-listener";

/**
 * POST /api/cron/webhook-listener
 *
 * Polls the Lending contract for new events (large loans, defaults) and
 * sweeps recent active loans for liquidation-territory transitions, then
 * fans out Discord/Telegram alerts to subscribed admin-managed webhooks
 * (issue #108). Triggered by Vercel Cron; secured via CRON_SECRET like the
 * other cron routes.
 */
export async function POST(request: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const authHeader = request.headers.get("authorization");
    if (authHeader !== `Bearer ${secret}`) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const supabase = getServiceRoleClient();
  if (!supabase) {
    return NextResponse.json({ ok: false, error: "Database unavailable" }, { status: 503 });
  }

  const start = Date.now();
  try {
    const result = await runWebhookListenerOnce(supabase);
    const duration = Date.now() - start;
    console.log(`[webhook-listener] Run complete in ${duration}ms:`, result);
    return NextResponse.json({ ok: true, ...result, duration });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    console.error("[webhook-listener] Run failed:", msg);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}

// Allow Vercel's cron invocations (GET-based) as well
export const GET = POST;
