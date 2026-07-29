import { NextRequest, NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth/admin-api";
import {
  deleteWebhookSubscription,
  getWebhookSubscriptionById,
  updateWebhookSubscription,
} from "@/lib/db/webhooks";
import { isWebhookChannel, isWebhookTopic } from "@/lib/webhooks/types";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * PATCH  /api/admin/webhooks/:id — update target/topics/enabled/label.
 * DELETE /api/admin/webhooks/:id — remove a webhook subscription.
 * (issue #108)
 */
export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const auth = await requireAdminApi();
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const existing = await getWebhookSubscriptionById(auth.supabase, id);
  if (!existing) {
    return NextResponse.json({ error: "Webhook subscription not found" }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const { channel, target, topics, label, minLoanAmountStroops, enabled } =
    (body ?? {}) as Record<string, unknown>;

  if (channel !== undefined && !isWebhookChannel(channel)) {
    return NextResponse.json({ error: "channel must be 'discord' or 'telegram'" }, { status: 400 });
  }
  if (target !== undefined && (typeof target !== "string" || target.trim().length === 0)) {
    return NextResponse.json({ error: "target must be a non-empty string" }, { status: 400 });
  }
  if (topics !== undefined && (!Array.isArray(topics) || !topics.every(isWebhookTopic))) {
    return NextResponse.json({ error: "topics must be an array of valid topics" }, { status: 400 });
  }
  if (label !== undefined && label !== null && typeof label !== "string") {
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
    const subscription = await updateWebhookSubscription(auth.supabase, id, {
      channel: channel as typeof existing.channel | undefined,
      target: target as string | undefined,
      topics: topics as typeof existing.topics | undefined,
      label: label as string | null | undefined,
      minLoanAmountStroops: minLoanAmountStroops as string | null | undefined,
      enabled: enabled as boolean | undefined,
    });
    return NextResponse.json({ subscription });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to update webhook subscription";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(_request: NextRequest, { params }: RouteContext) {
  const auth = await requireAdminApi();
  if (!auth.ok) return auth.response;

  const { id } = await params;
  const existing = await getWebhookSubscriptionById(auth.supabase, id);
  if (!existing) {
    return NextResponse.json({ error: "Webhook subscription not found" }, { status: 404 });
  }

  try {
    await deleteWebhookSubscription(auth.supabase, id);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Failed to delete webhook subscription";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
