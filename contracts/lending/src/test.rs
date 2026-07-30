#![cfg(test)]
#![allow(clippy::inconsistent_digit_grouping)]

extern crate std;

use super::*;
use soroban_sdk::{
    testutils::{Address as _, Events, Ledger},
    token, vec, Address, Env, Vec,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

fn setup() -> (Env, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(LendingContract, ());
    let client = LendingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let borrower = Address::generate(&env);

    client.initialize(&admin);
    // Multisig-gated functions are exercised for real in `multisig_admin`'s
    // integration tests; here `admin` stands in as its own "multisig" so the
    // rest of this suite can focus on loan-lifecycle behaviour.
    client.set_multisig_admin(&admin, &admin);

    let collateral_asset = Address::generate(&env);
    client.whitelist_asset(&admin, &collateral_asset);

    (env, contract_id, admin, borrower, collateral_asset)
}

// Maximum i128 value — useful for overflow boundary checks.
const I128_MAX: i128 = i128::MAX;

// ─── Normal-case tests ────────────────────────────────────────────────────────

/// Basic happy-path: loan request created with correct totals.
#[test]
fn test_create_loan_request_basic() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // 1 000 XLM at 10 % for 30 days
    // interest = 1_000_0000000 * 1000 * 30 / (10_000 * 365) = 8_219_178 stroops ≈ 0.82 XLM
    let principal: i128 = 1_000_0000000;
    let rate_bps: u32 = 1000;
    let days: u32 = 30;
    let max_loan: i128 = 100_000_0000000;

    let loan_id = client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: principal,
            duration_days: days,
            interest_rate_bps: rate_bps,
            max_loan_amount: max_loan,
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: collateral_asset.clone(),
                    amount: 100_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
        },
    );
    assert_eq!(loan_id, 1);

    let loan = client.get_loan(&loan_id);
    assert_eq!(loan.amount, principal);
    assert_eq!(loan.duration_days, days);
    assert_eq!(loan.interest_rate_bps, rate_bps);
    assert!(loan.total_due > principal, "total_due must exceed principal");
    assert_eq!(loan.remaining_due, loan.total_due);
    assert_eq!(loan.status, LoanStatus::Pending);
}

/// Verify the interest formula numerically for a known input.
#[test]
fn test_interest_calculation_is_correct() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // 10 000 XLM at 15 % for 365 days → full annual interest = 10_000 * 15 % = 1 500 XLM
    let principal: i128 = 10_000_0000000; // 10 000 XLM in stroops
    let rate_bps: u32 = 1500;
    let days: u32 = 365;
    let expected_interest: i128 = principal * 1500 / 10_000; // = 1 500 XLM

    let loan_id = client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: principal,
            duration_days: days,
            interest_rate_bps: rate_bps,
            max_loan_amount: (principal * 2),
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: collateral_asset.clone(),
                    amount: 100_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
        },
    );
    let loan = client.get_loan(&loan_id);

    let actual_interest = loan.total_due - principal;
    assert_eq!(actual_interest, expected_interest);
}

/// Maximum allowed duration (365 days) must succeed.
#[test]
fn test_create_loan_max_duration_365_days() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let principal: i128 = 500_0000000; // 500 XLM
    let rate_bps: u32 = 800;
    let days: u32 = 365;
    let max_loan: i128 = 1_000_000_0000000;

    let loan_id = client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: principal,
            duration_days: days,
            interest_rate_bps: rate_bps,
            max_loan_amount: max_loan,
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: collateral_asset.clone(),
                    amount: 100_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
        },
    );
    let loan = client.get_loan(&loan_id);
    assert_eq!(loan.duration_days, 365);
    assert!(loan.total_due > principal);
}

/// A loan with duration 1 day (minimum) must succeed.
#[test]
fn test_create_loan_min_duration_1_day() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let loan_id = client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: 1_000_0000000,
            duration_days: 1,
            interest_rate_bps: 1500,
            max_loan_amount: 100_000_0000000,
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: collateral_asset.clone(),
                    amount: 100_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
        },
    );
    let loan = client.get_loan(&loan_id);
    assert_eq!(loan.duration_days, 1);
}

// ─── Overflow-protection tests ────────────────────────────────────────────────

/// A very large but still valid principal (Platinum tier max: 100 000 XLM)
/// at the highest rate (1500 bps) for the longest valid duration (365 days)
/// must NOT overflow — this is the extreme-but-legal boundary.
#[test]
fn test_no_overflow_at_maximum_valid_inputs() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // Set high collateral factor so borrowing power check passes
    client.set_asset_collateral_config(
        &admin,
        &collateral_asset,
        &AssetCollateralConfig {
            collateral_factor_bps: 9500,
            has_price_oracle: false,
            volatility_bps: 0,
        },
    );

    // Platinum tier max = 100 000 XLM = 100_000 * 10_000_000 stroops
    let principal: i128 = 100_000_0000000_i128; // 100 000 XLM
    let rate_bps: u32 = 1500; // highest rate (None tier)
    let days: u32 = 365; // maximum duration

    let loan_id = client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: principal,
            duration_days: days,
            interest_rate_bps: rate_bps,
            max_loan_amount: principal,
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: collateral_asset.clone(),
                    amount: 200_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
        },
    );
    let loan = client.get_loan(&loan_id);
    assert!(loan.total_due > principal);
}

/// Passing a principal of i128::MAX should panic with an overflow message,
/// not silently wrap around to a wrong value.
#[test]
#[should_panic(expected = "HostError")]
fn test_overflow_panics_with_near_max_principal() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // i128::MAX principal × any rate_bps > 1 will overflow the first checked_mul.
    client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: I128_MAX,
            duration_days: 365,
            interest_rate_bps: 1500,
            max_loan_amount: I128_MAX,
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: collateral_asset.clone(),
                    amount: 100_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
        },
    );
}

/// A principal that overflows only at the second multiplication step
/// (principal × rate_bps fits, but × days does not) must still panic cleanly.
#[test]
#[should_panic(expected = "HostError")]
fn test_overflow_panics_at_second_multiplication() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // i128::MAX / 1500 ≈ 2.27 × 10^35 — this value times 1500 fits in i128,
    // but multiplying again by 365 will overflow.
    let boundary_principal: i128 = I128_MAX / 1500;
    client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: boundary_principal,
            duration_days: 365,
            interest_rate_bps: 1500,
            max_loan_amount: I128_MAX,
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: collateral_asset.clone(),
                    amount: 100_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
        },
    );
}

// ─── Validation-guard tests ───────────────────────────────────────────────────

/// Duration of 0 must be rejected before any arithmetic happens.
#[test]
#[should_panic(expected = "Duration must be between 1 and 365 days")]
fn test_duration_zero_is_rejected() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: 1_000_0000000,
            duration_days: 0,
            interest_rate_bps: 1500,
            max_loan_amount: 100_000_0000000,
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: collateral_asset.clone(),
                    amount: 100_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
        },
    );
}

/// Duration exceeding 365 days must be rejected.
#[test]
#[should_panic(expected = "Duration must be between 1 and 365 days")]
fn test_duration_366_is_rejected() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: 1_000_0000000,
            duration_days: 366,
            interest_rate_bps: 1500,
            max_loan_amount: 100_000_0000000,
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: collateral_asset.clone(),
                    amount: 100_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
        },
    );
}

