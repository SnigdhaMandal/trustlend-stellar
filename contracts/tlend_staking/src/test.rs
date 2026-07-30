#![cfg(test)]

use super::*;
use soroban_sdk::testutils::{Address as _, Ledger as _};
use soroban_sdk::String;

use tlend_token::{TlendTokenContract, TlendTokenContractClient};

struct World<'a> {
    env: Env,
    admin: Address,
    lp_token: TlendTokenContractClient<'a>,
    reward_token: TlendTokenContractClient<'a>,
    staking: TlendStakingContractClient<'a>,
}

fn setup<'a>(rewards_duration_secs: u64) -> World<'a> {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);

    let lp_id = env.register(TlendTokenContract, ());
    let lp_token = TlendTokenContractClient::new(&env, &lp_id);
    lp_token.initialize(
        &admin,
        &7,
        &String::from_str(&env, "TrustLend LP"),
        &String::from_str(&env, "TL-LP"),
    );

    let reward_id = env.register(TlendTokenContract, ());
    let reward_token = TlendTokenContractClient::new(&env, &reward_id);
    reward_token.initialize(
        &admin,
        &7,
        &String::from_str(&env, "TrustLend"),
        &String::from_str(&env, "TLEND"),
    );

    let staking_id = env.register(TlendStakingContract, ());
    let staking = TlendStakingContractClient::new(&env, &staking_id);
    staking.initialize(&admin, &lp_id, &reward_id, &rewards_duration_secs);

    World { env, admin, lp_token, reward_token, staking }
}

/// Same token used for both staking and rewards, to exercise the
/// "exclude staked principal from the reward pool" accounting branch.
fn setup_single_token<'a>(rewards_duration_secs: u64) -> (Env, Address, TlendTokenContractClient<'a>, TlendStakingContractClient<'a>) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);

    let token_id = env.register(TlendTokenContract, ());
    let token = TlendTokenContractClient::new(&env, &token_id);
    token.initialize(&admin, &7, &String::from_str(&env, "TrustLend"), &String::from_str(&env, "TLEND"));

    let staking_id = env.register(TlendStakingContract, ());
    let staking = TlendStakingContractClient::new(&env, &staking_id);
    staking.initialize(&admin, &token_id, &token_id, &rewards_duration_secs);

    (env, admin, token, staking)
}

fn now(w: &World) -> u64 {
    w.env.ledger().timestamp()
}

fn advance_to(w: &World, ts: u64) {
    w.env.ledger().with_mut(|l| l.timestamp = ts);
}

#[test]
fn test_initialize_sets_config() {
    let w = setup(1_000);
    assert_eq!(w.staking.get_admin(), w.admin);
    assert_eq!(w.staking.get_rewards_duration(), 1_000);
    assert_eq!(w.staking.get_period_finish(), 0);
    assert_eq!(w.staking.get_reward_rate(), 0);
    assert_eq!(w.staking.get_total_staked(), 0);
}

#[test]
#[should_panic(expected = "already initialised")]
fn test_double_initialize_panics() {
    let w = setup(1_000);
    let lp = w.staking.get_stake_token();
    let reward = w.staking.get_reward_token();
    w.staking.initialize(&w.admin, &lp, &reward, &500);
}

// ─── Staking ────────────────────────────────────────────────────────────────

#[test]
fn test_stake_increases_balance_and_total() {
    let w = setup(1_000);
    let alice = Address::generate(&w.env);
    w.lp_token.mint(&alice, &1_000);

    w.staking.stake(&alice, &400);

    assert_eq!(w.staking.balance_of(&alice), 400);
    assert_eq!(w.staking.get_total_staked(), 400);
    assert_eq!(w.lp_token.balance(&alice), 600);
    assert_eq!(w.lp_token.balance(&w.staking.address), 400);
}

#[test]
#[should_panic(expected = "Stake amount must be positive")]
fn test_stake_zero_amount_panics() {
    let w = setup(1_000);
    let alice = Address::generate(&w.env);
    w.staking.stake(&alice, &0);
}

#[test]
fn test_withdraw_decreases_balance_and_total() {
    let w = setup(1_000);
    let alice = Address::generate(&w.env);
    w.lp_token.mint(&alice, &1_000);
    w.staking.stake(&alice, &400);

    w.staking.withdraw(&alice, &150);

    assert_eq!(w.staking.balance_of(&alice), 250);
    assert_eq!(w.staking.get_total_staked(), 250);
    assert_eq!(w.lp_token.balance(&alice), 750);
}

