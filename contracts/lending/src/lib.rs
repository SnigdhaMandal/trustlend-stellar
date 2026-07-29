#![no_std]
#![allow(clippy::too_many_arguments)]
use soroban_sdk::token;
use soroban_sdk::{
    contract, contractclient, contractimpl, contracttype, symbol_short, Address, Bytes, BytesN, Env, Vec,
};

#[contractclient(name = "FlashLoanReceiverClient")]
pub trait FlashLoanReceiver {
    fn execute_operation(
        env: Env,
        token: Address,
        amount: i128,
        fee: i128,
        pool: Address,
        params: Bytes,
    );
}

// ─── Types ────────────────────────────────────────────────────────────────────

/// Full lifecycle status of a loan.
#[contracttype]
#[derive(Clone, Eq, PartialEq)]
#[cfg_attr(test, derive(Debug))]
pub enum LoanStatus {
    Pending,
    Approved,
    Active,
    Repaid,
    Defaulted,
    Cancelled,
}

/// Interest rate model for a loan.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InterestRateModel {
    Fixed,
    Floating,
}

/// A single loan record.
#[contracttype]
#[derive(Clone)]
pub struct LoanRequestInput {
    pub amount: i128,
    pub duration_days: u32,
    pub interest_rate_bps: u32,
    pub max_loan_amount: i128,
    pub collateral_asset: Address,
    pub collateral_amount: i128,
}

#[contracttype]
#[derive(Clone)]
pub struct LoanRecord {
    pub id: u32,
    pub borrower: Address,
    pub lender: Address,
    /// Principal in stroops
    pub amount: i128,
    pub duration_days: u32,
    /// Interest rate in basis-points (1500 = 15.00 %)
    pub interest_rate_bps: u32,
    /// Principal + full interest in stroops
    pub total_due: i128,
    /// Remaining balance the borrower still owes
    pub remaining_due: i128,
    /// Ledger timestamp of loan creation
    pub created_at: u64,
    /// Ledger timestamp of repayment deadline
    pub due_at: u64,
    pub status: LoanStatus,
    /// Escrow ID from the EscrowContract
    pub escrow_id: u32,
    /// Platform fee taken (1% of interest, in stroops)
    pub platform_fee: i128,
    /// Collateral asset address (or XLM as default)
    pub collateral_asset: Address,
    /// Collateral amount in asset's smallest unit
    pub collateral_amount: i128,
    /// Interest rate model: Fixed or Floating
    pub rate_model: InterestRateModel,
    /// Baseline rate at loan creation in bps (anchors floating calculations)
    pub base_rate_bps: u32,
    /// Timestamp of the last floating rate adjustment
    pub last_rate_update: u64,
}

/// A partial/full payment record.
#[contracttype]
#[derive(Clone)]
pub struct PaymentRecord {
    pub loan_id: u32,
    pub amount: i128,
    pub paid_at: u64,
}

/// Ledger storage keys.
#[contracttype]
pub enum DataKey {
    Loan(u32),
    LoanCount,
    BorrowerLoanCount(Address),
    BorrowerLoanAt(Address, u32),
    LenderLoanCount(Address),
    LenderLoanAt(Address, u32),
    Payment(u32, u32),
    PaymentCount(u32),
    Admin,
    PlatformFeeBps,
    Governance,
    WhitelistedAsset(Address),
    /// Link to MultiSigAdmin contract
    MultiSigAdmin,
    /// List of multisig admin addresses
    MultisigAdmins,
    /// Number of admin signatures required to pause/unpause
    MultisigThreshold,
    /// Whether the contract is paused
    IsPaused,
    /// Whether a given signer has already called pause (dedup)
    PauseSigner(Address),
    /// Number of unique signers who have called pause
    PauseSignerCount,
    /// Whether a given signer has already called unpause (dedup)
    UnpauseSigner(Address),
    /// Number of unique signers who have called unpause
    UnpauseSignerCount,
    /// Flash loan fee bps
    FlashLoanFeeBps,
    /// Cooldown timestamp for rate switches
    RateSwitchCooldown(u32),
    /// Uncollected accrued platform fees for Treasury collection
    UncollectedFees,
}

/// Default platform fee = 1 % of interest (100 bps) until governance changes it.
const DEFAULT_PLATFORM_FEE_BPS: u32 = 100;
/// Safety ceiling: the fee can never exceed 10 % of interest (1000 bps),
/// even via a passed proposal.
const MAX_PLATFORM_FEE_BPS: u32 = 1000;