/// Zero-amount loan must be rejected.
#[test]
#[should_panic(expected = "Loan amount must be positive")]
fn test_zero_amount_is_rejected() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: 0,
            duration_days: 30,
            interest_rate_bps: 1500,
            max_loan_amount: 100_000_0000000,
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: collateral_asset.clone(),
                    amount: 100_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
        },
    );
}

/// Amount exceeding the reputation-based limit must be rejected.
#[test]
#[should_panic(expected = "Amount exceeds reputation-based limit")]
fn test_amount_over_max_is_rejected() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let max_loan: i128 = 1_000_0000000; // 1 000 XLM
    client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: (max_loan + 1),
            duration_days: 30,
            interest_rate_bps: 1500,
            max_loan_amount: max_loan,
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: collateral_asset.clone(),
                    amount: 100_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
        },
    );
}

/// Empty collateral entries must be rejected.
#[test]
#[should_panic(expected = "At least one collateral entry is required")]
fn test_empty_collateral_entries_rejected() {
    let (env, contract_id, _admin, borrower, _collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: 1_000_0000000,
            duration_days: 30,
            interest_rate_bps: 1000,
            max_loan_amount: 100_000_0000000,
            collateral_entries: Vec::new(&env),
            rate_model: InterestRateModel::Fixed,
        },
    );
}

/// Non-whitelisted collateral asset must be rejected.
#[test]
#[should_panic(expected = "Collateral asset is not whitelisted")]
fn test_non_whitelisted_collateral_asset_rejected() {
    let (env, contract_id, _admin, borrower, _collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let random_asset = Address::generate(&env);
    client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: 1_000_0000000,
            duration_days: 30,
            interest_rate_bps: 1000,
            max_loan_amount: 100_000_0000000,
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: random_asset,
                    amount: 100_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
        },
    );
}

// ─── due_at overflow test ─────────────────────────────────────────────────────

/// Confirm that due_at is computed correctly without overflow.
/// For 365 days the offset is 365 * 86_400 = 31_536_000 seconds.
#[test]
fn test_due_at_computed_correctly() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    env.ledger().set_timestamp(1_000_000_000_u64);

    let days: u32 = 365;
    let loan_id = client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: 1_000_0000000,
            duration_days: days,
            interest_rate_bps: 1500,
            max_loan_amount: 100_000_0000000,
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: collateral_asset.clone(),
                    amount: 100_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
        },
    );
    let loan = client.get_loan(&loan_id);

    let expected_due_at = 1_000_000_000_u64 + (365_u64 * 86_400);
    assert_eq!(loan.due_at, expected_due_at);
}

// ─── platform_fee test ────────────────────────────────────────────────────────

/// Platform fee must equal exactly 1 % of interest.
#[test]
fn test_platform_fee_is_one_percent_of_interest() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let principal: i128 = 10_000_0000000; // 10 000 XLM
    let rate_bps: u32 = 1500;
    let days: u32 = 365;

    let loan_id = client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: principal,
            duration_days: days,
            interest_rate_bps: rate_bps,
            max_loan_amount: (principal * 2),
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: collateral_asset.clone(),
                    amount: 100_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
        },
    );
    let loan = client.get_loan(&loan_id);

    let interest = loan.total_due - principal;
    assert_eq!(loan.platform_fee, interest / 100);
}

// ─── Dynamic liquidation threshold tests ─────────────────────────────────────