#[test]
#[should_panic(expected = "Withdraw amount must be positive")]
fn test_withdraw_zero_amount_panics() {
    let w = setup(1_000);
    let alice = Address::generate(&w.env);
    w.lp_token.mint(&alice, &1_000);
    w.staking.stake(&alice, &400);
    w.staking.withdraw(&alice, &0);
}

#[test]
#[should_panic(expected = "Insufficient staked balance")]
fn test_withdraw_exceeds_balance_panics() {
    let w = setup(1_000);
    let alice = Address::generate(&w.env);
    w.lp_token.mint(&alice, &1_000);
    w.staking.stake(&alice, &400);
    w.staking.withdraw(&alice, &401);
}

// ─── Reward funding ───────────────────────────────────────────────────────────

#[test]
fn test_notify_reward_amount_sets_rate() {
    let w = setup(1_000);
    let alice = Address::generate(&w.env);
    w.lp_token.mint(&alice, &1_000);
    w.staking.stake(&alice, &100);
    w.reward_token.mint(&w.admin, &1_000);

    w.staking.notify_reward_amount(&w.admin, &1_000);

    assert_eq!(w.staking.get_reward_rate(), 1);
    assert_eq!(w.staking.get_period_finish(), now(&w) + 1_000);
    assert_eq!(w.reward_token.balance(&w.staking.address), 1_000);
}

#[test]
#[should_panic(expected = "reward_amount must be positive")]
fn test_notify_reward_amount_zero_panics() {
    let w = setup(1_000);
    w.staking.notify_reward_amount(&w.admin, &0);
}

#[test]
#[should_panic(expected = "not admin")]
fn test_notify_reward_amount_non_admin_panics() {
    let w = setup(1_000);
    let attacker = Address::generate(&w.env);
    w.reward_token.mint(&attacker, &1_000);
    w.staking.notify_reward_amount(&attacker, &1_000);
}

#[test]
fn test_set_rewards_duration_allowed_before_any_period() {
    let w = setup(1_000);
    w.staking.set_rewards_duration(&w.admin, &500);
    assert_eq!(w.staking.get_rewards_duration(), 500);
}

#[test]
#[should_panic(expected = "Cannot change duration before the current reward period ends")]
fn test_set_rewards_duration_blocked_during_active_period() {
    let w = setup(1_000);
    w.reward_token.mint(&w.admin, &1_000);
    w.staking.notify_reward_amount(&w.admin, &1_000);
    w.staking.set_rewards_duration(&w.admin, &500);
}

#[test]
fn test_set_rewards_duration_allowed_after_period_ends() {
    let w = setup(1_000);
    w.reward_token.mint(&w.admin, &1_000);
    w.staking.notify_reward_amount(&w.admin, &1_000);

    advance_to(&w, now(&w) + 1_000);
    w.staking.set_rewards_duration(&w.admin, &2_000);
    assert_eq!(w.staking.get_rewards_duration(), 2_000);
}

// ─── Reward accrual (the money tests) ────────────────────────────────────────

#[test]
fn test_single_staker_earns_full_reward_over_period() {
    let w = setup(1_000);
    let alice = Address::generate(&w.env);
    w.lp_token.mint(&alice, &1_000);
    w.reward_token.mint(&w.admin, &1_000);

    w.staking.stake(&alice, &100);
    w.staking.notify_reward_amount(&w.admin, &1_000); // rate = 1/sec

    advance_to(&w, now(&w) + 500);
    assert_eq!(w.staking.earned(&alice), 500);

    let claimed = w.staking.claim_reward(&alice);
    assert_eq!(claimed, 500);
    assert_eq!(w.reward_token.balance(&alice), 500);
    assert_eq!(w.staking.earned(&alice), 0);

    advance_to(&w, now(&w) + 500); // period finishes exactly here
    assert_eq!(w.staking.earned(&alice), 500);

    let claimed2 = w.staking.claim_reward(&alice);
    assert_eq!(claimed2, 500);
    assert_eq!(w.reward_token.balance(&alice), 1_000);
}

