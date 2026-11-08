//! Test-only NEP-141 token: near-contract-standards' FungibleToken plus switches
//! that make `ft_transfer` or `storage_deposit` fail, for the escrow's rollback tests.

use near_contract_standards::fungible_token::{
    FungibleToken, FungibleTokenCore, FungibleTokenResolver,
};
use near_contract_standards::storage_management::{
    StorageBalance, StorageBalanceBounds, StorageManagement,
};
use near_sdk::json_types::U128;
use near_sdk::{env, near, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockFt {
    token: FungibleToken,
    fail_transfers: bool,
    fail_storage: bool,
    /// ft_transfer resolves only after this many extra self-calls (one block each), so a
    /// test can land something (an upgrade) between a claim and its callback.
    slow_hops: u8,
}

#[near]
impl MockFt {
    #[init]
    pub fn new(owner_id: AccountId, total_supply: U128) -> Self {
        let mut token = FungibleToken::new(b"t".to_vec());
        token.internal_register_account(&owner_id);
        token.internal_deposit(&owner_id, total_supply.0);
        Self { token, fail_transfers: false, fail_storage: false, slow_hops: 0 }
    }

    pub fn set_fail(&mut self, transfers: bool, storage: bool) {
        self.fail_transfers = transfers;
        self.fail_storage = storage;
    }

    pub fn set_slow(&mut self, hops: u8) {
        self.slow_hops = hops;
    }

    /// Self-call chain used to delay ft_transfer's result.
    pub fn hop(&mut self, left: u8) -> PromiseOrValue<()> {
        if left == 0 {
            return PromiseOrValue::Value(());
        }
        PromiseOrValue::Promise(
            Promise::new(env::current_account_id()).function_call(
                "hop".to_string(),
                format!("{{\"left\":{}}}", left - 1).into_bytes(),
                NearToken::from_yoctonear(0),
                Gas::from_tgas(3 * left as u64),
            ),
        )
    }
}

#[near]
impl FungibleTokenCore for MockFt {
    #[payable]
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>) {
        if self.fail_transfers {
            env::panic_str("MOCK_FT_TRANSFER_FAILED");
        }
        self.token.ft_transfer(receiver_id, amount, memo);
        if self.slow_hops > 0 {
            let left = self.slow_hops;
            Promise::new(env::current_account_id())
                .function_call(
                    "hop".to_string(),
                    format!("{{\"left\":{}}}", left - 1).into_bytes(),
                    NearToken::from_yoctonear(0),
                    Gas::from_tgas(3 * left as u64),
                )
                .as_return();
        }
    }

    #[payable]
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> PromiseOrValue<U128> {
        self.token.ft_transfer_call(receiver_id, amount, memo, msg)
    }

    fn ft_total_supply(&self) -> U128 {
        self.token.ft_total_supply()
    }

    fn ft_balance_of(&self, account_id: AccountId) -> U128 {
        self.token.ft_balance_of(account_id)
    }
}

#[near]
impl FungibleTokenResolver for MockFt {
    #[private]
    fn ft_resolve_transfer(
        &mut self,
        sender_id: AccountId,
        receiver_id: AccountId,
        amount: U128,
    ) -> U128 {
        self.token.ft_resolve_transfer(sender_id, receiver_id, amount)
    }
}

#[near]
impl StorageManagement for MockFt {
    #[payable]
    fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        if self.fail_storage {
            env::panic_str("MOCK_FT_STORAGE_FAILED");
        }
        self.token.storage_deposit(account_id, registration_only)
    }

    #[payable]
    fn storage_withdraw(&mut self, amount: Option<NearToken>) -> StorageBalance {
        self.token.storage_withdraw(amount)
    }

    #[payable]
    fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        self.token.internal_storage_unregister(force).is_some()
    }

    fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        self.token.storage_balance_bounds()
    }

    fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        self.token.storage_balance_of(account_id)
    }
}
