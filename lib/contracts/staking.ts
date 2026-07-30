import {
  simulateContractCall,
  callContract,
  addressToScVal,
  i128ToScVal,
} from "@/lib/stellar/soroban";

const CONTRACT_ID = process.env.NEXT_PUBLIC_TLEND_STAKING_CONTRACT_ID!;

if (!CONTRACT_ID) {
  console.warn(
    "[TrustLend] NEXT_PUBLIC_TLEND_STAKING_CONTRACT_ID is not set. " +
      "Deploy the staking contract and add the ID to .env.local"
  );
}

// ─── Reads (simulation only) ──────────────────────────────────────────────────

export async function getStakeToken(callerAddress: string): Promise<string> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_stake_token",
    args: [],
    callerAddress,
  });
  return String(result);
}

export async function getRewardToken(callerAddress: string): Promise<string> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_reward_token",
    args: [],
    callerAddress,
  });
  return String(result);
}

export async function getTotalStaked(callerAddress: string): Promise<bigint> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_total_staked",
    args: [],
    callerAddress,
  });
  return BigInt(result as string | number | bigint);
}

export async function getRewardRate(callerAddress: string): Promise<bigint> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_reward_rate",
    args: [],
    callerAddress,
  });
  return BigInt(result as string | number | bigint);
}

export async function getPeriodFinish(callerAddress: string): Promise<number> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_period_finish",
    args: [],
    callerAddress,
  });
  return Number(result);
}

export async function getRewardsDuration(callerAddress: string): Promise<number> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "get_rewards_duration",
    args: [],
    callerAddress,
  });
  return Number(result);
}

export async function balanceOf(account: string, callerAddress: string): Promise<bigint> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "balance_of",
    args: [addressToScVal(account)],
    callerAddress,
  });
  return BigInt(result as string | number | bigint);
}

export async function earned(account: string, callerAddress: string): Promise<bigint> {
  const result = await simulateContractCall({
    contractId: CONTRACT_ID,
    method: "earned",
    args: [addressToScVal(account)],
    callerAddress,
  });
  return BigInt(result as string | number | bigint);
}

// ─── Writes (sign + submit) ───────────────────────────────────────────────────

export async function stake(userAddress: string, amount: bigint) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "stake",
    args: [addressToScVal(userAddress), i128ToScVal(amount)],
    callerAddress: userAddress,
  });
}

export async function withdraw(userAddress: string, amount: bigint) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "withdraw",
    args: [addressToScVal(userAddress), i128ToScVal(amount)],
    callerAddress: userAddress,
  });
}

export async function claimReward(userAddress: string) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "claim_reward",
    args: [addressToScVal(userAddress)],
    callerAddress: userAddress,
  });
}

export async function exit(userAddress: string) {
  return callContract({
    contractId: CONTRACT_ID,
    method: "exit",
    args: [addressToScVal(userAddress)],
    callerAddress: userAddress,
  });
}

export { CONTRACT_ID as STAKING_CONTRACT_ID };
