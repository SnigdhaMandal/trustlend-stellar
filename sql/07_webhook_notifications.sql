-- =====================================================================
-- TrustLend: Issue #108 — Discord/Telegram Loan & Liquidation Webhooks
-- Adds tables for admin-managed webhook subscriptions, the Soroban event
-- listener's ledger cursor, and dedupe/edge-trigger state so the listener
-- (lib/webhooks/event-listener.ts, run via /api/cron/webhook-listener or
-- scripts/webhook-listener.ts) never double-posts the same alert.
-- Apply after 01_core_schema.sql
-- =====================================================================

-- 1. Admin-managed webhook subscriptions (Discord webhook URL, or Telegram
--    chat id — the bot token itself lives in TELEGRAM_BOT_TOKEN, never here).
CREATE TABLE IF NOT EXISTS public.webhook_subscriptions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  label             TEXT,
  channel           TEXT NOT NULL CHECK (channel IN ('discord', 'telegram')),
  -- Discord: full incoming-webhook URL. Telegram: numeric chat id (as text).
  target            TEXT NOT NULL,
  -- Topics this subscription wants alerts for. See lib/webhooks/types.ts
  -- for the canonical list ('large_loan', 'liquidation_warning',
  -- 'liquidation_critical').
  topics            TEXT[] NOT NULL DEFAULT '{}',
  -- Optional per-subscription override of the large-loan threshold (stroops).
  -- NULL falls back to WEBHOOK_LARGE_LOAN_THRESHOLD_XLM.
  min_loan_amount_stroops BIGINT,
  enabled           BOOLEAN NOT NULL DEFAULT TRUE,
  created_by        UUID REFERENCES public.profiles(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_enabled
  ON public.webhook_subscriptions (enabled)
  WHERE enabled = TRUE;

-- GIN index so "topics @> ARRAY['large_loan']" lookups (one per dispatch)
-- don't scan the whole table as subscriptions grow.
CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_topics
  ON public.webhook_subscriptions USING GIN (topics);

-- 2. Event-listener ledger cursor. Single-row table (id is always 1) so the
--    stateless serverless cron knows where it left off between invocations.
CREATE TABLE IF NOT EXISTS public.webhook_listener_state (
  id                SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  last_ledger       BIGINT NOT NULL DEFAULT 0,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO public.webhook_listener_state (id, last_ledger)
VALUES (1, 0)
ON CONFLICT (id) DO NOTHING;

-- 3. Dedupe table for one-shot alerts keyed by the Soroban event id (large
--    loan origination, liquidation/default). Prevents double-posting if a
--    cron run overlaps the previous run's ledger range.
CREATE TABLE IF NOT EXISTS public.webhook_notification_dedupe (
  dedupe_key        TEXT PRIMARY KEY,
  topic             TEXT NOT NULL,
  loan_id           BIGINT,
  sent_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_webhook_notification_dedupe_sent_at
  ON public.webhook_notification_dedupe (sent_at);

-- 4. Edge-triggered health-zone state per loan, so "liquidation_warning" only
--    fires the moment a loan crosses INTO a worse zone, not on every sweep.
CREATE TABLE IF NOT EXISTS public.webhook_loan_health_state (
  loan_id           BIGINT PRIMARY KEY,
  last_zone         TEXT NOT NULL,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 5. RLS: subscriptions are admin-manageable; the state/dedupe tables are
--    service-role only (the listener always uses the service-role client —
--    enabling RLS with no policy denies all non-service-role access).
ALTER TABLE public.webhook_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_listener_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_notification_dedupe ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_loan_health_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Admins manage webhook subscriptions" ON public.webhook_subscriptions;
CREATE POLICY "Admins manage webhook subscriptions"
  ON public.webhook_subscriptions
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles AS p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.profiles AS p
      WHERE p.id = auth.uid() AND p.role = 'admin'
    )
  );

COMMENT ON TABLE public.webhook_subscriptions IS
  'Admin-managed Discord/Telegram webhook targets and their subscribed alert topics (issue #108).';
COMMENT ON TABLE public.webhook_listener_state IS
  'Singleton ledger cursor for the Soroban event listener (issue #108).';
COMMENT ON TABLE public.webhook_notification_dedupe IS
  'One-shot-alert dedupe keyed by Soroban event id (issue #108).';
COMMENT ON TABLE public.webhook_loan_health_state IS
  'Last-known health zone per loan, for edge-triggered liquidation-warning alerts (issue #108).';
