#![cfg(test)]

use super::*;
use soroban_sdk::{
    testutils::Address as _,
    token, Address, Env,
};

use lending::{LendingContract, LendingContractClient};

fn setup_test() -> (
    Env,
    Address,
    Address,
    Address,
    Address,
    TreasuryContractClient<'static>,
) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let insurance_fund = Address::generate(&env);
    let dao_treasury = Address::generate(&env);

    let token_admin = Address::generate(&env);
    let asset_token_id = env.register_stellar_asset_contract_v2(token_admin).address();

    let treasury_id = env.register(TreasuryContract, ());
    let client = TreasuryContractClient::new(&env, &treasury_id);

    client.initialize(
        &admin,
        &insurance_fund,
        &dao_treasury,
        &DEFAULT_INSURANCE_SHARE_BPS,
        &DEFAULT_DAO_SHARE_BPS,
    );

    (
        env,
        admin,
        insurance_fund,
        dao_treasury,
        asset_token_id,
        client,
    )
}

fn mint_tokens(env: &Env, asset_token: &Address, recipient: &Address, amount: i128) {
    let token_admin_client = token::StellarAssetClient::new(env, asset_token);
    token_admin_client.mint(recipient, &amount);
}

#[test]
fn test_initialize_treasury() {
    let (_env, admin, insurance_fund, dao_treasury, asset_token, client) = setup_test();

    assert_eq!(client.get_admin(), admin);
    assert_eq!(client.get_insurance_fund(), insurance_fund);
    assert_eq!(client.get_dao_treasury(), dao_treasury);

    let rules = client.get_distribution_rules();
    assert_eq!(rules.insurance_share_bps, 5000);
    assert_eq!(rules.dao_share_bps, 5000);

    assert_eq!(client.get_total_collected_fees(), 0);
    assert_eq!(client.get_treasury_balance(&asset_token), 0);
}

#[test]
fn test_set_distribution_rules() {
    let (_env, admin, _insurance_fund, _dao_treasury, _asset_token, client) = setup_test();

    client.set_distribution_rules(&admin, &7000, &3000);
    let rules = client.get_distribution_rules();
    assert_eq!(rules.insurance_share_bps, 7000);
    assert_eq!(rules.dao_share_bps, 3000);
}

#[test]
#[should_panic(expected = "Distribution share BPS must equal 10,000 (100%)")]
fn test_set_distribution_rules_invalid_bps_panics() {
    let (_env, admin, _insurance_fund, _dao_treasury, _asset_token, client) = setup_test();
    client.set_distribution_rules(&admin, &6000, &3000);
}

#[test]
fn test_deposit_fees_and_query_balance() {
    let (env, admin, _insurance_fund, _dao_treasury, asset_token, client) = setup_test();

    let fee_amount = 1_000_0000000i128;
    mint_tokens(&env, &asset_token, &admin, fee_amount);

    client.deposit_fees(&admin, &asset_token, &fee_amount);

    assert_eq!(client.get_treasury_balance(&asset_token), fee_amount);
    assert_eq!(client.get_total_collected_fees(), fee_amount);
}

#[test]
fn test_distribute_fees_50_50_split() {
    let (env, admin, insurance_fund, dao_treasury, asset_token, client) = setup_test();

    let total_fees = 1_000_0000000i128;
    mint_tokens(&env, &asset_token, &admin, total_fees);
    client.deposit_fees(&admin, &asset_token, &total_fees);

    let (ins_payout, dao_payout) = client.distribute(&admin, &asset_token);

    assert_eq!(ins_payout, 500_0000000i128);
    assert_eq!(dao_payout, 500_0000000i128);

    assert_eq!(token::Client::new(&env, &asset_token).balance(&insurance_fund), 500_0000000i128);
    assert_eq!(token::Client::new(&env, &asset_token).balance(&dao_treasury), 500_0000000i128);
    assert_eq!(client.get_treasury_balance(&asset_token), 0);

    assert_eq!(client.get_total_distributed_insurance(), 500_0000000i128);
    assert_eq!(client.get_total_distributed_dao(), 500_0000000i128);

    let count = client.get_distribution_count();
    assert_eq!(count, 1);

    let record = client.get_distribution(&1);
    assert_eq!(record.id, 1);
    assert_eq!(record.insurance_amount, 500_0000000i128);
    assert_eq!(record.dao_amount, 500_0000000i128);

    let history = client.get_distribution_history();
    assert_eq!(history.len(), 1);
}

#[test]
#[should_panic(expected = "No balance available to distribute")]
fn test_distribute_empty_balance_panics() {
    let (_env, admin, _insurance_fund, _dao_treasury, asset_token, client) = setup_test();
    client.distribute(&admin, &asset_token);
}

#[test]
fn test_collect_protocol_fees_from_lending() {
    let (env, admin, _insurance_fund, _dao_treasury, _asset_token, client) = setup_test();

    let lending_id = env.register(LendingContract, ());
    let lending = LendingContractClient::new(&env, &lending_id);
    lending.initialize(&admin);
    lending.set_multisig_admin(&admin, &admin);

    let borrower = Address::generate(&env);
    let collateral_asset = Address::generate(&env);
    lending.whitelist_asset(&admin, &collateral_asset);

    // Create loan request (accrues platform fee)
    let _loan_id = lending.create_loan_request(
        &borrower,
        &lending::LoanRequestInput {
            amount: 1_000_0000000i128,
            duration_days: 30u32,
            interest_rate_bps: 1000u32,
            max_loan_amount: 100_000_0000000i128,
            collateral_entries: soroban_sdk::vec![
                &env,
                lending::CollateralEntry { asset: collateral_asset, amount: 100_000_0000000i128 },
            ],
            rate_model: lending::InterestRateModel::Fixed,
        },
    );

    let uncollected = lending.get_uncollected_fees();
    assert!(uncollected > 0);

    let collected = client.collect_protocol_fees(&admin, &lending_id);
    assert_eq!(collected, uncollected);
    assert_eq!(lending.get_uncollected_fees(), 0);
    assert_eq!(client.get_total_collected_fees(), uncollected);
}