/// Default flash-loan fee = 0.09 % of the borrowed amount (9 bps) — in line
/// with common DeFi flash-loan pricing.
const DEFAULT_FLASH_LOAN_FEE_BPS: u32 = 9;
/// Safety ceiling on the flash-loan fee (500 bps = 5 %).
const MAX_FLASH_LOAN_FEE_BPS: u32 = 500;

/// Fee for switching rate models: 0.5% of remaining debt (50 bps).
const RATE_SWITCH_FEE_BPS: u32 = 50;

/// Cooldown between rate switches: 24 hours in seconds.
const RATE_SWITCH_COOLDOWN_SECS: u64 = 86_400;

// ─── Contract ─────────────────────────────────────────────────────────────────

#[contract]
pub struct LendingContract;

#[allow(clippy::too_many_arguments)]
#[contractimpl]
impl LendingContract {
    // TODO (RWA Collateral Integration):
    // 1. Compatibility Check for Customized Asset Contracts:
    //    - Implement a validation helper `validate_rwa_token_compatibility(env: &Env, token_address: &Address)` to ensure
    //      the token contract implements the standard SEP-41 Token interface or custom compliance controls (clawback, transfer rules).
    //    - Store a whitelist of compatible tokenized assets (e.g. tokenized gold, US Treasury Bills) in instance storage.
    // 2. On-chain Oracle Price Feed Queries:
    //    - Integrate an oracle interface query to fetch real-time USD/XLM values for tokenized assets (e.g. XAU/USD, TBILL/USD).
    //    - Use the price feed to verify that the value of the deposited RWA collateral meets the required loan-to-value (LTV) ratio
    //      before approving or activating the loan.

    // ── Admin ─────────────────────────────────────────────────────────────────

    pub fn initialize(env: Env, admin: Address) {
        if env.storage().instance().has(&DataKey::Admin) {
            panic!("Contract already initialised");
        }
        env.storage().instance().set(&DataKey::Admin, &admin);
        env.storage().instance().set(&DataKey::LoanCount, &0u32);
        // Whitelist XLM as default collateral asset (using dummy address for now)
        // In real implementation, we'd use the native asset identifier
        env.storage()
            .instance()
            .set(&DataKey::WhitelistedAsset(admin.clone()), &true);
    }

    /// Upgrade the contract's code while preserving its storage.
    pub fn upgrade(env: Env, caller: Address, new_wasm_hash: BytesN<32>) {
        caller.require_auth();
        Self::assert_admin(&env, &caller);
        env.deployer().update_current_contract_wasm(new_wasm_hash);
    }

