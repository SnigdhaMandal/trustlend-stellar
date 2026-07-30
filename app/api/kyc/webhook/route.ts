import { NextRequest, NextResponse } from "next/server";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { getServiceRoleClient } from "@/lib/supabase/server";
import {
  verifyWebhookSignature,
  mapProviderStatus,
  extractRejectionReason,
} from "@/lib/kyc/provider";
import type { SumSubWebhookPayload } from "@/lib/kyc/types";

/**
 * POST /api/kyc/webhook
 *
 * Receives KYC status updates from SumSub (or compatible provider).
 * SumSub sends a POST with JSON body + `x-payload-digest` header (HMAC-SHA256).
 *
 * Flow:
 *  1. Read raw body (needed for signature verification)
 *  2. Verify HMAC-SHA256 signature
 *  3. Parse payload → map to internal KYC status
 *  4. Update profiles table using service-role client (bypasses RLS)
 *  5. Grant/revoke regulated_pool_access based on outcome
 *
 * Returns 200 quickly — SumSub retries on non-2xx.
 */
export async function POST(request: NextRequest) {
  // ── 1. Read raw body for signature verification ────────────────────────────
  const rawBody = await request.text();
  const digestHeader =
    request.headers.get("x-payload-digest") ??
    request.headers.get("x-hmac-signature") ??
    "";

  // ── 2. Verify HMAC signature ───────────────────────────────────────────────
  if (!verifyWebhookSignature(rawBody, digestHeader)) {
    console.error("[KYC Webhook] Invalid signature — rejecting request");
    return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
  }

  // ── 3. Parse payload ───────────────────────────────────────────────────────
  let payload: SumSubWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as SumSubWebhookPayload;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { applicantId, externalUserId, type } = payload;

  if (!applicantId || !externalUserId) {
    return NextResponse.json(
      { error: "Missing applicantId or externalUserId" },
      { status: 400 }
    );
  }

  console.log(
    `[KYC Webhook] type=${type} applicantId=${applicantId} userId=${externalUserId}`
  );

  // ── 4. Map provider status → internal status ───────────────────────────────
  const newKycStatus = mapProviderStatus(payload);
  const rejectionReason = extractRejectionReason(payload);
  const isVerified = newKycStatus === "verified";

  // ── 5. Update profile in database (service role bypasses RLS) ─────────────
  const supabase = getServiceRoleClient();
  if (!supabase) {
    // Don't fail the webhook — log and return 200 so SumSub doesn't retry endlessly
    console.error("[KYC Webhook] Supabase service client unavailable");
    return NextResponse.json({ received: true }, { status: 200 });
  }

  const updatePayload: Record<string, unknown> = {
    kyc_status: newKycStatus,
    kyc_provider_id: applicantId,
    kyc_provider_status: type,
    regulated_pool_access: isVerified,
  };

  if (isVerified) {
    updatePayload.kyc_verified_at = new Date().toISOString();
    updatePayload.kyc_rejection_reason = null;
  } else if (newKycStatus === "rejected" && rejectionReason) {
    updatePayload.kyc_rejection_reason = rejectionReason;
  } else if (newKycStatus === "submitted") {
    updatePayload.kyc_submitted_at = new Date().toISOString();
  }

  // Try lookup by our user UUID first (reliable), fallback to provider ID
  const { error: updateError } = await supabase
    .from("profiles")
    .update(updatePayload)
    .eq("id", externalUserId);

  if (updateError) {
    // Fallback: look up by kyc_provider_id (handles re-used applicants)
    const { error: fallbackError } = await supabase
      .from("profiles")
      .update(updatePayload)
      .eq("kyc_provider_id", applicantId);

    if (fallbackError) {
      console.error("[KYC Webhook] Failed to update profile:", fallbackError.message);
      // Still return 200 — log error but don't trigger SumSub retries for DB issues
    }
  }

  if (isVerified) {
    // Seed initial reputation snapshot on first verification
    await supabase.rpc("seed_reputation_snapshot", {
      p_user_id: externalUserId,
      p_initial_score: 100,
    }).then(({ error }) => {
      if (error) {
        // Non-fatal — reputation will be seeded on next profile interaction
        console.warn("[KYC Webhook] Could not seed reputation:", error.message);
      }
    });
  }

  console.log(
    `[KYC Webhook] ✅ Updated userId=${externalUserId} → status=${newKycStatus}`
  );

  // Always return 200 to acknowledge receipt
  return NextResponse.json({ received: true, status: newKycStatus }, { status: 200 });
}

/**
 * GET /api/kyc/webhook — health check for provider dashboard
 */
export async function GET(request: NextRequest) {
  // Lightweight rate limiting for webhook health-check endpoint
  const rateLimited = await enforceRouteRateLimit(request);
  if (rateLimited) return rateLimited;

  return NextResponse.json({
    ok: true,
    service: "TrustLend KYC Webhook",
    provider: "SumSub",
  });
}
