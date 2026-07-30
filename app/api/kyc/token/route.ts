import { NextRequest, NextResponse } from "next/server";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import { enforceRouteRateLimit } from "@/lib/rate-limit";
import { getServerSupabaseClient, getServiceRoleClient } from "@/lib/supabase/server";
import { createApplicant, getApplicantId, generateSdkToken } from "@/lib/kyc/provider";
import { isRedirectError } from "next/dist/client/components/redirect-error";

/**
 * POST /api/kyc/token
 *
 * Returns a short-lived SumSub Web SDK token so the browser can
 * initialise the KYC iframe without exposing server credentials.
 *
 * Flow:
 *  1. Authenticate the user via session cookie
 *  2. Look up or create a SumSub applicant for this user
 *  3. Persist the applicantId on profiles.kyc_provider_id
 *  4. Generate a short-lived SDK token
 *  5. Return { applicantId, token, expiresAt } to the browser
 */
export async function POST(request: NextRequest) {
  try {
    // ── 0. Rate limit ────────────────────────────────────────────────────────
    const rateLimited = await enforceRouteRateLimit(request);
    if (rateLimited) return rateLimited;

    // ── 1. Auth ──────────────────────────────────────────────────────────────
    const { user } = await requireAuthenticatedUser("borrower");

    const supabase = await getServerSupabaseClient();
    if (!supabase) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    }

    // ── 2. Load profile ──────────────────────────────────────────────────────
    const { data: profile } = await supabase
      .from("profiles")
      .select("full_name, kyc_provider_id, kyc_status")
      .eq("id", user.id)
      .maybeSingle();

    const fullName = String(profile?.full_name ?? "").trim() || "Unknown";
    const existingApplicantId = profile?.kyc_provider_id as string | null;

    // Don't re-create for already verified users — just return a refresh token
    let applicantId = existingApplicantId;

    if (!applicantId) {
      // Try to find an existing applicant by externalUserId in the provider
      const foundId = await getApplicantId(user.id);
      applicantId = foundId ?? await createApplicant(
        user.id,
        user.email ?? "",
        fullName
      );

      // Persist the applicantId using service role to bypass RLS
      const serviceClient = getServiceRoleClient();
      if (serviceClient) {
        await serviceClient
          .from("profiles")
          .update({
            kyc_provider_id: applicantId,
            kyc_status: profile?.kyc_status === "pending" ? "submitted" : profile?.kyc_status,
            kyc_submitted_at: new Date().toISOString(),
          })
          .eq("id", user.id);
      }
    }

    // ── 3. Generate SDK token ────────────────────────────────────────────────
    const tokenResult = await generateSdkToken(applicantId!, user.id);

    return NextResponse.json(tokenResult, { status: 200 });
  } catch (error) {
    if (isRedirectError(error)) throw error;
    console.error("[KYC Token] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to generate KYC token" },
      { status: 500 }
    );
  }
}

/**
 * GET /api/kyc/token — return current KYC status for the authenticated user
 */
export async function GET(request: NextRequest) {
  try {
    // ── 0. Rate limit ────────────────────────────────────────────────────────
    const rateLimited = await enforceRouteRateLimit(request);
    if (rateLimited) return rateLimited;

    const { user } = await requireAuthenticatedUser();
    const supabase = await getServerSupabaseClient();
    if (!supabase) {
      return NextResponse.json({ error: "Database unavailable" }, { status: 503 });
    }

    const { data: profile } = await supabase
      .from("profiles")
      .select("kyc_status, kyc_provider_id, kyc_submitted_at, kyc_verified_at, kyc_rejection_reason, regulated_pool_access")
      .eq("id", user.id)
      .maybeSingle();

    return NextResponse.json({
      kycStatus: profile?.kyc_status ?? "pending",
      applicantId: profile?.kyc_provider_id ?? null,
      submittedAt: profile?.kyc_submitted_at ?? null,
      verifiedAt: profile?.kyc_verified_at ?? null,
      rejectionReason: profile?.kyc_rejection_reason ?? null,
      regulatedPoolAccess: profile?.regulated_pool_access ?? false,
    });
  } catch (error) {
    if (isRedirectError(error)) throw error;
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
}
