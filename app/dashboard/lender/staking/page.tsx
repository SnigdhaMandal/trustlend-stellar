import { WorkspaceFrame } from "@/components/dashboard/WorkspaceFrame";
import { StakingCard } from "@/components/dashboard/StakingCard";
import { requireAuthenticatedUser } from "@/lib/auth/session";
import {
  getLenderDashboardMetrics,
  presentLenderMetrics,
} from "@/lib/dashboard/metrics";
import { getServerSupabaseClient } from "@/lib/supabase/server";
import { lenderNavLinks } from "@/lib/dashboard/lender-links";

export default async function LenderStakingPage() {
  const { user } = await requireAuthenticatedUser("lender");
  const metrics = await getLenderDashboardMetrics(user.id);
  const supabase = await getServerSupabaseClient();

  const profileRes = supabase
    ? await supabase.from("profiles").select("full_name").eq("id", user.id).maybeSingle()
    : { data: null };
  const profile = profileRes.data;

  return (
    <WorkspaceFrame
      roleLabel="Lender Dashboard"
      heading="Staking"
      description="Stake your LP tokens to earn TLEND protocol rewards over time, on top of loan interest."
      email={user.email ?? null}
      userName={String(user.user_metadata?.full_name ?? profile?.full_name ?? "")}
      metrics={presentLenderMetrics(metrics)}
      currentPath="/dashboard/lender/staking"
      profilePath="/dashboard/lender/profile"
      showProfileAlert={false}
      links={lenderNavLinks}
    >
      <div className="workspace-stack">
        <StakingCard />
      </div>
    </WorkspaceFrame>
  );
}