#[test]
fn test_liquidation_threshold_base() {
    let (env, contract_id, _admin, _borrower, _collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // Reputation = 0, Volatility = 0
    // Expected: base threshold = 7500
    let threshold = client.calculate_liquidation_threshold(&0, &0);
    assert_eq!(threshold, 7500);
}

#[test]
fn test_liquidation_threshold_reputation_boost() {
    let (env, contract_id, _admin, _borrower, _collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // Reputation = 500, Volatility = 0
    // Expected: 7500 + (500 * 1.5) = 7500 + 750 = 8250
    let threshold = client.calculate_liquidation_threshold(&500, &0);
    assert_eq!(threshold, 8250);

    // Reputation = 1000, Volatility = 0
    // Expected: 7500 + (1000 * 1.5) = 7500 + 1500 = 9000 (upper bound cap)
    let threshold = client.calculate_liquidation_threshold(&1000, &0);
    assert_eq!(threshold, 9000);
}

#[test]
fn test_liquidation_threshold_volatility_penalty() {
    let (env, contract_id, _admin, _borrower, _collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // Reputation = 0, Volatility = 2000 (20%)
    // Expected: 7500 - (2000 / 2) = 7500 - 1000 = 6500
    let threshold = client.calculate_liquidation_threshold(&0, &2000);
    assert_eq!(threshold, 6500);
}

#[test]
fn test_liquidation_threshold_clamping_bounds() {
    let (env, contract_id, _admin, _borrower, _collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    // Upper bound clamp: Reputation = 1000, Volatility = 0
    let threshold = client.calculate_liquidation_threshold(&1000, &0);
    assert_eq!(threshold, 9000);

    // Check Reputation = 2000 (abnormal), Volatility = 0
    let threshold = client.calculate_liquidation_threshold(&2000, &0);
    assert_eq!(threshold, 9000);

    // Lower bound clamp: Reputation = 0, Volatility = 8000 (80% volatility)
    let threshold = client.calculate_liquidation_threshold(&0, &8000);
    assert_eq!(threshold, 5000);
}

#[test]
fn test_liquidation_threshold_extreme_inputs_no_overflow() {
    let (env, contract_id, _admin, _borrower, _collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let threshold = client.calculate_liquidation_threshold(&u32::MAX, &u32::MAX);
    assert!((5000..=9000).contains(&threshold));
}

// ─── Pausable / Multi-sig tests ──────────────────────────────────────────────

fn setup_with_multisig() -> (Env, Address, Address, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(LendingContract, ());
    let client = LendingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let borrower = Address::generate(&env);
    let signer1 = Address::generate(&env);
    let signer2 = Address::generate(&env);

    client.initialize(&admin);

    let admins = soroban_sdk::vec![&env, admin.clone(), signer1.clone(), signer2.clone()];
    client.setup_multisig(&admin, &admins, &2);

    let collateral_asset = Address::generate(&env);
    client.whitelist_asset(&admin, &collateral_asset);

    (
        env,
        contract_id,
        admin,
        borrower,
        collateral_asset,
        signer1,
        signer2,
    )
}

fn create_request_struct(
    env: &Env,
    amount: i128,
    duration_days: u32,
    rate_bps: u32,
    max_loan: i128,
    collateral_asset: &Address,
    collateral_amount: i128,
    rate_model: InterestRateModel,
) -> LoanRequestInput {
    LoanRequestInput {
        amount,
        duration_days,
        interest_rate_bps: rate_bps,
        max_loan_amount: max_loan,
        collateral_entries: vec![
            env,
            CollateralEntry {
                asset: collateral_asset.clone(),
                amount: collateral_amount,
            },
        ],
        rate_model,
    }
}

#[test]
fn test_setup_multisig() {
    let (env, contract_id, admin, _borrower, _collateral_asset, signer1, signer2) =
        setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    let admins = client.get_multisig_admins();
    assert_eq!(admins.len(), 3);
    assert!(admins.iter().any(|a| a == admin));
    assert!(admins.iter().any(|a| a == signer1));
    assert!(admins.iter().any(|a| a == signer2));
    assert_eq!(client.get_multisig_threshold(), 2);
    assert!(!client.is_paused());
}

#[test]
#[should_panic(expected = "Threshold must be at least 1")]
fn test_setup_multisig_zero_threshold_rejected() {
    let (env, contract_id, admin, _borrower, _collateral_asset, signer1, signer2) =
        setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    let admins = soroban_sdk::vec![&env, admin.clone(), signer1, signer2];
    client.setup_multisig(&admin, &admins, &0);
}

#[test]
#[should_panic(expected = "Threshold exceeds number of admins")]
fn test_setup_multisig_threshold_too_high_rejected() {
    let (env, contract_id, admin, _borrower, _collateral_asset, signer1, signer2) =
        setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    let admins = soroban_sdk::vec![&env, signer1, signer2];
    client.setup_multisig(&admin, &admins, &5);
}

#[test]
#[should_panic(expected = "Signer has already authorised pause")]
fn test_duplicate_pause_signer_rejected() {
    let (env, contract_id, admin, _borrower, _collateral_asset, _signer1, _signer2) =
        setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    client.pause(&admin);
    client.pause(&admin);
}

#[test]
fn test_pause_activates_with_threshold() {
    let (env, contract_id, admin, _borrower, _collateral_asset, signer1, _signer2) =
        setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    assert!(!client.is_paused());
    assert_eq!(client.get_pause_signer_count(), 0);

    client.pause(&admin);
    assert!(!client.is_paused());
    assert_eq!(client.get_pause_signer_count(), 1);

    client.pause(&signer1);
    assert!(client.is_paused());
    assert_eq!(client.get_pause_signer_count(), 0);
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn test_create_loan_request_blocked_when_paused() {
    let (env, contract_id, admin, borrower, collateral_asset, signer1, _signer2) =
        setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    client.pause(&admin);
    client.pause(&signer1);

    client.create_loan_request(
        &borrower,
        &create_request_struct(
            &env,
            1_000_0000000,
            30,
            1500,
            100_000_0000000,
            &collateral_asset,
            100_000_0000000,
            InterestRateModel::Fixed,
        ),
    );
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn test_approve_loan_blocked_when_paused() {
    let (env, contract_id, admin, borrower, collateral_asset, signer1, _signer2) =
        setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    let loan_id = client.create_loan_request(
        &borrower,
        &create_request_struct(
            &env,
            1_000_0000000,
            30,
            1500,
            100_000_0000000,
            &collateral_asset,
            100_000_0000000,
            InterestRateModel::Fixed,
        ),
    );

    client.pause(&admin);
    client.pause(&signer1);

    let lender = Address::generate(&env);
    client.approve_loan(&lender, &loan_id, &1);
}

#[test]
#[should_panic(expected = "Contract is paused")]
fn test_mark_defaulted_blocked_when_paused() {
    let (env, contract_id, admin, borrower, collateral_asset, signer1, _signer2) =
        setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    let lender = Address::generate(&env);
    let loan_id = client.create_loan_request(
        &borrower,
        &create_request_struct(
            &env,
            1_000_0000000,
            30,
            1500,
            100_000_0000000,
            &collateral_asset,
            100_000_0000000,
            InterestRateModel::Fixed,
        ),
    );
    client.approve_loan(&lender, &loan_id, &1);
    client.activate_loan(&admin, &loan_id);

    client.pause(&admin);
    client.pause(&signer1);

    client.mark_defaulted(&admin, &loan_id);
}

#[test]
fn test_record_payment_allowed_when_paused() {
    let (env, contract_id, admin, borrower, collateral_asset, signer1, _signer2) =
        setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    let lender = Address::generate(&env);
    let loan_id = client.create_loan_request(
        &borrower,
        &create_request_struct(
            &env,
            1_000_0000000,
            30,
            1500,
            100_000_0000000,
            &collateral_asset,
            100_000_0000000,
            InterestRateModel::Fixed,
        ),
    );
    client.approve_loan(&lender, &loan_id, &1);
    client.activate_loan(&admin, &loan_id);

    client.pause(&admin);
    client.pause(&signer1);

    let status = client.record_payment(&admin, &loan_id, &500_0000000);
    assert_eq!(status, LoanStatus::Active);
}

#[test]
#[should_panic(expected = "Contract is not paused")]
fn test_unpause_when_not_paused_rejected() {
    let (env, contract_id, admin, _borrower, _collateral_asset, _signer1, _signer2) =
        setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    client.unpause(&admin);
}

#[test]
fn test_unpause_deactivates_with_threshold() {
    let (env, contract_id, admin, _borrower, _collateral_asset, signer1, _signer2) =
        setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    client.pause(&admin);
    client.pause(&signer1);
    assert!(client.is_paused());

    client.unpause(&admin);
    assert!(client.is_paused());
    client.unpause(&signer1);
    assert!(!client.is_paused());
}

#[test]
#[should_panic(expected = "Signer has already authorised unpause")]
fn test_duplicate_unpause_signer_rejected() {
    let (env, contract_id, admin, _borrower, _collateral_asset, signer1, _signer2) =
        setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    client.pause(&admin);
    client.pause(&signer1);

    client.unpause(&admin);
    client.unpause(&admin);
}

#[test]
#[should_panic(expected = "Unauthorised: caller is not a multisig admin")]
fn test_non_admin_cannot_pause() {
    let (env, contract_id, _admin, _borrower, _collateral_asset, _signer1, _signer2) =
        setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    let random = Address::generate(&env);
    client.pause(&random);
}

#[test]
#[should_panic(expected = "Multisig not configured")]
fn test_pause_without_multisig_rejected() {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(LendingContract, ());
    let client = LendingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    client.initialize(&admin);

    client.pause(&admin);
}

#[test]
fn test_resume_operations_after_unpause() {
    let (env, contract_id, admin, borrower, collateral_asset, signer1, signer2) =
        setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    client.pause(&admin);
    client.pause(&signer1);
    assert!(client.is_paused());

    client.unpause(&admin);
    client.unpause(&signer2);
    assert!(!client.is_paused());

    let loan_id = client.create_loan_request(
        &borrower,
        &create_request_struct(
            &env,
            1_000_0000000,
            30,
            1500,
            100_000_0000000,
            &collateral_asset,
            100_000_0000000,
            InterestRateModel::Fixed,
        ),
    );
    assert_eq!(loan_id, 1);
}

#[test]
fn test_multisig_admin_can_still_use_admin_functions_when_paused() {
    let (env, contract_id, admin, _borrower, _collateral_asset, signer1, _signer2) =
        setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    client.pause(&admin);
    client.pause(&signer1);
    assert!(client.is_paused());

    let new_asset = Address::generate(&env);
    client.whitelist_asset(&admin, &new_asset);
    assert!(client.is_asset_whitelisted(&new_asset));
}

#[test]
fn test_pause_unpause_events_emitted() {
    let (env, contract_id, admin, _borrower, _collateral_asset, signer1, _signer2) =
        setup_with_multisig();
    let client = LendingContractClient::new(&env, &contract_id);

    client.pause(&admin);
    client.pause(&signer1);

    let events = env.events().all();
    assert!(!events.is_empty());
}

// ─── Interest rate model tests ────────────────────────────────────────────────

/// Helper: creates and activates a loan, returning its ID.
fn create_and_activate_loan(
    env: &Env,
    client: &LendingContractClient,
    admin: &Address,
    borrower: &Address,
    collateral_asset: &Address,
    rate_model: &InterestRateModel,
) -> u32 {
    let principal: i128 = 1_000_0000000;
    let rate_bps: u32 = 1000;
    let days: u32 = 30;
    let max_loan: i128 = 100_000_0000000;

    let loan_id = client.create_loan_request(
        borrower,
        &create_request_struct(
            env,
            principal,
            days,
            rate_bps,
            max_loan,
            collateral_asset,
            100_000_0000000,
            rate_model.clone(),
        ),
    );

    client.approve_loan(admin, &loan_id, &1);
    client.activate_loan(admin, &loan_id);
    loan_id
}

/// Creating a Fixed-rate loan stores the model correctly.
#[test]
fn test_create_loan_with_fixed_rate_model() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let loan_id = client.create_loan_request(
        &borrower,
        &create_request_struct(
            &env,
            1_000_0000000,
            30,
            1000,
            100_000_0000000,
            &collateral_asset,
            100_000_0000000,
            InterestRateModel::Fixed,
        ),
    );
    let loan = client.get_loan(&loan_id);
    assert_eq!(loan.rate_model, InterestRateModel::Fixed);
    assert_eq!(loan.base_rate_bps, 1000);
}

/// Creating a Floating-rate loan stores the model correctly.
#[test]
fn test_create_loan_with_floating_rate_model() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let loan_id = client.create_loan_request(
        &borrower,
        &create_request_struct(
            &env,
            1_000_0000000,
            30,
            500,
            100_000_0000000,
            &collateral_asset,
            100_000_0000000,
            InterestRateModel::Floating,
        ),
    );
    let loan = client.get_loan(&loan_id);
    assert_eq!(loan.rate_model, InterestRateModel::Floating);
    assert_eq!(loan.base_rate_bps, 500);
}

/// Switching from Fixed to Floating and back works, charges fee, and toggles model.
#[test]
fn test_switch_rate_model_fixed_to_floating() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let loan_id = create_and_activate_loan(
        &env,
        &client,
        &admin,
        &borrower,
        &collateral_asset,
        &InterestRateModel::Fixed,
    );
    let loan_before = client.get_loan(&loan_id);
    assert_eq!(loan_before.rate_model, InterestRateModel::Fixed);

    client.switch_rate_model(&borrower, &loan_id);
    let loan_after = client.get_loan(&loan_id);
    assert_eq!(loan_after.rate_model, InterestRateModel::Floating);

    let expected_fee = loan_before.remaining_due * 50 / 10_000;
    assert_eq!(
        loan_after.remaining_due,
        loan_before.remaining_due + expected_fee,
    );
}

/// Switching is blocked during the 24h cooldown.
#[test]
#[should_panic(expected = "Rate switch cooldown not elapsed")]
fn test_switch_rate_model_cooldown_enforced() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    env.ledger().set_timestamp(1_000_000_000);

    let loan_id = create_and_activate_loan(
        &env,
        &client,
        &admin,
        &borrower,
        &collateral_asset,
        &InterestRateModel::Fixed,
    );

    client.switch_rate_model(&borrower, &loan_id);

    env.ledger().set_timestamp(env.ledger().timestamp() + 3600);
    client.switch_rate_model(&borrower, &loan_id);
}

/// Switching succeeds again after cooldown expires.
#[test]
fn test_switch_rate_model_allowed_after_cooldown() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    env.ledger().set_timestamp(1_000_000_000);

    let loan_id = create_and_activate_loan(
        &env,
        &client,
        &admin,
        &borrower,
        &collateral_asset,
        &InterestRateModel::Fixed,
    );

    client.switch_rate_model(&borrower, &loan_id);
    let loan = client.get_loan(&loan_id);
    assert_eq!(loan.rate_model, InterestRateModel::Floating);

    env.ledger()
        .set_timestamp(env.ledger().timestamp() + 86_401);

    client.switch_rate_model(&borrower, &loan_id);
    let loan = client.get_loan(&loan_id);
    assert_eq!(loan.rate_model, InterestRateModel::Fixed);
}

/// Only the borrower can switch the rate model.
#[test]
#[should_panic(expected = "Caller is not the borrower")]
fn test_switch_rate_model_only_borrower() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let loan_id = create_and_activate_loan(
        &env,
        &client,
        &admin,
        &borrower,
        &collateral_asset,
        &InterestRateModel::Fixed,
    );

    let attacker = Address::generate(&env);
    client.switch_rate_model(&attacker, &loan_id);
}

/// Can only switch rate model on ACTIVE loans.
#[test]
#[should_panic(expected = "Can only switch rate model on ACTIVE loans")]
fn test_switch_rate_model_only_active() {
    let (env, contract_id, _admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let loan_id = client.create_loan_request(
        &borrower,
        &create_request_struct(
            &env,
            1_000_0000000,
            30,
            1000,
            100_000_0000000,
            &collateral_asset,
            100_000_0000000,
            InterestRateModel::Fixed,
        ),
    );
    client.switch_rate_model(&borrower, &loan_id);
}

/// Admin can update the floating rate and remaining totals are recalculated.
#[test]
fn test_update_floating_rate() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let loan_id = create_and_activate_loan(
        &env,
        &client,
        &admin,
        &borrower,
        &collateral_asset,
        &InterestRateModel::Floating,
    );
    let loan_before = client.get_loan(&loan_id);
    assert_eq!(loan_before.interest_rate_bps, 1000);

    client.update_floating_rate(&admin, &loan_id, &2000);
    let loan_after = client.get_loan(&loan_id);
    assert_eq!(loan_after.interest_rate_bps, 2000);
}

/// update_floating_rate panics on a Fixed-rate loan.
#[test]
#[should_panic(expected = "Loan is not using floating rate model")]
fn test_update_floating_rate_rejects_fixed() {
    let (env, contract_id, admin, borrower, collateral_asset) = setup();
    let client = LendingContractClient::new(&env, &contract_id);

    let loan_id = create_and_activate_loan(
        &env,
        &client,
        &admin,
        &borrower,
        &collateral_asset,
        &InterestRateModel::Fixed,
    );
    client.update_floating_rate(&admin, &loan_id, &2000);
}

// ─── Flash Loan Receiver Contracts ────────────────────────────────────────────

mod good_receiver {
    use super::*;
    use soroban_sdk::{contract, contractimpl};

    #[contract]
    pub struct GoodReceiver;

    #[contractimpl]
    impl FlashLoanReceiver for GoodReceiver {
        fn execute_operation(
            env: Env,
            token: Address,
            amount: i128,
            fee: i128,
            pool: Address,
            _params: Bytes,
        ) {
            let token_client = token::Client::new(&env, &token);
            let caller = env.current_contract_address();
            let repayment = amount
                .checked_add(fee)
                .expect("Overflow computing repayment");
            token_client.transfer(&caller, &pool, &repayment);
        }
    }
}

mod generous_receiver {
    use super::*;
    use soroban_sdk::{contract, contractimpl};

    #[contract]
    pub struct GenerousReceiver;

    #[contractimpl]
    impl FlashLoanReceiver for GenerousReceiver {
        fn execute_operation(
            env: Env,
            token: Address,
            amount: i128,
            fee: i128,
            pool: Address,
            _params: Bytes,
        ) {
            let token_client = token::Client::new(&env, &token);
            let caller = env.current_contract_address();
            let repayment = amount
                .checked_add(fee)
                .expect("Overflow computing repayment")
                .checked_add(100)
                .expect("Overflow adding surplus");
            token_client.transfer(&caller, &pool, &repayment);
        }
    }
}

mod partial_receiver {
    use super::*;
    use soroban_sdk::{contract, contractimpl};

    #[contract]
    pub struct PartialReceiver;

    #[contractimpl]
    impl FlashLoanReceiver for PartialReceiver {
        fn execute_operation(
            env: Env,
            token: Address,
            amount: i128,
            _fee: i128,
            pool: Address,
            _params: Bytes,
        ) {
            let token_client = token::Client::new(&env, &token);
            let caller = env.current_contract_address();
            token_client.transfer(&caller, &pool, &amount);
        }
    }
}

mod stingy_receiver {
    use super::*;
    use soroban_sdk::{contract, contractimpl};

    #[contract]
    pub struct StingyReceiver;

    #[contractimpl]
    impl FlashLoanReceiver for StingyReceiver {
        fn execute_operation(
            _env: Env,
            _token: Address,
            _amount: i128,
            _fee: i128,
            _pool: Address,
            _params: Bytes,
        ) {
        }
    }
}

// ─── Flash Loan Test Helpers ──────────────────────────────────────────────────

fn setup_flash_loan() -> (Env, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(LendingContract, ());
    let client = LendingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let borrower = Address::generate(&env);

    client.initialize(&admin);
    client.set_multisig_admin(&admin, &admin);

    let collateral_asset = Address::generate(&env);
    client.whitelist_asset(&admin, &collateral_asset);

    let token_admin = Address::generate(&env);
    let token_address = env
        .register_stellar_asset_contract_v2(token_admin.clone())
        .address();
    let pool_funding: i128 = 1_000_000_0000000;
    let token_admin_client = token::StellarAssetClient::new(&env, &token_address);
    token_admin_client.mint(&contract_id, &pool_funding);

    (env, contract_id, admin, borrower, token_address)
}

fn mint_tokens(env: &Env, token: &Address, recipient: &Address, amount: i128) {
    let token_admin_client = token::StellarAssetClient::new(env, token);
    token_admin_client.mint(recipient, &amount);
}

const DEFAULT_FLASH_LOAN_FEE_BPS: i128 = 9;

#[test]
fn test_flash_loan_success_full_repayment() {
    let (env, contract_id, _admin, _borrower, token_address) = setup_flash_loan();
    let client = LendingContractClient::new(&env, &contract_id);

    let receiver_id = env.register(good_receiver::GoodReceiver, ());
    let loan_amount: i128 = 1_000_0000000;
    let fee = loan_amount * DEFAULT_FLASH_LOAN_FEE_BPS / 10_000;
    mint_tokens(&env, &token_address, &receiver_id, fee);

    let pool_before = token::Client::new(&env, &token_address).balance(&contract_id);
    client.flash_loan(&receiver_id, &token_address, &loan_amount, &Bytes::new(&env));
    let pool_after = token::Client::new(&env, &token_address).balance(&contract_id);
    assert_eq!(pool_after, pool_before + fee);
}

#[test]
fn test_flash_loan_accepts_overpayment() {
    let (env, contract_id, _admin, _borrower, token_address) = setup_flash_loan();
    let client = LendingContractClient::new(&env, &contract_id);

    let receiver_id = env.register(generous_receiver::GenerousReceiver, ());
    let loan_amount: i128 = 1_000_0000000;
    let fee = loan_amount * DEFAULT_FLASH_LOAN_FEE_BPS / 10_000;
    mint_tokens(&env, &token_address, &receiver_id, fee + 100);

    let pool_before = token::Client::new(&env, &token_address).balance(&contract_id);
    client.flash_loan(&receiver_id, &token_address, &loan_amount, &Bytes::new(&env));
    let pool_after = token::Client::new(&env, &token_address).balance(&contract_id);
    assert_eq!(pool_after, pool_before + fee + 100);
}

#[test]
fn test_flash_loan_applies_custom_fee_bps() {
    let (env, contract_id, admin, _borrower, token_address) = setup_flash_loan();
    let client = LendingContractClient::new(&env, &contract_id);

    client.set_flash_loan_fee_bps(&admin, &50);

    let receiver_id = env.register(good_receiver::GoodReceiver, ());
    let loan_amount: i128 = 10_000_0000000;
    let expected_fee = loan_amount * 50 / 10_000;
    mint_tokens(&env, &token_address, &receiver_id, expected_fee);

    let pool_before = token::Client::new(&env, &token_address).balance(&contract_id);
    client.flash_loan(&receiver_id, &token_address, &loan_amount, &Bytes::new(&env));
    let pool_after = token::Client::new(&env, &token_address).balance(&contract_id);
    assert_eq!(pool_after, pool_before + expected_fee);
}

#[test]
#[should_panic(expected = "Flash loan not repaid")]
fn test_flash_loan_reverts_when_receiver_repays_nothing() {
    let (env, contract_id, _admin, _borrower, token_address) = setup_flash_loan();
    let client = LendingContractClient::new(&env, &contract_id);

    let receiver_id = env.register(stingy_receiver::StingyReceiver, ());
    client.flash_loan(&receiver_id, &token_address, &1_000_0000000, &Bytes::new(&env));
}

#[test]
#[should_panic(expected = "Flash loan not repaid")]
fn test_flash_loan_reverts_on_partial_repayment() {
    let (env, contract_id, _admin, _borrower, token_address) = setup_flash_loan();
    let client = LendingContractClient::new(&env, &contract_id);

    let receiver_id = env.register(partial_receiver::PartialReceiver, ());
    client.flash_loan(&receiver_id, &token_address, &1_000_0000000, &Bytes::new(&env));
}

#[test]
fn test_failed_flash_loan_rolls_back_pool_balance() {
    let (env, contract_id, _admin, _borrower, token_address) = setup_flash_loan();
    let client = LendingContractClient::new(&env, &contract_id);

    let receiver_id = env.register(stingy_receiver::StingyReceiver, ());
    let pool_before = token::Client::new(&env, &token_address).balance(&contract_id);

    let result =
        client.try_flash_loan(&receiver_id, &token_address, &1_000_0000000, &Bytes::new(&env));
    assert!(result.is_err(), "flash_loan should have panicked");

    let pool_after = token::Client::new(&env, &token_address).balance(&contract_id);
    assert_eq!(pool_before, pool_after);
}

#[test]
fn test_pool_usable_again_immediately_after_a_failed_flash_loan() {
    let (env, contract_id, _admin, _borrower, token_address) = setup_flash_loan();
    let client = LendingContractClient::new(&env, &contract_id);

    let stingy_id = env.register(stingy_receiver::StingyReceiver, ());
    let result =
        client.try_flash_loan(&stingy_id, &token_address, &1_000_0000000, &Bytes::new(&env));
    assert!(result.is_err());

    let good_id = env.register(good_receiver::GoodReceiver, ());
    let fee = 1_000_0000000 * DEFAULT_FLASH_LOAN_FEE_BPS / 10_000;
    mint_tokens(&env, &token_address, &good_id, fee);

    let pool_before = token::Client::new(&env, &token_address).balance(&contract_id);
    client.flash_loan(&good_id, &token_address, &1_000_0000000, &Bytes::new(&env));
    let pool_after = token::Client::new(&env, &token_address).balance(&contract_id);
    assert_eq!(pool_after, pool_before + fee);
}

#[test]
#[should_panic(expected = "Insufficient pool liquidity for flash loan")]
fn test_flash_loan_rejects_amount_over_pool_liquidity() {
    let (env, contract_id, _admin, _borrower, token_address) = setup_flash_loan();
    let client = LendingContractClient::new(&env, &contract_id);

    let receiver_id = env.register(good_receiver::GoodReceiver, ());
    let pool_balance = token::Client::new(&env, &token_address).balance(&contract_id);

    client.flash_loan(
        &receiver_id,
        &token_address,
        &(pool_balance + 1),
        &Bytes::new(&env),
    );
}

#[test]
#[should_panic(expected = "Flash loan amount must be positive")]
fn test_flash_loan_rejects_zero_amount() {
    let (env, contract_id, _admin, _borrower, token_address) = setup_flash_loan();
    let client = LendingContractClient::new(&env, &contract_id);

    let receiver_id = env.register(good_receiver::GoodReceiver, ());
    client.flash_loan(&receiver_id, &token_address, &0, &Bytes::new(&env));
}

#[test]
#[should_panic(expected = "Flash loan amount must be positive")]
fn test_flash_loan_rejects_negative_amount() {
    let (env, contract_id, _admin, _borrower, token_address) = setup_flash_loan();
    let client = LendingContractClient::new(&env, &contract_id);

    let receiver_id = env.register(good_receiver::GoodReceiver, ());
    client.flash_loan(&receiver_id, &token_address, &(-1), &Bytes::new(&env));
}

#[test]
#[should_panic(expected = "Unauthorised")]
fn test_only_admin_can_change_flash_loan_fee() {
    let (env, contract_id, _admin, _borrower, _token_address) = setup_flash_loan();
    let client = LendingContractClient::new(&env, &contract_id);

    let random = Address::generate(&env);
    client.set_flash_loan_fee_bps(&random, &50);
}

#[test]
#[should_panic(expected = "Fee exceeds MAX_FLASH_LOAN_FEE_BPS")]
fn test_flash_loan_fee_capped() {
    let (env, contract_id, admin, _borrower, _token_address) = setup_flash_loan();
    let client = LendingContractClient::new(&env, &contract_id);

    client.set_flash_loan_fee_bps(&admin, &501);
}

#[test]
fn test_flash_loan_fee_at_max_boundary_accepted() {
    let (env, contract_id, admin, _borrower, token_address) = setup_flash_loan();
    let client = LendingContractClient::new(&env, &contract_id);

    client.set_flash_loan_fee_bps(&admin, &500);
    assert_eq!(client.get_flash_loan_fee_bps(), 500);

    let receiver_id = env.register(good_receiver::GoodReceiver, ());
    let loan_amount: i128 = 1_000_0000000;
    let expected_fee = loan_amount * 500 / 10_000;
    mint_tokens(&env, &token_address, &receiver_id, expected_fee);

    let pool_before = token::Client::new(&env, &token_address).balance(&contract_id);
    client.flash_loan(&receiver_id, &token_address, &loan_amount, &Bytes::new(&env));
    let pool_after = token::Client::new(&env, &token_address).balance(&contract_id);
    assert_eq!(pool_after, pool_before + expected_fee);
}

// ─── Multi-Asset Collateral Vault Tests ───────────────────────────────────────

fn setup_multi_collateral() -> (Env, Address, Address, Address, Address, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let contract_id = env.register(LendingContract, ());
    let client = LendingContractClient::new(&env, &contract_id);

    let admin = Address::generate(&env);
    let borrower = Address::generate(&env);

    client.initialize(&admin);
    client.set_multisig_admin(&admin, &admin);

    let asset_a = Address::generate(&env);
    let asset_b = Address::generate(&env);
    client.whitelist_asset(&admin, &asset_a);
    client.whitelist_asset(&admin, &asset_b);

    (env, contract_id, admin, borrower, asset_a, asset_b)
}

/// Deposit a single collateral asset succeeds.
#[test]
fn test_deposit_collateral_single_asset() {
    let (env, contract_id, _admin, borrower, asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    client.deposit_collateral(&borrower, &asset_a, &1_000_0000000);

    let entries = client.get_user_collateral_entries(&borrower);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries.get(0).unwrap().asset, asset_a);
    assert_eq!(entries.get(0).unwrap().amount, 1_000_0000000);
}

/// Deposit multiple different collateral assets succeeds.
#[test]
fn test_deposit_collateral_multiple_assets() {
    let (env, contract_id, _admin, borrower, asset_a, asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    client.deposit_collateral(&borrower, &asset_a, &5_000_0000000);
    client.deposit_collateral(&borrower, &asset_b, &3_000_0000000);

    let entries = client.get_user_collateral_entries(&borrower);
    assert_eq!(entries.len(), 2);

    let entry_a = entries.get(0).unwrap();
    let entry_b = entries.get(1).unwrap();
    assert_eq!(entry_a.asset, asset_a);
    assert_eq!(entry_a.amount, 5_000_0000000);
    assert_eq!(entry_b.asset, asset_b);
    assert_eq!(entry_b.amount, 3_000_0000000);
}

/// Depositing the same asset twice accumulates the amount.
#[test]
fn test_deposit_collateral_same_asset_accumulates() {
    let (env, contract_id, _admin, borrower, asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    client.deposit_collateral(&borrower, &asset_a, &1_000_0000000);
    client.deposit_collateral(&borrower, &asset_a, &2_000_0000000);

    let entries = client.get_user_collateral_entries(&borrower);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries.get(0).unwrap().amount, 3_000_0000000);
}

/// Deposit of zero amount is rejected.
#[test]
#[should_panic(expected = "Collateral amount must be positive")]
fn test_deposit_collateral_zero_amount_rejected() {
    let (env, contract_id, _admin, borrower, asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    client.deposit_collateral(&borrower, &asset_a, &0);
}

/// Deposit to a non-whitelisted asset is rejected.
#[test]
#[should_panic(expected = "Asset is not whitelisted")]
fn test_deposit_collateral_non_whitelisted_asset_rejected() {
    let (env, contract_id, _admin, borrower, _asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    let random_asset = Address::generate(&env);
    client.deposit_collateral(&borrower, &random_asset, &1_000_0000000);
}

/// Withdraw collateral from a single asset reduces balance.
#[test]
fn test_withdraw_collateral_basic() {
    let (env, contract_id, _admin, borrower, asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    client.deposit_collateral(&borrower, &asset_a, &5_000_0000000);
    client.withdraw_collateral(&borrower, &asset_a, &2_000_0000000);

    let entries = client.get_user_collateral_entries(&borrower);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries.get(0).unwrap().amount, 3_000_0000000);
}

/// Withdrawing the full amount removes the entry entirely.
#[test]
fn test_withdraw_collateral_full_amount_removes_entry() {
    let (env, contract_id, _admin, borrower, asset_a, asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    client.deposit_collateral(&borrower, &asset_a, &5_000_0000000);
    client.deposit_collateral(&borrower, &asset_b, &3_000_0000000);

    // Withdraw all of asset_a
    client.withdraw_collateral(&borrower, &asset_a, &5_000_0000000);

    let entries = client.get_user_collateral_entries(&borrower);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries.get(0).unwrap().asset, asset_b);
}

/// Withdrawing more than the balance is rejected.
#[test]
#[should_panic(expected = "Insufficient collateral balance for withdrawal")]
fn test_withdraw_collateral_exceeds_balance_rejected() {
    let (env, contract_id, _admin, borrower, asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    client.deposit_collateral(&borrower, &asset_a, &1_000_0000000);
    client.withdraw_collateral(&borrower, &asset_a, &2_000_0000000);
}

/// Withdrawing zero amount is rejected.
#[test]
#[should_panic(expected = "Withdrawal amount must be positive")]
fn test_withdraw_collateral_zero_amount_rejected() {
    let (env, contract_id, _admin, borrower, asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    client.deposit_collateral(&borrower, &asset_a, &1_000_0000000);
    client.withdraw_collateral(&borrower, &asset_a, &0);
}

/// Withdrawing an asset that was never deposited is rejected.
#[test]
#[should_panic(expected = "No collateral of the specified asset found")]
fn test_withdraw_collateral_nonexistent_asset_rejected() {
    let (env, contract_id, _admin, borrower, asset_a, asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    client.deposit_collateral(&borrower, &asset_a, &1_000_0000000);
    client.withdraw_collateral(&borrower, &asset_b, &500_0000000);
}

/// Deposit is blocked when contract is paused.
/// Uses try_ to catch the HostError (panic message is in diagnostic event).
#[test]
fn test_deposit_collateral_blocked_when_paused() {
    let (env, contract_id, admin, borrower, asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    // Need at least 2 signers for threshold 2
    let signer = Address::generate(&env);
    let admins = vec![&env, admin.clone(), signer.clone()];
    client.setup_multisig(&admin, &admins, &2);
    client.pause(&admin);
    client.pause(&signer);
    assert!(client.is_paused());

    let result = client.try_deposit_collateral(&borrower, &asset_a, &1_000_0000000);
    assert!(result.is_err(), "deposit_collateral should have failed when paused");
}

/// Get borrowing power with no active loans allows full withdrawal.
#[test]
fn test_withdraw_collateral_allowed_with_no_active_loans() {
    let (env, contract_id, _admin, borrower, asset_a, asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    client.deposit_collateral(&borrower, &asset_a, &5_000_0000000);
    client.deposit_collateral(&borrower, &asset_b, &3_000_0000000);

    // Should be able to withdraw all
    client.withdraw_collateral(&borrower, &asset_a, &5_000_0000000);

    let entries = client.get_user_collateral_entries(&borrower);
    assert_eq!(entries.len(), 1);
    assert_eq!(entries.get(0).unwrap().asset, asset_b);
}

/// Get user collateral entries for a borrower with no collateral returns empty Vec.
#[test]
fn test_get_user_collateral_entries_empty_for_new_borrower() {
    let (env, contract_id, _admin, borrower, _asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    let entries = client.get_user_collateral_entries(&borrower);
    assert_eq!(entries.len(), 0);
}

/// Get total collateral value for a borrower with deposits.
#[test]
fn test_get_total_collateral_value() {
    let (env, contract_id, _admin, borrower, asset_a, asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    client.deposit_collateral(&borrower, &asset_a, &10_000_0000000);
    client.deposit_collateral(&borrower, &asset_b, &20_000_0000000);

    let total_value = client.get_total_collateral_value(&borrower);
    // Without oracle, each unit is valued at 1.0 base asset unit
    // Total = 10_000_0000000 + 20_000_0000000 = 30_000_0000000
    assert_eq!(total_value, 30_000_0000000);
}

/// Get total collateral value for a borrower with no deposits.
#[test]
fn test_get_total_collateral_value_empty() {
    let (env, contract_id, _admin, borrower, _asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    let total_value = client.get_total_collateral_value(&borrower);
    assert_eq!(total_value, 0);
}

/// Borrowing power for a single asset with default (75%) collateral factor.
#[test]
fn test_get_borrowing_power_single_asset() {
    let (env, contract_id, admin, borrower, asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    // Set a specific collateral config: 80% LTV
    client.set_asset_collateral_config(
        &admin,
        &asset_a,
        &AssetCollateralConfig {
            collateral_factor_bps: 8000, // 80% LTV
            has_price_oracle: false,
            volatility_bps: 500, // 5% vol
        },
    );

    client.deposit_collateral(&borrower, &asset_a, &10_000_0000000);

    let borrowing_power = client.get_borrowing_power(&borrower);
    // 10_000_0000000 * 80% = 8_000_0000000
    assert_eq!(borrowing_power, 8_000_0000000);
}

/// Borrowing power for multiple assets with different collateral factors.
#[test]
fn test_get_borrowing_power_multiple_assets() {
    let (env, contract_id, admin, borrower, asset_a, asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    // Asset A: 75% LTV (default)
    client.deposit_collateral(&borrower, &asset_a, &10_000_0000000);

    // Asset B: 50% LTV
    client.set_asset_collateral_config(
        &admin,
        &asset_b,
        &AssetCollateralConfig {
            collateral_factor_bps: 5000, // 50% LTV
            has_price_oracle: false,
            volatility_bps: 2000, // 20% vol
        },
    );
    client.deposit_collateral(&borrower, &asset_b, &10_000_0000000);

    let borrowing_power = client.get_borrowing_power(&borrower);
    // Asset A: 10_000_0000000 * 75% = 7_500_0000000
    // Asset B: 10_000_0000000 * 50% = 5_000_0000000
    // Total: 12_500_0000000
    assert_eq!(borrowing_power, 12_500_0000000);
}

/// Borrowing power with no deposited collateral.
#[test]
fn test_get_borrowing_power_no_collateral() {
    let (env, contract_id, _admin, borrower, _asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    let borrowing_power = client.get_borrowing_power(&borrower);
    assert_eq!(borrowing_power, 0);
}

/// Setting asset collateral config validates the asset is whitelisted.
#[test]
#[should_panic(expected = "Asset is not whitelisted")]
fn test_set_asset_collateral_config_non_whitelisted_rejected() {
    let (env, contract_id, admin, _borrower, _asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    let random_asset = Address::generate(&env);
    client.set_asset_collateral_config(
        &admin,
        &random_asset,
        &AssetCollateralConfig {
            collateral_factor_bps: 8000,
            has_price_oracle: false,
            volatility_bps: 500,
        },
    );
}

/// Setting asset collateral config clamps the collateral factor to bounds.
#[test]
fn test_set_asset_collateral_config_clamps_to_bounds() {
    let (env, contract_id, admin, _borrower, asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    // Set factor above max (9600 > 9500)
    client.set_asset_collateral_config(
        &admin,
        &asset_a,
        &AssetCollateralConfig {
            collateral_factor_bps: 9600, // Above MAX
            has_price_oracle: false,
            volatility_bps: 500,
        },
    );

    let config = client.get_asset_collateral_config(&asset_a);
    assert_eq!(config.collateral_factor_bps, 9500); // Clamped to MAX

    // Set factor below min (500 < 1000)
    client.set_asset_collateral_config(
        &admin,
        &asset_a,
        &AssetCollateralConfig {
            collateral_factor_bps: 500, // Below MIN
            has_price_oracle: false,
            volatility_bps: 500,
        },
    );

    let config = client.get_asset_collateral_config(&asset_a);
    assert_eq!(config.collateral_factor_bps, 1000); // Clamped to MIN
}

/// Get asset collateral config returns default for unconfigured asset.
#[test]
fn test_get_asset_collateral_config_default() {
    let (env, contract_id, _admin, _borrower, asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    let config = client.get_asset_collateral_config(&asset_a);
    // Default: 75% LTV, no oracle, 0 volatility
    assert_eq!(config.collateral_factor_bps, 7500);
    assert_eq!(config.has_price_oracle, false);
    assert_eq!(config.volatility_bps, 0);
}

/// Price oracle can be set and retrieved (multisig-gated).
#[test]
fn test_set_price_oracle() {
    let (env, contract_id, admin, _borrower, _asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    let oracle = Address::generate(&env);
    client.set_price_oracle(&admin, &oracle);

    let retrieved = client.get_price_oracle();
    assert_eq!(retrieved, oracle);
}

/// Median aggregation ignores a manipulated outlier price sample.
#[test]
fn test_price_oracle_median_resists_manipulation() {
    let (env, contract_id, admin, borrower, asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    client.set_asset_collateral_config(
        &admin,
        &asset_a,
        &AssetCollateralConfig {
            collateral_factor_bps: 7500,
            has_price_oracle: true,
            volatility_bps: 0,
        },
    );

    client.deposit_collateral(&borrower, &asset_a, &1_000_0000000);

    client.set_asset_oracle_prices(
        &admin,
        &asset_a,
        &vec![
            &env,
            PRICE_PRECISION,
            PRICE_PRECISION,
            PRICE_PRECISION * 10,
        ],
    );

    let value = client.get_total_collateral_value(&borrower);
    assert_eq!(value, 1_000_0000000);
}

/// TWAP is used when live oracle samples are unavailable.
#[test]
fn test_price_oracle_twap_fallback_is_used() {
    let (env, contract_id, admin, borrower, asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    client.set_asset_collateral_config(
        &admin,
        &asset_a,
        &AssetCollateralConfig {
            collateral_factor_bps: 7500,
            has_price_oracle: true,
            volatility_bps: 0,
        },
    );

    client.deposit_collateral(&borrower, &asset_a, &1_000_0000000);
    client.set_asset_twap_price(&admin, &asset_a, &(PRICE_PRECISION * 2));

    let value = client.get_total_collateral_value(&borrower);
    assert_eq!(value, 2_000_0000000);
}

/// Only multisig admin can set the price oracle.
#[test]
#[should_panic(expected = "Unauthorised")]
fn test_set_price_oracle_non_admin_rejected() {
    let (env, contract_id, _admin, _borrower, _asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    let random = Address::generate(&env);
    let oracle = Address::generate(&env);
    client.set_price_oracle(&random, &oracle);
}

/// Only multisig admin can configure asset collateral config.
#[test]
#[should_panic(expected = "Unauthorised")]
fn test_set_asset_collateral_config_non_admin_rejected() {
    let (env, contract_id, _admin, _borrower, asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    let random = Address::generate(&env);
    client.set_asset_collateral_config(
        &random,
        &asset_a,
        &AssetCollateralConfig {
            collateral_factor_bps: 8000,
            has_price_oracle: false,
            volatility_bps: 500,
        },
    );
}

/// Borrowing power check is enforced during create_loan_request.
#[test]
fn test_create_loan_request_checks_borrowing_power() {
    let (env, contract_id, admin, borrower, asset_a, _asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    // Configure with low LTV
    client.set_asset_collateral_config(
        &admin,
        &asset_a,
        &AssetCollateralConfig {
            collateral_factor_bps: 1000, // 10% LTV
            has_price_oracle: false,
            volatility_bps: 500,
        },
    );

    // Deposit collateral worth 10_000_0000000, borrowing power = 1_000_0000000
    client.deposit_collateral(&borrower, &asset_a, &10_000_0000000);

    // This should fail because we're trying to borrow more than borrowing power
    let result = client.try_create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: 5_000_0000000, // > 1_000_0000000 borrowing power
            duration_days: 30,
            interest_rate_bps: 1000,
            max_loan_amount: 100_000_0000000,
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: asset_a.clone(),
                    amount: 10_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
        },
    );
    assert!(result.is_err(), "create_loan_request should have failed due to borrowing power");
}

/// Create loan request with multiple collateral assets.
#[test]
fn test_create_loan_request_with_multi_asset_collateral() {
    let (env, contract_id, admin, borrower, asset_a, asset_b) = setup_multi_collateral();
    let client = LendingContractClient::new(&env, &contract_id);

    // Configure asset B with 50% LTV
    client.set_asset_collateral_config(
        &admin,
        &asset_b,
        &AssetCollateralConfig {
            collateral_factor_bps: 5000, // 50% LTV
            has_price_oracle: false,
            volatility_bps: 1000,
        },
    );

    // deposit_collateral on user's vault
    client.deposit_collateral(&borrower, &asset_a, &10_000_0000000); // 7.5K borrowing power
    client.deposit_collateral(&borrower, &asset_b, &10_000_0000000); // 5K borrowing power

    // Total borrowing power = 12_500_0000000
    // Requesting 10_000_0000000 should work
    let loan_id = client.create_loan_request(
        &borrower,
        &LoanRequestInput {
            amount: 10_000_0000000,
            duration_days: 30,
            interest_rate_bps: 1000,
            max_loan_amount: 100_000_0000000,
            collateral_entries: vec![
                &env,
                CollateralEntry {
                    asset: asset_a.clone(),
                    amount: 10_000_0000000,
                },
                CollateralEntry {
                    asset: asset_b.clone(),
                    amount: 10_000_0000000,
                },
            ],
            rate_model: InterestRateModel::Fixed,
        },
    );

    let loan = client.get_loan(&loan_id);
    assert_eq!(loan.status, LoanStatus::Pending);
}