#[test]
fn test_two_stakers_split_rewards_proportionally() {
    let w = setup(1_000);
    let alice = Address::generate(&w.env);
    let bob = Address::generate(&w.env);
    w.lp_token.mint(&alice, &1_000);
    w.lp_token.mint(&bob, &1_000);
    w.reward_token.mint(&w.admin, &1_000);

    let start = now(&w);
    w.staking.stake(&alice, &100);
    w.staking.notify_reward_amount(&w.admin, &1_000); // rate = 1/sec, ends at start+1000

    // Alice alone for the first half of the period.
    advance_to(&w, start + 500);
    w.staking.stake(&bob, &100); // triggers alice's accrual snapshot at 100% share

    // Equal 50/50 share for the second half.
    advance_to(&w, start + 1_000);
    assert_eq!(w.staking.earned(&alice), 750); // 500 (solo) + 250 (half of second 500)
    assert_eq!(w.staking.earned(&bob), 250); // 250 (half of second 500)
}

#[test]
fn test_reward_per_token_zero_when_no_stakers() {
    let w = setup(1_000);
    assert_eq!(w.staking.reward_per_token(), 0);
}

#[test]
fn test_extend_reward_period_rolls_over_leftover() {
    let w = setup(100);
    let alice = Address::generate(&w.env);
    w.lp_token.mint(&alice, &1_000);
    w.reward_token.mint(&w.admin, &2_000);

    let start = now(&w);
    w.staking.stake(&alice, &100);
    w.staking.notify_reward_amount(&w.admin, &1_000); // rate = 10/sec, ends at start+100

    advance_to(&w, start + 50);
    // Leftover = (100 - 50) * 10 = 500. New total = 500 (fresh) + 500 (leftover) = 1000.
    w.staking.notify_reward_amount(&w.admin, &500);

    assert_eq!(w.staking.get_reward_rate(), 10);
    assert_eq!(w.staking.get_period_finish(), start + 150);

    advance_to(&w, start + 150);
    // 500 accrued in the first half (10/sec * 50s) + 1000 accrued over the new
    // 100s window (10/sec * 100s) = 1500, matching total funded (1000 + 500).
    assert_eq!(w.staking.earned(&alice), 1_500);
}

#[test]
fn test_claim_with_nothing_accrued_returns_zero() {
    let w = setup(1_000);
    let alice = Address::generate(&w.env);
    w.lp_token.mint(&alice, &1_000);
    w.staking.stake(&alice, &100);

    let claimed = w.staking.claim_reward(&alice);
    assert_eq!(claimed, 0);
}

#[test]
fn test_exit_withdraws_and_claims() {
    let w = setup(1_000);
    let alice = Address::generate(&w.env);
    w.lp_token.mint(&alice, &1_000);
    w.reward_token.mint(&w.admin, &1_000);

    w.staking.stake(&alice, &100);
    w.staking.notify_reward_amount(&w.admin, &1_000);

    advance_to(&w, now(&w) + 1_000);
    w.staking.exit(&alice);

    assert_eq!(w.staking.balance_of(&alice), 0);
    assert_eq!(w.staking.get_total_staked(), 0);
    assert_eq!(w.lp_token.balance(&alice), 1_000); // full stake returned
    assert_eq!(w.reward_token.balance(&alice), 1_000); // full reward claimed
}

// ─── Same-token staking (stake token == reward token) ────────────────────────

#[test]
fn test_stake_and_reward_same_token_accounting() {
    let (env, admin, token, staking) = setup_single_token(100);
    let alice = Address::generate(&env);
    token.mint(&alice, &1_000);
    token.mint(&admin, &500);

    staking.stake(&alice, &100);
    // Contract balance is now 100 (staked) + 0. Admin funds 500 more for rewards.
    staking.notify_reward_amount(&admin, &500); // rate = 5/sec, requires 500 available

    assert_eq!(staking.get_reward_rate(), 5);
    assert_eq!(token.balance(&staking.address), 600); // 100 staked + 500 reward pool

    env.ledger().with_mut(|l| l.timestamp += 100);
    assert_eq!(staking.earned(&alice), 500);

    staking.exit(&alice);
    // Started with 1000, staked 100 (900 left), then got the 100 principal
    // back plus all 500 of the reward pool: 900 + 100 + 500 = 1500.
    assert_eq!(token.balance(&alice), 1_500);
    assert_eq!(token.balance(&staking.address), 0);
}
