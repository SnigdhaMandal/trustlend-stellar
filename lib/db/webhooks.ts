/**
 * Supabase queries for the Discord/Telegram webhook feature (issue #108):
 * admin-managed subscriptions, the event-listener's ledger cursor, one-shot
 * dedupe, and per-loan health-zone state. Mirrors the style of `lib/db/pools.ts`
 * — functions take an injected `SupabaseClient` rather than a global singleton.
 */

import { SupabaseClient } from "@supabase/supabase-js";
import {
  WebhookSubscription,
  WebhookSubscriptionInput,
  WebhookTopic,
} from "@/lib/webhooks/types";

const SUBSCRIPTION_COLUMNS =
  "id, label, channel, target, topics, min_loan_amount_stroops, enabled, created_by, created_at, updated_at";

interface RawSubscription {
  id: string;
  label: string | null;
  channel: string;
  target: string;
  topics: string[] | null;
  min_loan_amount_stroops: string | number | null;
  enabled: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

function mapSubscription(raw: RawSubscription): WebhookSubscription {
  return {
    id: raw.id,
    label: raw.label,
    channel: raw.channel as WebhookSubscription["channel"],
    target: raw.target,
    topics: (raw.topics ?? []) as WebhookSubscription["topics"],
    minLoanAmountStroops:
      raw.min_loan_amount_stroops === null ? null : String(raw.min_loan_amount_stroops),
    enabled: raw.enabled,
    createdBy: raw.created_by,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
}

// ── Subscriptions (admin CRUD) ────────────────────────────────────────────────

export async function listWebhookSubscriptions(
  supabase: SupabaseClient
): Promise<WebhookSubscription[]> {
  const { data, error } = await supabase
    .from("webhook_subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .order("created_at", { ascending: false });

  if (error) throw new Error(`Failed to fetch webhook subscriptions: ${error.message}`);
  return (data ?? []).map((row) => mapSubscription(row as unknown as RawSubscription));
}

export async function getWebhookSubscriptionById(
  supabase: SupabaseClient,
  id: string
): Promise<WebhookSubscription | null> {
  const { data, error } = await supabase
    .from("webhook_subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(`Failed to fetch webhook subscription ${id}: ${error.message}`);
  return data ? mapSubscription(data as unknown as RawSubscription) : null;
}

export async function createWebhookSubscription(
  supabase: SupabaseClient,
  input: WebhookSubscriptionInput,
  createdBy: string
): Promise<WebhookSubscription> {
  const { data, error } = await supabase
    .from("webhook_subscriptions")
    .insert({
      label: input.label ?? null,
      channel: input.channel,
      target: input.target,
      topics: input.topics,
      min_loan_amount_stroops: input.minLoanAmountStroops ?? null,
      enabled: input.enabled ?? true,
      created_by: createdBy,
    })
    .select(SUBSCRIPTION_COLUMNS)
    .single();

  if (error) throw new Error(`Failed to create webhook subscription: ${error.message}`);
  return mapSubscription(data as unknown as RawSubscription);
}

export async function updateWebhookSubscription(
  supabase: SupabaseClient,
  id: string,
  patch: Partial<WebhookSubscriptionInput>
): Promise<WebhookSubscription> {
  const update: Record<string, unknown> = {};
  if (patch.label !== undefined) update.label = patch.label;
  if (patch.channel !== undefined) update.channel = patch.channel;
  if (patch.target !== undefined) update.target = patch.target;
  if (patch.topics !== undefined) update.topics = patch.topics;
  if (patch.minLoanAmountStroops !== undefined) {
    update.min_loan_amount_stroops = patch.minLoanAmountStroops;
  }
  if (patch.enabled !== undefined) update.enabled = patch.enabled;

  const { data, error } = await supabase
    .from("webhook_subscriptions")
    .update(update)
    .eq("id", id)
    .select(SUBSCRIPTION_COLUMNS)
    .single();

  if (error) throw new Error(`Failed to update webhook subscription ${id}: ${error.message}`);
  return mapSubscription(data as unknown as RawSubscription);
}

export async function deleteWebhookSubscription(
  supabase: SupabaseClient,
  id: string
): Promise<void> {
  const { error } = await supabase.from("webhook_subscriptions").delete().eq("id", id);
  if (error) throw new Error(`Failed to delete webhook subscription ${id}: ${error.message}`);
}

/** Enabled subscriptions that want alerts for `topic`. */
export async function listSubscriptionsForTopic(
  supabase: SupabaseClient,
  topic: WebhookTopic
): Promise<WebhookSubscription[]> {
  const { data, error } = await supabase
    .from("webhook_subscriptions")
    .select(SUBSCRIPTION_COLUMNS)
    .eq("enabled", true)
    .contains("topics", [topic]);

  if (error) throw new Error(`Failed to fetch subscriptions for topic ${topic}: ${error.message}`);
  return (data ?? []).map((row) => mapSubscription(row as unknown as RawSubscription));
}

// ── Listener cursor ────────────────────────────────────────────────────────────

export async function getListenerLastLedger(supabase: SupabaseClient): Promise<number> {
  const { data, error } = await supabase
    .from("webhook_listener_state")
    .select("last_ledger")
    .eq("id", 1)
    .maybeSingle();

  if (error) throw new Error(`Failed to read listener cursor: ${error.message}`);
  return Number(data?.last_ledger ?? 0);
}

export async function setListenerLastLedger(
  supabase: SupabaseClient,
  lastLedger: number
): Promise<void> {
  const { error } = await supabase
    .from("webhook_listener_state")
    .upsert({ id: 1, last_ledger: lastLedger, updated_at: new Date().toISOString() });

  if (error) throw new Error(`Failed to persist listener cursor: ${error.message}`);
}

// ── One-shot dedupe ────────────────────────────────────────────────────────────

/** True if this exact alert has already been sent (safe to skip). */
export async function wasAlreadyNotified(
  supabase: SupabaseClient,
  dedupeKey: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("webhook_notification_dedupe")
    .select("dedupe_key")
    .eq("dedupe_key", dedupeKey)
    .maybeSingle();

  if (error) throw new Error(`Failed to check dedupe key ${dedupeKey}: ${error.message}`);
  return data !== null;
}

/** Record that `dedupeKey` has been sent. Insert is idempotent (ignore conflicts). */
export async function recordNotification(
  supabase: SupabaseClient,
  dedupeKey: string,
  topic: WebhookTopic,
  loanId: number
): Promise<void> {
  const { error } = await supabase
    .from("webhook_notification_dedupe")
    .upsert({ dedupe_key: dedupeKey, topic, loan_id: loanId }, { onConflict: "dedupe_key" });

  if (error) throw new Error(`Failed to record notification ${dedupeKey}: ${error.message}`);
}

// ── Per-loan health-zone edge-trigger state ───────────────────────────────────

export async function getLoanHealthZone(
  supabase: SupabaseClient,
  loanId: number
): Promise<string | null> {
  const { data, error } = await supabase
    .from("webhook_loan_health_state")
    .select("last_zone")
    .eq("loan_id", loanId)
    .maybeSingle();

  if (error) throw new Error(`Failed to read health zone for loan ${loanId}: ${error.message}`);
  return data?.last_zone ?? null;
}

export async function setLoanHealthZone(
  supabase: SupabaseClient,
  loanId: number,
  zone: string
): Promise<void> {
  const { error } = await supabase
    .from("webhook_loan_health_state")
    .upsert(
      { loan_id: loanId, last_zone: zone, updated_at: new Date().toISOString() },
      { onConflict: "loan_id" }
    );

  if (error) throw new Error(`Failed to persist health zone for loan ${loanId}: ${error.message}`);
}
