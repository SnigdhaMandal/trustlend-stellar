"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, AlertCircle, Coins } from "lucide-react";
import { StakingContract } from "@/lib/contracts";
import { xlmToStroops, stroopsToXlm } from "@/types/contracts";
import { getConnectedWallet } from "@/lib/stellar/wallet";
import { useTransactionSimulation } from "@/lib/stellar/use-transaction-simulation";
import { ConfirmTransactionModal } from "@/components/ui/ConfirmTransactionModal";

const STAKING_CONTRACT_ID = process.env.NEXT_PUBLIC_TLEND_STAKING_CONTRACT_ID ?? "";

export function StakingCard() {
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [staked, setStaked] = useState<bigint>(0n);
  const [rewardsEarned, setRewardsEarned] = useState<bigint>(0n);
  const [totalStaked, setTotalStaked] = useState<bigint>(0n);
  const [stakeAmount, setStakeAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tx = useTransactionSimulation();

  // Passively pick up an already-connected wallet from a prior session,
  // without prompting a new connection.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const stored = window.localStorage.getItem("wallet_address");
    if (stored) setWalletAddress(stored);
  }, []);

  const refresh = useCallback(async (address: string) => {
    try {
      const [bal, earned, total] = await Promise.all([
        StakingContract.balanceOf(address, address),
        StakingContract.earned(address, address),
        StakingContract.getTotalStaked(address),
      ]);
      setStaked(bal);
      setRewardsEarned(earned);
      setTotalStaked(total);
    } catch (err) {
      console.error("[TrustLend] Failed to load staking position:", err);
    }
  }, []);

  useEffect(() => {
    if (walletAddress) refresh(walletAddress);
  }, [walletAddress, refresh]);

  if (!STAKING_CONTRACT_ID) return null;

  const handleConnect = async () => {
    try {
      const wallet = await getConnectedWallet();
      setWalletAddress(wallet.address);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect wallet");
    }
  };

  const handleStake = () => {
    if (!walletAddress) return;
    const amount = parseFloat(stakeAmount);
    if (!amount || amount <= 0) {
      setError("Enter a stake amount greater than 0");
      return;
    }
    setError(null);
    tx.preview({
      label: "Stake LP Tokens",
      contractId: STAKING_CONTRACT_ID,
      method: "stake",
      args: [walletAddress, amount],
      callerAddress: walletAddress,
      details: { Amount: `${amount}` },
    });
  };

  const handleConfirmStake = async () => {
    if (!walletAddress) return;
    setLoading(true);
    setError(null);
    try {
      await tx.confirm(async () => {
        await StakingContract.stake(walletAddress, xlmToStroops(parseFloat(stakeAmount)));
      });
      setStakeAmount("");
      await refresh(walletAddress);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Stake failed");
    } finally {
      setLoading(false);
    }
  };

  const handleWithdraw = () => {
    if (!walletAddress) return;
    const amount = parseFloat(withdrawAmount);
    if (!amount || amount <= 0) {
      setError("Enter a withdraw amount greater than 0");
      return;
    }
    setError(null);
    tx.preview({
      label: "Withdraw Staked Tokens",
      contractId: STAKING_CONTRACT_ID,
      method: "withdraw",
      args: [walletAddress, amount],
      callerAddress: walletAddress,
      details: { Amount: `${amount}` },
    });
  };

  const handleConfirmWithdraw = async () => {
    if (!walletAddress) return;
    setLoading(true);
    setError(null);
    try {
      await tx.confirm(async () => {
        await StakingContract.withdraw(walletAddress, xlmToStroops(parseFloat(withdrawAmount)));
      });
      setWithdrawAmount("");
      await refresh(walletAddress);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Withdraw failed");
    } finally {
      setLoading(false);
    }
  };

  const handleClaim = async () => {
    if (!walletAddress) return;
    setLoading(true);
    setError(null);
    try {
      await StakingContract.claimReward(walletAddress);
      await refresh(walletAddress);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Claim failed");
    } finally {
      setLoading(false);
    }
  };

  if (!walletAddress) {
    return (
      <article className="workspace-card workspace-card--full">
        <h2 className="workspace-card-title">Yield Farming — TLEND Staking</h2>
        <p className="workspace-card-copy" style={{ opacity: 0.7, marginBottom: "1rem" }}>
          Connect your wallet to stake LP tokens and earn TLEND rewards over time.
        </p>
        <button onClick={handleConnect} className="workspace-button workspace-button--primary">
          Connect Wallet
        </button>
      </article>
    );
  }

  return (
    <>
      <article className="workspace-card workspace-card--full">
        <h2 className="workspace-card-title">
          <Coins size={18} style={{ marginRight: "0.4rem", verticalAlign: "-3px" }} />
          Yield Farming — TLEND Staking
        </h2>

        {error && (
          <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", color: "#ff6b6b", fontSize: "0.8rem", margin: "0.5rem 0" }}>
            <AlertCircle size={14} />
            <span>{error}</span>
          </div>
        )}

        <section className="workspace-grid workspace-grid--two" style={{ marginBottom: "1.25rem" }}>
          <div className="workspace-stat">
            <p className="workspace-hint">Your Staked Balance</p>
            <p style={{ fontSize: "1.4rem", fontWeight: 700 }}>{stroopsToXlm(staked)}</p>
          </div>
          <div className="workspace-stat">
            <p className="workspace-hint">Pending Rewards (TLEND)</p>
            <p style={{ fontSize: "1.4rem", fontWeight: 700, color: "#22cf9d" }}>
              {stroopsToXlm(rewardsEarned)}
            </p>
          </div>
        </section>

        <p className="workspace-hint" style={{ marginBottom: "1rem" }}>
          Total pool staked: {stroopsToXlm(totalStaked)}
        </p>

        <div className="workspace-grid workspace-grid--two">
          <form
            className="workspace-form"
            onSubmit={(e) => {
              e.preventDefault();
              handleStake();
            }}
          >
            <label className="workspace-label">Stake</label>
            <input
              type="number"
              min="0"
              step="any"
              value={stakeAmount}
              onChange={(e) => setStakeAmount(e.target.value)}
              className="workspace-input"
              placeholder="Amount to stake"
              disabled={loading}
            />
            <button type="submit" className="workspace-button workspace-button--primary" disabled={loading}>
              {loading ? <Loader2 size={14} className="animate-spin" /> : "Stake"}
            </button>
          </form>

          <form
            className="workspace-form"
            onSubmit={(e) => {
              e.preventDefault();
              handleWithdraw();
            }}
          >
            <label className="workspace-label">Withdraw</label>
            <input
              type="number"
              min="0"
              step="any"
              value={withdrawAmount}
              onChange={(e) => setWithdrawAmount(e.target.value)}
              className="workspace-input"
              placeholder="Amount to withdraw"
              disabled={loading}
            />
            <button type="submit" className="workspace-button workspace-button--secondary" disabled={loading}>
              {loading ? <Loader2 size={14} className="animate-spin" /> : "Withdraw"}
            </button>
          </form>
        </div>

        <button
          onClick={handleClaim}
          disabled={loading || rewardsEarned <= 0n}
          className="workspace-button workspace-button--primary"
          style={{ marginTop: "1rem" }}
        >
          {loading ? <Loader2 size={14} className="animate-spin" /> : "Claim Rewards"}
        </button>
      </article>

      <ConfirmTransactionModal
        open={tx.isModalOpen}
        onClose={tx.dismiss}
        onConfirm={tx.pendingAction?.method === "withdraw" ? handleConfirmWithdraw : handleConfirmStake}
        action={tx.pendingAction}
        confirming={tx.isConfirming || loading}
      />
    </>
  );
}