    /// Configure multi-sig admin set for pause/unpause.
    /// The original single admin is automatically included.
    /// `threshold` must be >= 1 and <= admins.len().
    pub fn setup_multisig(env: Env, admin: Address, admins: Vec<Address>, threshold: u32) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);

        if threshold == 0 {
            panic!("Threshold must be at least 1");
        }
        if threshold > admins.len() {
            panic!("Threshold exceeds number of admins");
        }

        // Ensure the single admin is included in the multisig list
        let mut final_admins = admins;
        let has_admin = final_admins.iter().any(|a| a == admin);
        if !has_admin {
            final_admins.push_back(admin);
        }

        env.storage()
            .instance()
            .set(&DataKey::MultisigThreshold, &threshold);
        env.storage()
            .instance()
            .set(&DataKey::MultisigAdmins, &final_admins);
        env.storage().instance().set(&DataKey::IsPaused, &false);
        env.storage()
            .instance()
            .set(&DataKey::PauseSignerCount, &0u32);
        env.storage()
            .instance()
            .set(&DataKey::UnpauseSignerCount, &0u32);
    }

    /// Multi-sig pause: requires `threshold` unique admin signatures.
    /// Each admin calls this once; the contract tracks unique signers.
    pub fn pause(env: Env, caller: Address) {
        caller.require_auth();
        Self::assert_multisig_admin(&env, &caller);

        let is_paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::IsPaused)
            .unwrap_or(false);
        if is_paused {
            panic!("Contract is already paused");
        }

        // Dedup: only count each signer once
        let signer_key = DataKey::PauseSigner(caller.clone());
        if env.storage().instance().has(&signer_key) {
            panic!("Signer has already authorised pause");
        }
        env.storage().instance().set(&signer_key, &true);

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::PauseSignerCount)
            .unwrap_or(0);
        let new_count = count + 1;
        env.storage()
            .instance()
            .set(&DataKey::PauseSignerCount, &new_count);

        let threshold: u32 = Self::get_multisig_threshold(env.clone());
        if new_count >= threshold {
            env.storage().instance().set(&DataKey::IsPaused, &true);
            // Reset signer tracking for next pause cycle
            env.storage()
                .instance()
                .set(&DataKey::PauseSignerCount, &0u32);
            env.events()
                .publish((symbol_short!("lending"), symbol_short!("paused")), ());
        }
    }

    /// Multi-sig unpause: requires `threshold` unique admin signatures.
    pub fn unpause(env: Env, caller: Address) {
        caller.require_auth();
        Self::assert_multisig_admin(&env, &caller);

        let is_paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::IsPaused)
            .unwrap_or(false);
        if !is_paused {
            panic!("Contract is not paused");
        }

        let signer_key = DataKey::UnpauseSigner(caller.clone());
        if env.storage().instance().has(&signer_key) {
            panic!("Signer has already authorised unpause");
        }
        env.storage().instance().set(&signer_key, &true);

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::UnpauseSignerCount)
            .unwrap_or(0);
        let new_count = count + 1;
        env.storage()
            .instance()
            .set(&DataKey::UnpauseSignerCount, &new_count);

        let threshold: u32 = Self::get_multisig_threshold(env.clone());
        if new_count >= threshold {
            env.storage().instance().set(&DataKey::IsPaused, &false);
            env.storage()
                .instance()
                .set(&DataKey::UnpauseSignerCount, &0u32);
            env.events()
                .publish((symbol_short!("lending"), symbol_short!("unpaused")), ());
        }
    }

    pub fn is_paused(env: Env) -> bool {
        env.storage()
            .instance()
            .get(&DataKey::IsPaused)
            .unwrap_or(false)
    }

    pub fn get_multisig_admins(env: Env) -> Vec<Address> {
        env.storage()
            .instance()
            .get(&DataKey::MultisigAdmins)
            .unwrap_or(Vec::new(&env))
    }

    pub fn get_multisig_threshold(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::MultisigThreshold)
            .unwrap_or(1)
    }

    pub fn get_pause_signer_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::PauseSignerCount)
            .unwrap_or(0)
    }

    /// One-time bootstrap linking the MultiSigAdmin contract (admin only).
    pub fn set_multisig_admin(env: Env, admin: Address, multisig: Address) {
        admin.require_auth();
        Self::assert_admin(&env, &admin);
        if env.storage().instance().has(&DataKey::MultiSigAdmin) {
            panic!("Multisig admin already configured");
        }
        env.storage()
            .instance()
            .set(&DataKey::MultiSigAdmin, &multisig);
        let mut msig_admins = Vec::new(&env);
        msig_admins.push_back(multisig);
        env.storage()
            .instance()
            .set(&DataKey::MultisigAdmins, &msig_admins);
    }

    pub fn get_multisig_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::MultiSigAdmin)
            .expect("Multisig admin not configured")
    }

    /// Whitelist a new collateral asset ("adding pools"). Multisig-gated —
    /// see `set_multisig_admin`.
    pub fn whitelist_asset(env: Env, caller: Address, asset: Address) {
        caller.require_auth();
        Self::assert_multisig_admin(&env, &caller);
        env.storage()
            .instance()
            .set(&DataKey::WhitelistedAsset(asset), &true);
    }

    /// Check if an asset is whitelisted
    pub fn is_asset_whitelisted(env: Env, asset: Address) -> bool {
        env.storage()
            .instance()
            .has(&DataKey::WhitelistedAsset(asset))
    }

    pub fn get_admin(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Contract not initialised")
    }

    // ── DAO governance of the platform fee ──────────────────────────────────────

    /// Link the Governance contract (multisig-gated, one-time bootstrap).
    /// Once set, the platform fee can ONLY be changed by this contract — i.e.
    /// by a successful on-chain vote.
    pub fn set_governance(env: Env, caller: Address, governance: Address) {
        caller.require_auth();
        Self::assert_multisig_admin(&env, &caller);
        env.storage()
            .instance()
            .set(&DataKey::Governance, &governance);
    }

    pub fn get_governance(env: Env) -> Address {
        env.storage()
            .instance()
            .get(&DataKey::Governance)
            .expect("Governance not configured")
    }

    /// Current platform fee in basis-points of interest (default 100 = 1 %).
    pub fn get_platform_fee_bps(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::PlatformFeeBps)
            .unwrap_or(DEFAULT_PLATFORM_FEE_BPS)
    }

    /// Update the platform fee. Callable ONLY by the linked Governance contract,
    /// which invokes this after a proposal passes. This is the single on-chain
    /// path to changing the fee — there is intentionally no admin override.
    pub fn set_platform_fee_bps(env: Env, caller: Address, new_fee_bps: u32) {
        caller.require_auth();

        let governance: Address = env
            .storage()
            .instance()
            .get(&DataKey::Governance)
            .expect("Governance not configured");
        if caller != governance {
            panic!("Unauthorised: only Governance can change the platform fee");
        }
        if new_fee_bps > MAX_PLATFORM_FEE_BPS {
            panic!("Fee exceeds MAX_PLATFORM_FEE_BPS");
        }

        env.storage()
            .instance()
            .set(&DataKey::PlatformFeeBps, &new_fee_bps);
    }

    pub fn get_uncollected_fees(env: Env) -> i128 {
        env.storage().instance().get(&DataKey::UncollectedFees).unwrap_or(0)
    }

    pub fn collect_fees(env: Env, caller: Address, treasury_address: Address) -> i128 {
        caller.require_auth();
        let uncollected: i128 = Self::get_uncollected_fees(env.clone());
        if uncollected <= 0 {
            return 0;
        }
        env.storage().instance().set(&DataKey::UncollectedFees, &0i128);
        env.events().publish(
            (symbol_short!("fees"), symbol_short!("collected")),
            (treasury_address, uncollected),
        );
        uncollected
    }

    // ── Flash loans ──────────────────────────────────────────────────────────

    /// Current flash-loan fee in basis-points of the borrowed amount
    /// (default 9 = 0.09 %).
    pub fn get_flash_loan_fee_bps(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::FlashLoanFeeBps)
            .unwrap_or(DEFAULT_FLASH_LOAN_FEE_BPS)
    }

    /// Update the flash-loan fee ("interest rate table"), multisig-gated.
    /// Capped at `MAX_FLASH_LOAN_FEE_BPS`.
    pub fn set_flash_loan_fee_bps(env: Env, caller: Address, new_fee_bps: u32) {
        caller.require_auth();
        Self::assert_multisig_admin(&env, &caller);
        if new_fee_bps > MAX_FLASH_LOAN_FEE_BPS {
            panic!("Fee exceeds MAX_FLASH_LOAN_FEE_BPS");
        }
        env.storage()
            .instance()
            .set(&DataKey::FlashLoanFeeBps, &new_fee_bps);
    }

    /// Uncollateralized, single-transaction flash loan against the pool's own
    /// balance of `token`.
    ///
    /// Flow (all within this one call, hence one atomic ledger transaction):
    ///   1. Verify the pool holds at least `amount` of `token`.
    ///   2. Transfer `amount` of `token` to `receiver`.
    ///   3. Invoke `receiver.execute_operation(token, amount, fee, self, params)`
    ///      — the receiver's arbitrage/re-leveraging logic runs here and MUST
    ///      transfer `amount + fee` back to this contract before returning.
    ///   4. Verify the pool's balance grew by at least `fee`; if not, PANIC.
    ///
    /// A panic anywhere in this call — including inside the receiver's own
    /// callback — aborts the WHOLE transaction on Soroban, so step 2's transfer
    /// is rolled back along with everything else. There is no code path that
    /// leaves the pool short: either the loan is fully repaid plus fee, or the
    /// entire transaction (including the initial disbursement) never happened.
    pub fn flash_loan(env: Env, receiver: Address, token: Address, amount: i128, params: Bytes) {
        if amount <= 0 {
            panic!("Flash loan amount must be positive");
        }

        let token_client = token::Client::new(&env, &token);
        let pool = env.current_contract_address();
        let balance_before = token_client.balance(&pool);

        if balance_before < amount {
            panic!("Insufficient pool liquidity for flash loan");
        }

        let fee_bps = Self::get_flash_loan_fee_bps(env.clone());
        let fee = amount
            .checked_mul(fee_bps as i128)
            .expect("Overflow computing flash loan fee")
            / 10_000;
        let required_after = balance_before
            .checked_add(fee)
            .expect("Overflow computing required post-loan balance");

        // 2. Disburse the borrowed amount to the receiver.
        token_client.transfer(&pool, &receiver, &amount);

        // 3. Hand control to the receiver's callback.
        let receiver_client = FlashLoanReceiverClient::new(&env, &receiver);
        receiver_client.execute_operation(&token, &amount, &fee, &pool, &params);

        // 4. Enforce full repayment (principal + fee) — or roll back everything.
        let balance_after = token_client.balance(&pool);
        if balance_after < required_after {
            panic!("Flash loan not repaid: insufficient funds returned");
        }

        env.events().publish(
            (symbol_short!("flash"), symbol_short!("loan")),
            (receiver, token, amount, fee),
        );
    }

    // ── Loan lifecycle ────────────────────────────────────────────────────────

    /// Borrower creates a loan request.
    /// `interest_rate_bps` and `max_loan` are fetched off-chain from the
    /// ReputationContract and passed in so we avoid a cross-contract call
    /// on the critical path (cheaper, simpler on testnet).
    pub fn create_loan_request(
        env: Env,
        borrower: Address,
        request: LoanRequestInput,
    ) -> u32 {
        borrower.require_auth();
        Self::assert_not_paused(&env);

        let LoanRequestInput {
            amount,
            duration_days,
            interest_rate_bps,
            max_loan_amount,
            collateral_asset,
            collateral_amount,
        } = request;

        if amount <= 0 {
            panic!("Loan amount must be positive");
        }
        if amount > max_loan_amount {
            panic!("Amount exceeds reputation-based limit");
        }
        if duration_days == 0 || duration_days > 365 {
            panic!("Duration must be between 1 and 365 days");
        }
        if collateral_amount <= 0 {
            panic!("Collateral amount must be positive");
        }
        // Check if asset is whitelisted
        if !env
            .storage()
            .instance()
            .has(&DataKey::WhitelistedAsset(collateral_asset.clone()))
        {
            panic!("Collateral asset is not whitelisted");
        }

        // interest = principal × rate_bps × days / (10_000 × 365)
        let interest = Self::calculate_interest(amount, interest_rate_bps, duration_days);
        // Platform fee = (governance-controlled) fee_bps of interest.
        let fee_bps = Self::get_platform_fee_bps(env.clone());
        let platform_fee = interest
            .checked_mul(fee_bps as i128)
            .expect("Overflow: interest × fee_bps")
            / 10_000;
        let total_due = amount
            .checked_add(interest)
            .expect("Overflow computing total_due");

        let count: u32 = env
            .storage()
            .instance()
            .get(&DataKey::LoanCount)
            .unwrap_or(0);
        let loan_id = count + 1;

        let now = env.ledger().timestamp();
        // Compute due_at with overflow protection: days * 86_400 seconds
        let duration_secs: u64 = (duration_days as u64)
            .checked_mul(86_400)
            .expect("Overflow computing loan duration in seconds");
        let due_at = now
            .checked_add(duration_secs)
            .expect("Overflow computing due_at timestamp");

        let loan = LoanRecord {
            id: loan_id,
            borrower: borrower.clone(),
            lender: env.current_contract_address(), // placeholder until approved
            amount,
            duration_days,
            interest_rate_bps,
            total_due,
            remaining_due: total_due,
            created_at: now,
            due_at,
            status: LoanStatus::Pending,
            escrow_id: 0,
            platform_fee,
            collateral_asset,
            collateral_amount,
            // New loans always start on the fixed model; borrowers opt into
            // floating rates afterwards via `switch_rate_model`.
            rate_model: InterestRateModel::Fixed,
            base_rate_bps: interest_rate_bps,
            last_rate_update: now,
        };

        env.storage()
            .persistent()
            .set(&DataKey::Loan(loan_id), &loan);
        env.storage().instance().set(&DataKey::LoanCount, &loan_id);

        let current_fees: i128 = env.storage().instance().get(&DataKey::UncollectedFees).unwrap_or(0);
        env.storage().instance().set(&DataKey::UncollectedFees, &(current_fees + platform_fee));

        // Track per-borrower list
        Self::push_loan_id_for_borrower(&env, &borrower, loan_id);

        env.events().publish(
            (symbol_short!("loan"), symbol_short!("request")),
            (
                loan_id,
                borrower,
                amount,
                duration_days,
                interest_rate_bps,
                total_due,
                due_at,
            ),
        );

        loan_id
    }

    /// Lender approves a pending loan.
    pub fn approve_loan(env: Env, lender: Address, loan_id: u32, escrow_id: u32) {
        lender.require_auth();
        Self::assert_not_paused(&env);

        let mut loan = Self::get_loan(env.clone(), loan_id);
        if loan.status != LoanStatus::Pending {
            panic!("Loan is not in PENDING state");
        }

        loan.lender = lender.clone();
        loan.escrow_id = escrow_id;
        loan.status = LoanStatus::Approved;

        env.storage()
            .persistent()
            .set(&DataKey::Loan(loan_id), &loan);
        Self::push_loan_id_for_lender(&env, &lender, loan_id);

        env.events().publish(
            (symbol_short!("loan"), symbol_short!("approved")),
            (loan_id, lender, escrow_id),
        );
    }

    /// Lender revokes an approved loan (within the 1-hour escrow window).
    /// The EscrowContract's `revoke_hold` must be called separately.
    pub fn revoke_approval(env: Env, lender: Address, loan_id: u32) {
        lender.require_auth();

        let mut loan = Self::get_loan(env.clone(), loan_id);
        if loan.lender != lender {
            panic!("Caller is not the lender");
        }
        if loan.status != LoanStatus::Approved {
            panic!("Loan is not in APPROVED state");
        }

        loan.status = LoanStatus::Pending;
        loan.lender = env.current_contract_address();
        loan.escrow_id = 0;
        env.storage()
            .persistent()
            .set(&DataKey::Loan(loan_id), &loan);

        env.events()
            .publish((symbol_short!("loan"), symbol_short!("revoked")), loan_id);
    }

    /// Admin/backend activates the loan once escrow disbursement is confirmed.
    pub fn activate_loan(env: Env, caller: Address, loan_id: u32) {
        caller.require_auth();
        Self::assert_admin(&env, &caller);
        Self::assert_not_paused(&env);

        let mut loan = Self::get_loan(env.clone(), loan_id);
        if loan.status != LoanStatus::Approved {
            panic!("Loan must be APPROVED before activation");
        }
        loan.status = LoanStatus::Active;
        env.storage()
            .persistent()
            .set(&DataKey::Loan(loan_id), &loan);

        env.events()
            .publish((symbol_short!("loan"), symbol_short!("active")), loan_id);
    }

    /// Record a repayment (partial or full).
    /// Actual XLM moves via PAYMENT op; admin calls this after Horizon confirm.
    pub fn record_payment(env: Env, caller: Address, loan_id: u32, amount: i128) -> LoanStatus {
        caller.require_auth();
        Self::assert_admin(&env, &caller);

        let mut loan = Self::get_loan(env.clone(), loan_id);
        if loan.status != LoanStatus::Active {
            panic!("Loan is not ACTIVE");
        }
        if amount <= 0 {
            panic!("Payment amount must be positive");
        }

        // Store payment record
        let payment_count: u32 = env
            .storage()
            .persistent()
            .get(&DataKey::PaymentCount(loan_id))
            .unwrap_or(0);
        let new_count = payment_count + 1;
        let payment = PaymentRecord {
            loan_id,
            amount,
            paid_at: env.ledger().timestamp(),
        };
        env.storage()
            .persistent()
            .set(&DataKey::Payment(loan_id, new_count), &payment);
        env.storage()
            .persistent()
            .set(&DataKey::PaymentCount(loan_id), &new_count);

        // Reduce remaining balance (clamped to 0)
        if amount >= loan.remaining_due {
            loan.remaining_due = 0;
            loan.status = LoanStatus::Repaid;
        } else {
            loan.remaining_due -= amount;
        }

        env.storage()
            .persistent()
            .set(&DataKey::Loan(loan_id), &loan);
        env.events().publish(
            (symbol_short!("loan"), symbol_short!("payment")),
            (loan_id, amount, loan.remaining_due, loan.status.clone()),
        );
        loan.status
    }

    /// Mark a loan as defaulted (called by DefaultManagementContract or admin).
    pub fn mark_defaulted(env: Env, caller: Address, loan_id: u32) {
        caller.require_auth();
        Self::assert_admin(&env, &caller);
        Self::assert_not_paused(&env);

        let mut loan = Self::get_loan(env.clone(), loan_id);
        if loan.status != LoanStatus::Active {
            panic!("Only ACTIVE loans can be defaulted");
        }
        loan.status = LoanStatus::Defaulted;
        env.storage()
            .persistent()
            .set(&DataKey::Loan(loan_id), &loan);

        env.events()
            .publish((symbol_short!("loan"), symbol_short!("default")), loan_id);
    }

    // ── Rate model switching ─────────────────────────────────────────────────

    /// Borrower switches their loan between Fixed and Floating rate models.
    /// Charges a 0.5% fee on remaining debt and enforces a 24h cooldown.
    pub fn switch_rate_model(env: Env, borrower: Address, loan_id: u32) {
        borrower.require_auth();

        let mut loan = Self::get_loan(env.clone(), loan_id);
        if loan.borrower != borrower {
            panic!("Caller is not the borrower");
        }
        if loan.status != LoanStatus::Active {
            panic!("Can only switch rate model on ACTIVE loans");
        }

        // Enforce cooldown
        let now = env.ledger().timestamp();
        let last_switch: u64 = env
            .storage()
            .persistent()
            .get(&DataKey::RateSwitchCooldown(loan_id))
            .unwrap_or(0);
        if last_switch > 0 && (now - last_switch) < RATE_SWITCH_COOLDOWN_SECS {
            panic!("Rate switch cooldown not elapsed (24h required)");
        }

        // Charge switch fee: 0.5% of remaining debt
        let fee = loan
            .remaining_due
            .checked_mul(RATE_SWITCH_FEE_BPS as i128)
            .expect("Overflow computing switch fee")
            / 10_000;
        loan.remaining_due = loan
            .remaining_due
            .checked_add(fee)
            .expect("Overflow adding switch fee");
        loan.total_due = loan
            .total_due
            .checked_add(fee)
            .expect("Overflow adding switch fee to total");

        // Toggle model
        loan.rate_model = match loan.rate_model {
            InterestRateModel::Fixed => InterestRateModel::Floating,
            InterestRateModel::Floating => InterestRateModel::Fixed,
        };
        loan.last_rate_update = now;

        env.storage()
            .persistent()
            .set(&DataKey::Loan(loan_id), &loan);
        env.storage()
            .persistent()
            .set(&DataKey::RateSwitchCooldown(loan_id), &now);

        env.events().publish(
            (symbol_short!("loan"), symbol_short!("rswitch")),
            (loan_id, loan.rate_model, fee),
        );
    }

    /// Admin updates the floating rate for a loan (called on state-changing interactions).
    /// Only applies to Floating-rate loans. Recalculates remaining interest.
    pub fn update_floating_rate(env: Env, caller: Address, loan_id: u32, new_rate_bps: u32) {
        caller.require_auth();
        Self::assert_admin(&env, &caller);

        let mut loan = Self::get_loan(env.clone(), loan_id);
        if loan.rate_model != InterestRateModel::Floating {
            panic!("Loan is not using floating rate model");
        }
        if loan.status != LoanStatus::Active {
            panic!("Can only update rate on ACTIVE loans");
        }

        let now = env.ledger().timestamp();

        // Compute remaining days
        let remaining_secs = loan.due_at.saturating_sub(now);
        let remaining_days = (remaining_secs / 86_400) as u32;

        // Recalculate: amount already paid stays, recompute interest on remaining principal
        let paid_so_far = loan.total_due - loan.remaining_due;
        let remaining_principal = if loan.remaining_due > 0 {
            // Approximate remaining principal from remaining_due and old rate
            loan.amount
        } else {
            0
        };

        let new_interest =
            Self::calculate_interest(remaining_principal, new_rate_bps, remaining_days);
        let new_total_due = loan
            .amount
            .checked_add(new_interest)
            .expect("Overflow recomputing total_due");
        loan.total_due = new_total_due;
        loan.remaining_due = new_total_due
            .checked_sub(paid_so_far)
            .expect("Underflow computing new remaining_due");
        loan.interest_rate_bps = new_rate_bps;
        loan.last_rate_update = now;

        env.storage()
            .persistent()
            .set(&DataKey::Loan(loan_id), &loan);

        env.events().publish(
            (symbol_short!("loan"), symbol_short!("ratechg")),
            (loan_id, new_rate_bps, loan.remaining_due),
        );
    }

    // ── Queries ───────────────────────────────────────────────────────────────

    pub fn get_loan(env: Env, loan_id: u32) -> LoanRecord {
        env.storage()
            .persistent()
            .get(&DataKey::Loan(loan_id))
            .expect("Loan not found")
    }

    pub fn get_loan_count(env: Env) -> u32 {
        env.storage()
            .instance()
            .get(&DataKey::LoanCount)
            .unwrap_or(0)
    }

    /// Check whether a loan is overdue.
    pub fn is_overdue(env: Env, loan_id: u32) -> bool {
        let loan = Self::get_loan(env.clone(), loan_id);
        loan.status == LoanStatus::Active && env.ledger().timestamp() > loan.due_at
    }

    /// Days overdue (0 if not overdue yet).
    pub fn days_overdue(env: Env, loan_id: u32) -> u64 {
        let loan = Self::get_loan(env.clone(), loan_id);
        let now = env.ledger().timestamp();
        if loan.status == LoanStatus::Active && now > loan.due_at {
            (now - loan.due_at) / 86_400
        } else {
            0
        }
    }

    pub fn get_payment_count(env: Env, loan_id: u32) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::PaymentCount(loan_id))
            .unwrap_or(0)
    }

    pub fn get_payment(env: Env, loan_id: u32, payment_index: u32) -> PaymentRecord {
        env.storage()
            .persistent()
            .get(&DataKey::Payment(loan_id, payment_index))
            .expect("Payment not found")
    }

    /// Calculate dynamic liquidation threshold based on borrower reputation score
    /// and asset volatility.
    ///
    /// - Base threshold: 7500 basis points (75.00%).
    /// - Reputation bonus: adds `reputation_score * 1.5` basis points (max 1500 bps).
    /// - Volatility penalty: subtracts `50%` of asset volatility bps.
    /// - Clamped between 5000 bps (50.00%) and 9000 bps (90.00%).
    /// - Uses checked arithmetic to prevent overflow.
    pub fn calculate_liquidation_threshold(
        _env: Env,
        borrower_reputation_score: u32,
        asset_volatility_bps: u32,
    ) -> u32 {
        let base_threshold: u32 = 7500;

        // reputation_bonus = borrower_reputation_score * 1.5
        let reputation_bonus = (borrower_reputation_score as u64)
            .checked_mul(15)
            .and_then(|v| v.checked_div(10))
            .expect("Overflow calculating reputation bonus");

        // volatility_penalty = asset_volatility_bps / 2
        let volatility_penalty = (asset_volatility_bps as u64)
            .checked_div(2)
            .expect("Overflow calculating volatility penalty");

        let threshold = (base_threshold as u64)
            .checked_add(reputation_bonus)
            .expect("Overflow adding reputation bonus")
            .saturating_sub(volatility_penalty);

        threshold.clamp(5000, 9000) as u32
    }

    /// Number of loans a borrower has created.
    pub fn get_borrower_loan_count(env: Env, borrower: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::BorrowerLoanCount(borrower))
            .unwrap_or(0)
    }

    /// Loan ID at a given index for a borrower (0-based).
    pub fn get_borrower_loan_at(env: Env, borrower: Address, index: u32) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::BorrowerLoanAt(borrower, index))
            .expect("Index out of bounds")
    }

    /// Number of loans a lender has approved.
    pub fn get_lender_loan_count(env: Env, lender: Address) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::LenderLoanCount(lender))
            .unwrap_or(0)
    }

    /// Loan ID at a given index for a lender (0-based).
    pub fn get_lender_loan_at(env: Env, lender: Address, index: u32) -> u32 {
        env.storage()
            .persistent()
            .get(&DataKey::LenderLoanAt(lender, index))
            .expect("Index out of bounds")
    }

    // ── Private helpers ───────────────────────────────────────────────────────

    /// interest = principal × rate_bps × days / (10_000 × 365)
    ///
    /// Uses checked arithmetic so that absurdly large principals or rates
    /// cause an explicit panic instead of silent integer wrap-around.
    fn calculate_interest(principal: i128, rate_bps: u32, days: u32) -> i128 {
        let numerator = principal
            .checked_mul(rate_bps as i128)
            .expect("Overflow: principal × rate_bps")
            .checked_mul(days as i128)
            .expect("Overflow: (principal × rate_bps) × days");
        numerator / (10_000_i128 * 365)
    }

    fn push_loan_id_for_borrower(env: &Env, borrower: &Address, loan_id: u32) {
        let count_key = DataKey::BorrowerLoanCount(borrower.clone());
        let count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::BorrowerLoanAt(borrower.clone(), count), &loan_id);
        env.storage().persistent().set(&count_key, &(count + 1));
    }

    fn push_loan_id_for_lender(env: &Env, lender: &Address, loan_id: u32) {
        let count_key = DataKey::LenderLoanCount(lender.clone());
        let count: u32 = env.storage().persistent().get(&count_key).unwrap_or(0);
        env.storage()
            .persistent()
            .set(&DataKey::LenderLoanAt(lender.clone(), count), &loan_id);
        env.storage().persistent().set(&count_key, &(count + 1));
    }

    fn assert_admin(env: &Env, caller: &Address) {
        // Check multisig admins first, then fall back to single admin
        let multisig_admins: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::MultisigAdmins)
            .unwrap_or(Vec::new(env));
        if !multisig_admins.is_empty() && multisig_admins.iter().any(|a| a == *caller) {
            return;
        }
        let admin: Address = env
            .storage()
            .instance()
            .get(&DataKey::Admin)
            .expect("Contract not initialised");
        if *caller != admin {
            panic!("Unauthorised: caller is not admin");
        }
    }

    fn assert_multisig_admin(env: &Env, caller: &Address) {
        let multisig_admins: Vec<Address> = env
            .storage()
            .instance()
            .get(&DataKey::MultisigAdmins)
            .unwrap_or(Vec::new(env));
        if multisig_admins.is_empty() {
            panic!("Multisig not configured");
        }
        if !multisig_admins.iter().any(|a| a == *caller) {
            panic!("Unauthorised: caller is not a multisig admin");
        }
    }

    fn assert_not_paused(env: &Env) {
        let is_paused: bool = env
            .storage()
            .instance()
            .get(&DataKey::IsPaused)
            .unwrap_or(false);
        if is_paused {
            panic!("Contract is paused");
        }
    }
}

#[cfg(test)]
mod test;
