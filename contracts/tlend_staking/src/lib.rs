#![no_std]
//! TLEND Staking — Yield Farming for Liquidity Providers
//!
//! Lenders stake a "stake token" (a liquidity-provider token, or TLEND itself
//! for single-asset staking) and accrue a separate reward token (TLEND)
//! continuously over time, proportional to their share of the pool. Uses the
//! standard `rewardPerTokenStored` accumulator pattern (as in Synthetix's
//! `StakingRewards`): rather than iterating over every staker whenever
//! rewards are distributed, the contract tracks a single global
//! "reward per staked token" accumulator that only advances with elapsed
//! time and the current reward rate. Each user's pending reward is derived
//! lazily from the delta between the current accumulator and the value it
//! was at when that user's balance last changed — O(1) per stake/withdraw/
//! claim regardless of how many other stakers exist.
//!
//! The stake token is generic: point it at any SEP-41 token address (e.g. an
//! LP/vault-share token, or TLEND itself). The admin funds reward periods via
//! `notify_reward_amount`, which pulls `reward_amount` of the reward token
//! from the caller and spreads it evenly over `rewards_duration_secs`.

use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, token, Address, BytesN, Env};

#[cfg(test)]
mod test;

/// Fixed-point scaling factor for the `rewardPerTokenStored` accumulator.
/// Independent of either token's decimals — purely intermediate-math
/// precision, matching the Synthetix `StakingRewards` convention.
const PRECISION: i128 = 1_000_000_000_000_000_000;

// ─── Storage ──────────────────────────────────────────────────────────────────

#[contracttype]
pub enum DataKey {
    Admin,
    StakeToken,
    RewardToken,
    RewardsDuration,
    /// Ledger timestamp the current reward period ends.
    PeriodFinish,
    /// Reward tokens distributed per second (unscaled).
    RewardRate,
    /// Ledger timestamp `RewardPerTokenStored` was last updated.
    LastUpdateTime,
    /// Accumulator: cumulative reward per staked token, scaled by `PRECISION`.
    RewardPerTokenStored,
    TotalStaked,
    Balance(Address),
    /// `RewardPerTokenStored` snapshot at the user's last stake/withdraw/claim.
    UserRewardPerTokenPaid(Address),
    /// Rewards already accrued (via `update_reward`) but not yet claimed.
    Rewards(Address),
}

// ─── TlendStakingContract ─────────────────────────────────────────────────────

#[contract]
pub struct TlendStakingContract;

