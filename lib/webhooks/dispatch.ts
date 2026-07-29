/**
 * Fans a loan/liquidation event out to every enabled subscription for its
 * topic, across both channels. One bad webhook (rate-limited, deleted,
 * unreachable) never blocks delivery to the others.
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { listSubscriptionsForTopic } from "@/lib/db/webhooks";
import { LoanNotificationPayload } from "@/lib/webhooks/types";
import { buildLoanDiscordEmbed, sendDiscordWebhook } from "@/lib/webhooks/discord";
import { buildLoanTelegramMessage, sendTelegramMessage } from "@/lib/webhooks/telegram";

export interface DispatchResult {
  subscriptionId: string;
  channel: string;
  ok: boolean;
  error?: string;
}

export async function notifyTopic(
  supabase: SupabaseClient,
  payload: LoanNotificationPayload
): Promise<DispatchResult[]> {
  const subscriptions = await listSubscriptionsForTopic(supabase, payload.topic);
  if (subscriptions.length === 0) return [];

  const results = await Promise.allSettled(
    subscriptions.map(async (sub): Promise<DispatchResult> => {
      if (sub.channel === "discord") {
        await sendDiscordWebhook(sub.target, buildLoanDiscordEmbed(payload));
      } else {
        await sendTelegramMessage(sub.target, buildLoanTelegramMessage(payload));
      }
      return { subscriptionId: sub.id, channel: sub.channel, ok: true };
    })
  );

  return results.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    const sub = subscriptions[i];
    const error = r.reason instanceof Error ? r.reason.message : String(r.reason);
    console.warn(
      `[webhooks] Delivery failed for subscription ${sub.id} (${sub.channel}): ${error}`
    );
    return { subscriptionId: sub.id, channel: sub.channel, ok: false, error };
  });
}
