import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api";
import { createWebhookSubscription, listWebhookSubscriptions } from "@/lib/db/webhooks";
import { isWebhookChannel, isWebhookTopic } from "@/lib/webhooks/types";

/**
 * GET  /api/admin/webhooks — list all Discord/Telegram webhook subscriptions.
 * POST /api/admin/webhooks — create a new one.
 * (issue #108 admin endpoints for managing webhook URLs and topics)
 */
export async function GET() {
  const auth = await requireAdminApi();
  if (!auth.ok) return auth.response;

  try {
    const subscriptions = await listWebhookSubscriptions(auth.supabase);
    return NextResponse.json({ subscriptions });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to list webhook subscriptions";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAdminApi();
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { channel, target, topics, label, minLoanAmountStroops, enabled } =
    (body ?? {}) as Record<string, unknown>;

  if (!isWebhookChannel(channel)) {
    return NextResponse.json({ error: "channel must be 'discord' or 'telegram'" }, { status: 400 });
  }
  if (typeof target !== "string" || target.trim().length === 0) {
    return NextResponse.json({ error: "target is required" }, { status: 400 });
  }
  if (!Array.isArray(topics) || topics.length === 0 || !topics.every(isWebhookTopic)) {
    return NextResponse.json(
      { error: "topics must be a non-empty array of valid topics" },
      { status: 400 }
    );
  }
  if (label !== undefined && typeof label !== "string") {
    return NextResponse.json({ error: "label must be a string" }, { status: 400 });
  }
  if (minLoanAmountStroops !== undefined && minLoanAmountStroops !== null) {
    if (typeof minLoanAmountStroops !== "string" || !/^\d+$/.test(minLoanAmountStroops)) {
      return NextResponse.json(
        { error: "minLoanAmountStroops must be a numeric string (stroops)" },
        { status: 400 }
      );
    }
  }
  if (enabled !== undefined && typeof enabled !== "boolean") {
    return NextResponse.json({ error: "enabled must be a boolean" }, { status: 400 });
  }

  try {
    const subscription = await createWebhookSubscription(
      auth.supabase,
      {
        channel,
        target: target.trim(),
        topics,
        label: (label as string | undefined) ?? null,
        minLoanAmountStroops: (minLoanAmountStroops as string | null | undefined) ?? null,
        enabled: (enabled as boolean | undefined) ?? true,
      },
      auth.user.id
    );
    return NextResponse.json({ subscription }, { status: 201 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to create webhook subscription";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