#[contractimpl]
impl TlendStakingContract {
    pub fn initialize(
        env: Env,
        admin: Address,
        stake_token: Address,
        reward_token: Address,
        rewards_duration_secs: u64,
    ) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Staking contract already initialised");
        }
        if rewards_duration_secs == 0 {
            panic!("rewards_duration_secs must be positive");
        }

        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::StakeToken, &stake_token);
        env.storage().instance().set(&DataKey::RewardToken, &reward_token);
        env.storage()
            .instance()
            .set(&DataKey::RewardsDuration, &rewards_duration_secs);
        env.storage().instance().set(&DataKey::PeriodFinish, &0u64);
        env.storage().instance().set(&DataKey::RewardRate, &0i128);
        env.storage().instance().set(&DataKey::LastUpdateTime, &0u64);
        env.storage()
            .instance()
            .set(&DataKey::RewardPerTokenStored, &0i128);
        env.storage().instance().set(&DataKey::TotalStaked, &0i128);
    }

    /// Upgrade the contract's code while preserving its storage.
    pub fn upgrade(env: Env, caller: Address, new_wasm_hash: BytesN<32>) {
        caller.require_auth();
        let admin = Self::get_admin(env.clone());
        if caller != admin {
            panic!("Unauthorised caller");
        }
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    // ── Admin: reward funding ─────────────────────────────────────────────────

    /// Change the reward period length. Only allowed between periods (after
    /// the previous one has finished), so an in-flight rate can't be
    /// silently reinterpreted over a different duration.
    pub fn set_rewards_duration(env: Env, caller: Address, rewards_duration_secs: u64) {
        caller.require_auth();
        Self::assert_admin(&env, &caller);

        // period_finish == 0 means no period has ever started yet — always
        // allowed. Otherwise only allowed once the current period has ended
        // (now >= period_finish), matching notify_reward_amount's own
        // "fresh vs. rollover" boundary.
        if Self::get_period_finish(env.clone()) > env.ledger().timestamp() {
            panic!("Cannot change duration before the current reward period ends");
        }
        if rewards_duration_secs == 0 {
            panic!("rewards_duration_secs must be positive");
        }

        env.storage()
            .instance()
            .set(&DataKey::RewardsDuration, &rewards_duration_secs);
        env.events().publish(
            (symbol_short!("staking"), symbol_short!("rdur")),
            rewards_duration_secs,
        );
    }

    /// Admin funds a new reward period: pulls `reward_amount` of the reward
    /// token from `caller` and spreads it evenly over `rewards_duration_secs`.
    /// If called before the previous period ended, the unpaid remainder of
    /// the old period rolls into the new rate (matches Synthetix's
    /// `notifyRewardAmount`).
    pub fn notify_reward_amount(env: Env, caller: Address, reward_amount: i128) {
        caller.require_auth();
        Self::assert_admin(&env, &caller);

        if reward_amount <= 0 {
            panic!("reward_amount must be positive");
        }

        // Flush the accumulator under the OLD rate before it changes.
        Self::update_reward(&env, None);

        let reward_token = Self::get_reward_token(env.clone());
        token::Client::new(&env, &reward_token).transfer(
            &caller,
            &env.current_contract_address(),
            &reward_amount,
        );

        let duration = Self::get_rewards_duration(env.clone());
        let now = env.ledger().timestamp();
        let period_finish = Self::get_period_finish(env.clone());
        let old_rate = Self::get_reward_rate(env.clone());

        let new_rate = if now >= period_finish {
            reward_amount
                .checked_div(duration as i128)
                .expect("Overflow computing reward rate")
        } else {
            let remaining = (period_finish - now) as i128;
            let leftover = remaining
                .checked_mul(old_rate)
                .expect("Overflow computing leftover reward");
            reward_amount
                .checked_add(leftover)
                .expect("Overflow adding leftover to new reward")
                .checked_div(duration as i128)
                .expect("Overflow computing reward rate")
        };

        if new_rate <= 0 {
            panic!("Reward rate must be positive — increase reward_amount or decrease duration");
        }

        // Never promise more than the contract actually holds for
        // distribution. If the stake and reward tokens are the same asset,
        // staked principal doesn't count towards the reward pool.
        let stake_token = Self::get_stake_token(env.clone());
        let reward_balance =
            token::Client::new(&env, &reward_token).balance(&env.current_contract_address());
        let available_for_rewards = if reward_token == stake_token {
            reward_balance - Self::get_total_staked(env.clone())
        } else {
            reward_balance
        };
        let required = new_rate
            .checked_mul(duration as i128)
            .expect("Overflow computing required reward balance");
        if required > available_for_rewards {
            panic!("Provided reward too high for the reward token balance held");
        }

        env.storage().instance().set(&DataKey::RewardRate, &new_rate);
        env.storage().instance().set(&DataKey::LastUpdateTime, &now);
        env.storage()
            .instance()
            .set(&DataKey::PeriodFinish, &(now + duration));

        env.events().publish(
            (symbol_short!("staking"), symbol_short!("notify")),
            (reward_amount, new_rate),
        );
    }

    // ── Staking lifecycle ─────────────────────────────────────────────────────

    pub fn stake(env: Env, user: Address, amount: i128) {
        user.require_auth();
        if amount <= 0 {
            panic!("Stake amount must be positive");
        }
        Self::update_reward(&env, Some(&user));

        let stake_token = Self::get_stake_token(env.clone());
        token::Client::new(&env, &stake_token).transfer(
            &user,
            &env.current_contract_address(),
            &amount,
        );

        let total = Self::get_total_staked(env.clone());
        env.storage()
            .instance()
            .set(&DataKey::TotalStaked, &(total + amount));

        let bal = Self::balance_of(env.clone(), user.clone());
        env.storage()
            .persistent()
            .set(&DataKey::Balance(user.clone()), &(bal + amount));

        env.events().publish(
            (symbol_short!("staking"), symbol_short!("stake")),
            (user, amount),
        );
    }

    pub fn withdraw(env: Env, user: Address, amount: i128) {
        user.require_auth();
        Self::withdraw_internal(&env, &user, amount);
    }

    /// Claim accrued rewards. Returns the amount transferred (0 if nothing
    /// had accrued — not an error, since polling this is harmless).
    pub fn claim_reward(env: Env, user: Address) -> i128 {
        user.require_auth();
        Self::claim_internal(&env, &user)
    }

    /// Convenience: withdraw the full staked balance and claim rewards in
    /// one call. Authorises once and shares that authorisation across both
    /// steps — calling the public `withdraw`/`claim_reward` entry points
    /// (each of which calls `require_auth` again) would re-authorise the
    /// same address twice in one invocation, which the host rejects.
    pub fn exit(env: Env, user: Address) {
        user.require_auth();
        let bal = Self::balance_of(env.clone(), user.clone());
        if bal > 0 {
            Self::withdraw_internal(&env, &user, bal);
        }
        Self::claim_internal(&env, &user);
    }

    fn withdraw_internal(env: &Env, user: &Address, amount: i128) {
        if amount <= 0 {
            panic!("Withdraw amount must be positive");
        }
        Self::update_reward(env, Some(user));

        let bal = Self::balance_of(env.clone(), user.clone());
        if amount > bal {
            panic!("Insufficient staked balance");
        }
        env.storage()
            .persistent()
            .set(&DataKey::Balance(user.clone()), &(bal - amount));

        let total = Self::get_total_staked(env.clone());
        env.storage()
            .instance()
            .set(&DataKey::TotalStaked, &(total - amount));

        let stake_token = Self::get_stake_token(env.clone());
        token::Client::new(env, &stake_token).transfer(
            &env.current_contract_address(),
            user,
            &amount,
        );

        env.events().publish(
            (symbol_short!("staking"), symbol_short!("withdraw")),
            (user.clone(), amount),
        );
    }

    fn claim_internal(env: &Env, user: &Address) -> i128 {
        Self::update_reward(env, Some(user));

        let reward = Self::get_rewards(env.clone(), user.clone());
        if reward > 0 {
            env.storage()
                .persistent()
                .set(&DataKey::Rewards(user.clone()), &0i128);

            let reward_token = Self::get_reward_token(env.clone());
            token::Client::new(env, &reward_token).transfer(
                &env.current_contract_address(),
                user,
                &reward,
            );

            env.events().publish(
                (symbol_short!("staking"), symbol_short!("claim")),
                (user.clone(), reward),
            );
        }
        reward
    }

    // ── Views ──────────────────────────────────────────────────────────────────

    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Staking contract not initialised")
    }

    pub fn get_stake_token(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::StakeToken)
            .expect("Staking contract not initialised")
    }

    pub fn get_reward_token(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::RewardToken)
            .expect("Staking contract not initialised")
    }

    pub fn get_rewards_duration(env: Env) -> u64 {
        env.storage()
            .instance()
            .get(&DataKey::RewardsDuration)
            .expect("Staking contract not initialised")
    }

    pub fn get_period_finish(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::PeriodFinish).unwrap_or(0)
    }

    pub fn get_reward_rate(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::RewardRate).unwrap_or(0)
    }

    pub fn get_total_staked(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::TotalStaked).unwrap_or(0)
    }

    pub fn balance_of(env: Env, account: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Balance(account))
            .unwrap_or(0)
    }

    pub fn get_rewards(env: Env, account: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::Rewards(account))
            .unwrap_or(0)
    }

    /// Ledger timestamp up to which rewards are currently applicable —
    /// `min(now, period_finish)`, so the accumulator freezes once a reward
    /// period ends instead of continuing to accrue from an exhausted rate.
    pub fn last_time_reward_applicable(env: Env) -> u64 {
        let now = env.ledger().timestamp();
        let period_finish = Self::get_period_finish(env);
        if now < period_finish {
            now
        } else {
            period_finish
        }
    }

    /// Cumulative reward per staked token, scaled by `PRECISION`.
    pub fn reward_per_token(env: Env) -> i128 {
        let total = Self::get_total_staked(env.clone());
        let stored = Self::get_reward_per_token_stored(env.clone());
        if total == 0 {
            return stored;
        }

        let last_applicable = Self::last_time_reward_applicable(env.clone());
        let last_update = Self::get_last_update_time(env.clone());
        let time_delta = last_applicable
            .checked_sub(last_update)
            .expect("last_update_time is ahead of last_time_reward_applicable") as i128;
        let rate = Self::get_reward_rate(env.clone());

        let numerator = time_delta
            .checked_mul(rate)
            .expect("Overflow: elapsed time × reward rate")
            .checked_mul(PRECISION)
            .expect("Overflow: × PRECISION");

        stored
            .checked_add(numerator / total)
            .expect("Overflow accumulating rewardPerTokenStored")
    }

    /// Total reward `account` is entitled to (claimed + unclaimed).
    pub fn earned(env: Env, account: Address) -> i128 {
        let bal = Self::balance_of(env.clone(), account.clone());
        let rpt = Self::reward_per_token(env.clone());
        let paid = Self::get_user_reward_per_token_paid(env.clone(), account.clone());
        let existing = Self::get_rewards(env.clone(), account.clone());

        let delta = rpt
            .checked_sub(paid)
            .expect("rewardPerTokenPaid is ahead of rewardPerToken");
        let accrued = bal
            .checked_mul(delta)
            .expect("Overflow: balance × rewardPerToken delta")
            / PRECISION;

        accrued
            .checked_add(existing)
            .expect("Overflow adding previously accrued rewards")
    }

    // ── Internal helpers ─────────────────────────────────────────────────────

    fn get_reward_per_token_stored(env: Env) -> i128 {
        env.storage()
            .instance()
            .get(&DataKey::RewardPerTokenStored)
            .unwrap_or(0)
    }

    fn get_last_update_time(env: Env) -> u64 {
        env.storage().instance().get(&DataKey::LastUpdateTime).unwrap_or(0)
    }

    fn get_user_reward_per_token_paid(env: Env, account: Address) -> i128 {
        env.storage()
            .persistent()
            .get(&DataKey::UserRewardPerTokenPaid(account))
            .unwrap_or(0)
    }

    /// Freezes the global accumulator at its current value (so subsequent
    /// reads are relative to "now"), and — if `account` is given — snapshots
    /// their accrued reward and pays-up their `UserRewardPerTokenPaid`
    /// marker. Must be called before any balance-changing action.
    fn update_reward(env: &Env, account: Option<&Address>) {
        let rpt = Self::reward_per_token(env.clone());
        let last_applicable = Self::last_time_reward_applicable(env.clone());

        env.storage()
            .instance()
            .set(&DataKey::RewardPerTokenStored, &rpt);
        env.storage()
            .instance()
            .set(&DataKey::LastUpdateTime, &last_applicable);

        if let Some(acct) = account {
            let earned = Self::earned(env.clone(), acct.clone());
            env.storage()
                .persistent()
                .set(&DataKey::Rewards(acct.clone()), &earned);
            env.storage()
                .persistent()
                .set(&DataKey::UserRewardPerTokenPaid(acct.clone()), &rpt);
        }
    }

    fn assert_admin(env: &Env, caller: &Address) {
        let admin = Self::get_admin(env.clone());
        if *caller != admin {
            panic!("Unauthorised caller: not admin");
        }
    }
}
