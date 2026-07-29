/**
 * Admin guard for JSON API routes (as opposed to `app/actions/*`'s
 * `requireAdmin()`, which throws, or `lib/auth/session.ts`'s
 * `requireTradeVaultAdmin()`, which redirects — neither fits a `fetch`-based
 * admin API). Returns a discriminated result so callers can bail out with
 * `return auth.response` on failure.
 */

import { NextResponse } from "next/server";
import { SupabaseClient, User } from "@supabase/supabase-js";
import { getServerSupabaseClient } from "@/lib/supabase/server";

export type AdminApiAuth =
  | { ok: true; user: User; supabase: SupabaseClient }
  | { ok: false; response: NextResponse };

export async function requireAdminApi(): Promise<AdminApiAuth> {
  const supabase = await getServerSupabaseClient();
  if (!supabase) {
    return { ok: false, response: NextResponse.json({ error: "Database unavailable" }, { status: 503 }) };
  }

  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  }

  const { data: profile } = await supabase
    .from("profiles")
    .select("role")
    .eq("id", user.id)
    .maybeSingle();

  if (profile?.role !== "admin") {
    return { ok: false, response: NextResponse.json({ error: "Forbidden: admin only" }, { status: 403 }) };
  }

  return { ok: true, user, supabase };
}
