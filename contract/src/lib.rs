//! Zarf on NEAR: NEP-141 escrow paying claims signed by a registered verifier.
//! Byte formats, check order, errors, events and views: `spec/claim.md` (v2.1).
//!
//! Init, verifier registry (owner path; Mode T is T11), sender pre-pay and per-campaign
//! storage reservations, campaign creation, `claim` (ordered checks, then
//! storage_deposit -> ft_transfer -> callback), the owner's `resolve_pending` exit, reclaim.

use near_sdk::json_types::{U128, U64};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::serde_json::{self, json};
use near_sdk::store::{IterableMap, LookupMap};
use near_sdk::{
    env, near, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise,
    PromiseError, PromiseOrValue,
};

pub const E101: &str = "E101_INVALID_SIGNATURE";
pub const E102: &str = "E102_INVALID_MERKLE_PROOF";
pub const E105: &str = "E105_ALREADY_CLAIMED";
pub const E107: &str = "E107_UNAUTHORIZED";
pub const E108: &str = "E108_INVALID_INPUT";
pub const E109: &str = "E109_INVALID_AMOUNT";
pub const E110: &str = "E110_UNKNOWN_CAMPAIGN";
pub const E114: &str = "E114_CLAIM_EXPIRED";
pub const E115: &str = "E115_TOKEN_TRANSFER_FAILED";
pub const E117: &str = "E117_NOT_YET_RECLAIMABLE";
pub const E118: &str = "E118_NOTHING_TO_RECLAIM";
pub const E119: &str = "E119_INVALID_DEADLINE";
pub const E123: &str = "E123_CLAIM_PENDING";
pub const E125: &str = "E125_CAMPAIGN_ENDED";
pub const E126: &str = "E126_UNKNOWN_TOKEN";
pub const E127: &str = "E127_NO_VERIFIER";
pub const E128: &str = "E128_INSUFFICIENT_STORAGE";
pub const E129: &str = "E129_INSUFFICIENT_BALANCE";
pub const E130: &str = "E130_INSUFFICIENT_GAS";
pub const E132: &str = "E132_DUPLICATE_CAMPAIGN";

pub const DOMAIN_TAG: &[u8] = b"ZARF-NEAR-CLAIM-V1";
pub const MAX_PROOF_LEN: usize = 20;
pub const MAX_SIGNATURE_TTL_NS: u64 = 3_600 * 1_000_000_000;
/// `resolve_pending` may act only on a claim pending at least this long.
pub const PENDING_TIMEOUT_NS: u64 = 3_600 * 1_000_000_000;

// shortcut: estimates until the first sandbox run; an integration test claims with exactly
// required_claim_gas(), and the margin is then set from what it shows.
pub const GAS_STORAGE_DEPOSIT: Gas = Gas::from_tgas(10);
pub const GAS_FT_TRANSFER: Gas = Gas::from_tgas(15);
pub const GAS_CALLBACK: Gas = Gas::from_tgas(15);
pub const GAS_CLAIM_MARGIN: Gas = Gas::from_tgas(25);
pub const GAS_VIEW_BOUNDS: Gas = Gas::from_tgas(5);

fn fail(code: &str) -> ! {
    env::panic_str(code)
}

#[near(serializers = [borsh])]
#[derive(BorshStorageKey)]
enum StorageKey {
    OwnerKeys,
    Agents,
    Campaigns,
    Claims,
    Prepay,
    FtStorage,
    Roots,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
#[serde(rename_all = "lowercase")]
pub enum Policy {
    Owner,
    Attested,
}

/// A Mode T agent, registered through attestation (T11).
#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct AttestedAgent {
    pub measurement_id: [u8; 32],
    pub valid_until_ns: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum ClaimStatus {
    Pending { amount: u128, started_ns: u64 },
    Claimed,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug)]
pub struct Campaign {
    pub sender: AccountId,
    pub token: AccountId,
    pub amount: u128,
    pub merkle_root: [u8; 32],
    pub deadline_ns: u64,
    pub balance: u128,
    pub in_flight: u128,
    pub policy: Policy,
    /// Owner: allowed signer keys. Attested: allowed measurement ids.
    pub snapshot: Vec<[u8; 32]>,
    /// Pre-paid NEAR this campaign's claims draw `per_claim_storage` from.
    pub storage_reserved: u128,
}

#[derive(Deserialize)]
#[serde(crate = "near_sdk::serde", deny_unknown_fields)]
struct CreateMsg {
    merkle_root: String,
    deadline_ns: U64,
    policy: Policy,
    leaf_count: u32,
}

#[near(serializers = [json])]
#[derive(Clone)]
pub struct ClaimArgs {
    pub campaign_id: U64,
    pub commitment: String,
    pub amount: U128,
    pub proof: Vec<String>,
    pub destination: String,
    pub expires_at_ns: U64,
    pub signer: String,
    pub signature: String,
}

/// A claim that passed every synchronous check (spec check order 1-10).
#[derive(Debug, PartialEq, Eq)]
pub struct CheckedClaim {
    pub campaign_id: u64,
    pub commitment: [u8; 32],
    pub amount: u128,
    pub destination: AccountId,
    pub signer: [u8; 32],
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct CampaignView {
    pub sender: AccountId,
    pub token: AccountId,
    pub amount: U128,
    pub merkle_root: String,
    pub deadline_ns: U64,
    pub balance: U128,
    pub in_flight: U128,
    pub policy: Policy,
    pub snapshot: Vec<String>,
    pub storage_reserved: U128,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct StorageCosts {
    pub ft_storage_deposit: U128,
    pub claim_entry_cost: U128,
    pub per_claim_storage: U128,
    /// Upper bound: a campaign whose snapshot holds every current owner key.
    pub campaign_bytes_cost: U128,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct ConfigView {
    pub network: String,
    pub min_lifetime_ns: U64,
    pub agent_ttl_ns: U64,
    pub token_ids: Vec<AccountId>,
    pub storage_byte_cost: U128,
}

#[derive(Serialize)]
#[serde(crate = "near_sdk::serde")]
pub struct AgentView {
    pub kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub measurement_id: Option<String>,
    pub valid_until_ns: U64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    network: String,
    token_ids: Vec<AccountId>,
    min_lifetime_ns: u64,
    agent_ttl_ns: u64,
    next_campaign_id: u64,
    /// Storage bytes of one (pending) claim entry, measured in `new`.
    claim_entry_bytes: u64,
    /// Storage bytes of a campaign entry (max-length account ids, empty snapshot) plus its
    /// roots entry, measured in `new`; each snapshot key adds 32.
    campaign_base_bytes: u64,
    /// Mode W signer -> valid_until_ns. Kept apart from attested agents so a snapshot
    /// never scans re-registered TEE agents.
    owner_keys: IterableMap<[u8; 32], u64>,
    agents: LookupMap<[u8; 32], AttestedAgent>,
    campaigns: LookupMap<u64, Campaign>,
    /// merkle_root -> campaign id: the root is an idempotency key (E132).
    roots: LookupMap<[u8; 32], u64>,
    claims: LookupMap<(u64, [u8; 32]), ClaimStatus>,
    /// Sender -> free pre-pay (not reserved by any campaign).
    prepay: LookupMap<AccountId, u128>,
    /// token -> its `storage_balance_bounds().min`, read on chain by `refresh_token_storage`.
    ft_storage_deposit: LookupMap<AccountId, u128>,
}

#[near]
impl Contract {
    /// Private: deploy and `new` go in one batched transaction. Checked by hand (not
    /// `#[private]`) so the panic carries E107 and unit tests exercise it.
    #[init]
    pub fn new(
        owner_id: AccountId,
        network: String,
        token_ids: Vec<AccountId>,
        min_lifetime_ns: U64,
        agent_ttl_ns: U64,
    ) -> Self {
        if env::predecessor_account_id() != env::current_account_id() {
            fail(E107);
        }
        if network != "testnet" && network != "mainnet" {
            fail(E108);
        }
        let mut claims = LookupMap::new(StorageKey::Claims);
        let probe = (u64::MAX, [0xff; 32]);
        let before = env::storage_usage();
        claims.insert(probe, ClaimStatus::Pending { amount: u128::MAX, started_ns: u64::MAX });
        claims.flush();
        let claim_entry_bytes = env::storage_usage().saturating_sub(before);
        claims.remove(&probe);
        claims.flush();

        let mut campaigns = LookupMap::new(StorageKey::Campaigns);
        let longest: AccountId = "a".repeat(64).parse().unwrap_or_else(|_| fail(E108));
        let before = env::storage_usage();
        campaigns.insert(
            u64::MAX,
            Campaign {
                sender: longest.clone(),
                token: longest,
                amount: u128::MAX,
                merkle_root: [0xff; 32],
                deadline_ns: u64::MAX,
                balance: u128::MAX,
                in_flight: u128::MAX,
                policy: Policy::Attested,
                snapshot: Vec::new(),
                storage_reserved: u128::MAX,
            },
        );
        let mut roots = LookupMap::new(StorageKey::Roots);
        roots.insert([0xff; 32], u64::MAX);
        campaigns.flush();
        roots.flush();
        let campaign_base_bytes = env::storage_usage().saturating_sub(before);
        campaigns.remove(&u64::MAX);
        roots.remove(&[0xff; 32]);
        campaigns.flush();
        roots.flush();
        Self {
            owner_id,
            network,
            token_ids,
            min_lifetime_ns: min_lifetime_ns.0,
            agent_ttl_ns: agent_ttl_ns.0,
            next_campaign_id: 0,
            claim_entry_bytes,
            campaign_base_bytes,
            owner_keys: IterableMap::new(StorageKey::OwnerKeys),
            agents: LookupMap::new(StorageKey::Agents),
            campaigns,
            roots,
            claims,
            prepay: LookupMap::new(StorageKey::Prepay),
            ft_storage_deposit: LookupMap::new(StorageKey::FtStorage),
        }
    }

    /// Owner only. Reads an allowed token's `storage_balance_bounds().min` on chain
    /// (init cannot await a cross-contract view).
    pub fn refresh_token_storage(&mut self, token_id: AccountId) -> Promise {
        self.assert_owner();
        if !self.token_ids.contains(&token_id) {
            fail(E126);
        }
        Promise::new(token_id.clone())
            .function_call(
                "storage_balance_bounds".to_string(),
                b"{}".to_vec(),
                NearToken::from_yoctonear(0),
                GAS_VIEW_BOUNDS,
            )
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_VIEW_BOUNDS)
                    .on_token_storage(token_id),
            )
    }

    pub fn on_token_storage(&mut self, token_id: AccountId) -> U128 {
        if env::predecessor_account_id() != env::current_account_id() {
            fail(E107);
        }
        #[derive(Deserialize)]
        #[serde(crate = "near_sdk::serde")]
        struct Bounds {
            min: U128,
        }
        let bytes = env::promise_result_checked(0, 512).unwrap_or_else(|_| fail(E108));
        let min = serde_json::from_slice::<Bounds>(&bytes).unwrap_or_else(|_| fail(E108)).min;
        self.ft_storage_deposit.insert(token_id, min.0);
        min
    }

    // ---- verifier registry, Mode W (owner path). Mode T methods: T11. ----

    pub fn add_owner_key(&mut self, signer: String, valid_until_ns: U64) {
        self.assert_owner();
        let key = hex32(&signer);
        if self.owner_keys.contains_key(&key) || self.agents.contains_key(&key) {
            fail(E108);
        }
        self.owner_keys.insert(key, valid_until_ns.0);
    }

    pub fn remove_agent(&mut self, account_id: String) {
        self.assert_owner();
        let key = hex32(&account_id);
        self.owner_keys.remove(&key);
        self.agents.remove(&key);
    }

    /// `account_id` is the signer hex (a Shade agent's implicit account id).
    pub fn get_agent(&self, account_id: String) -> Option<AgentView> {
        let key = hex32(&account_id);
        if let Some(until) = self.owner_keys.get(&key) {
            return Some(AgentView { kind: "owner", measurement_id: None, valid_until_ns: U64(*until) });
        }
        self.agents.get(&key).map(|a| AgentView {
            kind: "attested",
            measurement_id: Some(to_hex(&a.measurement_id)),
            valid_until_ns: U64(a.valid_until_ns),
        })
    }

    // ---- sender pre-pay (ft_on_transfer cannot carry NEAR) ----

    #[payable]
    pub fn prepay_deposit(&mut self, account_id: Option<AccountId>) -> U128 {
        let account = account_id.unwrap_or_else(env::predecessor_account_id);
        let mut deposit = env::attached_deposit().as_yoctonear();
        if !self.prepay.contains_key(&account) {
            // A new entry pays for its own bytes first.
            let before = env::storage_usage();
            self.prepay.insert(account.clone(), 0);
            self.prepay.flush();
            let cost = storage_cost(env::storage_usage().saturating_sub(before));
            deposit = deposit.checked_sub(cost).unwrap_or_else(|| fail(E128));
        }
        let balance = self.prepay.get(&account).copied().unwrap_or(0) + deposit;
        self.prepay.insert(account, balance);
        U128(balance)
    }

    pub fn prepay_balance_of(&self, account_id: AccountId) -> U128 {
        U128(self.prepay.get(&account_id).copied().unwrap_or(0))
    }

    /// Sends the caller's free pre-pay (all of it by default) back to the caller.
    pub fn prepay_withdraw(&mut self, amount: Option<U128>) -> Promise {
        let account = env::predecessor_account_id();
        let free = self.prepay.get(&account).copied().unwrap_or(0);
        let amount = amount.map_or(free, |a| a.0);
        if amount == 0 {
            fail(E109);
        }
        if amount > free {
            fail(E128);
        }
        self.prepay.insert(account.clone(), free - amount);
        Promise::new(account).transfer(NearToken::from_yoctonear(amount))
    }

    /// Anyone may top up a campaign's reservation (e.g. `leaf_count` was understated).
    #[payable]
    pub fn fund_campaign_storage(&mut self, campaign_id: U64) -> U128 {
        let deposit = env::attached_deposit().as_yoctonear();
        let c = self.campaigns.get_mut(&campaign_id.0).unwrap_or_else(|| fail(E110));
        // After the deadline no claim can draw on it; refuse rather than strand NEAR.
        if env::block_timestamp() > c.deadline_ns {
            fail(E125);
        }
        if deposit == 0 {
            fail(E109);
        }
        c.storage_reserved += deposit;
        U128(c.storage_reserved)
    }

    pub fn storage_costs(&self, token_id: AccountId) -> StorageCosts {
        let ft = self.ft_storage_deposit.get(&token_id).copied().unwrap_or_else(|| fail(E126));
        let entry = storage_cost(self.claim_entry_bytes);
        StorageCosts {
            ft_storage_deposit: U128(ft),
            claim_entry_cost: U128(entry),
            per_claim_storage: U128(ft + entry),
            campaign_bytes_cost: U128(storage_cost(
                self.campaign_base_bytes + 32 * self.owner_keys.len() as u64,
            )),
        }
    }

    pub fn campaign_by_root(&self, merkle_root: String) -> Option<U64> {
        self.roots.get(&hex32(&merkle_root)).map(|id| U64(*id))
    }

    pub fn get_config(&self) -> ConfigView {
        ConfigView {
            network: self.network.clone(),
            min_lifetime_ns: U64(self.min_lifetime_ns),
            agent_ttl_ns: U64(self.agent_ttl_ns),
            token_ids: self.token_ids.clone(),
            storage_byte_cost: U128(env::storage_byte_cost().as_yoctonear()),
        }
    }

    // ---- campaign creation ----

    /// NEP-141 receiver. Every error panics, so the token refunds the whole amount.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        let token = env::predecessor_account_id();
        // A token whose storage bounds were never read cannot pay claims yet.
        if !self.token_ids.contains(&token) || !self.ft_storage_deposit.contains_key(&token) {
            fail(E126);
        }
        if amount.0 == 0 {
            fail(E109);
        }
        let msg: CreateMsg = serde_json::from_str(&msg).unwrap_or_else(|_| fail(E108));
        let merkle_root = hex32(&msg.merkle_root);
        if msg.leaf_count == 0 {
            fail(E108);
        }
        // A resent draft can never fund a second campaign.
        if self.roots.contains_key(&merkle_root) {
            fail(E132);
        }
        let now = env::block_timestamp();
        if msg.deadline_ns.0 < now.saturating_add(self.min_lifetime_ns) {
            fail(E119);
        }
        let snapshot = self.policy_snapshot(msg.policy, msg.deadline_ns.0);
        if snapshot.is_empty() {
            fail(E127);
        }

        let campaign_id = self.next_campaign_id;
        self.next_campaign_id += 1;
        let reserve = msg.leaf_count as u128 * self.per_claim_storage(&token);
        let before = env::storage_usage();
        self.campaigns.insert(
            campaign_id,
            Campaign {
                sender: sender_id.clone(),
                token: token.clone(),
                amount: amount.0,
                merkle_root,
                deadline_ns: msg.deadline_ns.0,
                balance: amount.0,
                in_flight: 0,
                policy: msg.policy,
                snapshot,
                storage_reserved: reserve,
            },
        );
        self.roots.insert(merkle_root, campaign_id);
        self.campaigns.flush();
        self.roots.flush();
        // Campaign bytes are spent; the per-claim part is reserved for this campaign only.
        let bytes_cost = storage_cost(env::storage_usage().saturating_sub(before));
        self.debit_prepay(&sender_id, bytes_cost + reserve);

        emit(
            "campaign_created",
            json!({
                "campaign_id": U64(campaign_id),
                "sender": sender_id,
                "token": token,
                "amount": amount,
                "merkle_root": msg.merkle_root,
                "deadline_ns": msg.deadline_ns,
                "policy": msg.policy,
            }),
        );
        PromiseOrValue::Value(U128(0))
    }

    // ---- claim ----

    /// Called by the relayer. All checks run before any state changes.
    #[allow(clippy::too_many_arguments)]
    pub fn claim(
        &mut self,
        campaign_id: U64,
        commitment: String,
        amount: U128,
        proof: Vec<String>,
        destination: String,
        expires_at_ns: U64,
        signer: String,
        signature: String,
    ) -> Promise {
        let ok = self.check_claim(&ClaimArgs {
            campaign_id,
            commitment: commitment.clone(),
            amount,
            proof,
            destination,
            expires_at_ns,
            signer,
            signature,
        });
        let token = self.campaigns.get(&ok.campaign_id).unwrap_or_else(|| fail(E110)).token.clone();
        // check_claim proved the token's bounds exist and the reservation covers this (E128).
        let ft_storage = self.ft_storage_deposit.get(&token).copied().unwrap_or_else(|| fail(E128));
        let per_claim = self.per_claim_storage(&token);
        let c = self.campaigns.get_mut(&ok.campaign_id).unwrap_or_else(|| fail(E110));
        c.balance -= ok.amount;
        c.in_flight += ok.amount;
        c.storage_reserved -= per_claim;
        let started_ns = env::block_timestamp();
        self.claims.insert(
            (ok.campaign_id, ok.commitment),
            ClaimStatus::Pending { amount: ok.amount, started_ns },
        );

        emit(
            "claim_started",
            json!({
                "campaign_id": campaign_id,
                "commitment": commitment,
                "amount": amount,
                "destination": ok.destination,
                "signer": to_hex(&ok.signer),
            }),
        );
        let register = json!({ "account_id": ok.destination, "registration_only": true });
        Promise::new(token.clone())
            .function_call(
                "storage_deposit".to_string(),
                serde_json::to_vec(&register).unwrap_or_else(|_| fail(E108)),
                NearToken::from_yoctonear(ft_storage),
                GAS_STORAGE_DEPOSIT,
            )
            // A `.then` runs even if storage_deposit failed: for an unregistered destination
            // ft_transfer then fails too; for a registered one it is a correct payout.
            .then(ft_transfer(token, ok.destination.clone(), ok.amount))
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_claim(campaign_id, commitment, amount, ok.destination, U64(started_ns)),
            )
    }

    /// Private callback. Decides from the ft_transfer result only, and cannot panic
    /// once the caller check passes; a stranded claim is what `resolve_pending` is for.
    pub fn on_claim(
        &mut self,
        campaign_id: U64,
        commitment: String,
        amount: U128,
        destination: AccountId,
        started_ns: U64,
    ) {
        if env::predecessor_account_id() != env::current_account_id() {
            fail(E107);
        }
        #[cfg(feature = "test-callback-panic")]
        env::panic_str("TEST_CALLBACK_PANIC");
        let paid = transfer_succeeded();
        let key = (campaign_id.0, hex32(&commitment));
        // Attempt identity: settle only the attempt this callback belongs to. If
        // resolve_pending settled it and a newer attempt started, do nothing.
        if !matches!(self.claims.get(&key),
                     Some(ClaimStatus::Pending { started_ns: s, .. }) if *s == started_ns.0)
        {
            return;
        }
        self.settle(key, amount.0, paid);
        if paid {
            emit(
                "claim_paid",
                json!({ "campaign_id": campaign_id, "commitment": commitment,
                        "amount": amount, "destination": destination }),
            );
        } else {
            emit(
                "claim_reverted",
                json!({ "campaign_id": campaign_id, "commitment": commitment,
                        "amount": amount, "destination": destination, "code": E115 }),
            );
        }
    }

    /// Owner exit for a claim whose callback never completed. `evidence` is the
    /// ft_transfer receipt id the owner read the outcome from.
    pub fn resolve_pending(
        &mut self,
        campaign_id: U64,
        commitment: String,
        paid: bool,
        evidence: String,
    ) {
        self.assert_owner();
        if !self.campaigns.contains_key(&campaign_id.0) {
            fail(E110);
        }
        let key = (campaign_id.0, hex32(&commitment));
        let (amount, started_ns) = match self.claims.get(&key) {
            Some(ClaimStatus::Pending { amount, started_ns }) => (*amount, *started_ns),
            _ => fail(E108),
        };
        if env::block_timestamp() < started_ns.saturating_add(PENDING_TIMEOUT_NS) {
            fail(E107);
        }
        self.settle(key, amount, paid);
        emit(
            "pending_resolved",
            json!({ "campaign_id": campaign_id, "commitment": commitment,
                    "amount": U128(amount), "paid": paid, "evidence": evidence }),
        );
    }

    // ---- reclaim ----

    /// Returns the token balance and releases the unused storage reservation to the
    /// sender's free pre-pay. In-flight claims are a separate bucket and stay put.
    pub fn reclaim(&mut self, campaign_id: U64) -> PromiseOrValue<()> {
        let mut c = self.campaigns.get(&campaign_id.0).cloned().unwrap_or_else(|| fail(E110));
        if env::predecessor_account_id() != c.sender {
            fail(E107);
        }
        if env::block_timestamp() <= c.deadline_ns {
            fail(E117);
        }
        let available = c.balance;
        // A fully claimed campaign can still hold a reservation; release it, don't E118.
        if available == 0 && c.storage_reserved == 0 {
            fail(E118);
        }
        let released = c.storage_reserved;
        c.balance = 0;
        c.storage_reserved = 0;
        let (token, sender) = (c.token.clone(), c.sender.clone());
        self.campaigns.insert(campaign_id.0, c);
        if released > 0 {
            let free = self.prepay.get(&sender).copied().unwrap_or(0);
            self.prepay.insert(sender.clone(), free + released);
        }
        if available == 0 {
            return PromiseOrValue::Value(());
        }
        ft_transfer(token, sender, available)
            .then(
                Self::ext(env::current_account_id())
                    .with_static_gas(GAS_CALLBACK)
                    .on_reclaim(campaign_id, U128(available)),
            )
            .into()
    }

    /// Private callback; checked by hand so the panic carries E107.
    pub fn on_reclaim(&mut self, campaign_id: U64, amount: U128) {
        if env::predecessor_account_id() != env::current_account_id() {
            fail(E107);
        }
        if transfer_succeeded() {
            emit("reclaimed", json!({ "campaign_id": campaign_id, "amount": amount }));
        } else {
            let c = self.campaigns.get_mut(&campaign_id.0).unwrap_or_else(|| fail(E110));
            c.balance += amount.0;
            emit(
                "reclaim_reverted",
                json!({ "campaign_id": campaign_id, "amount": amount, "code": E115 }),
            );
        }
    }

    // ---- views ----

    pub fn required_claim_gas(&self) -> U64 {
        U64(required_claim_gas().as_gas())
    }

    pub fn get_network(&self) -> String {
        self.network.clone()
    }

    pub fn get_campaign(&self, campaign_id: U64) -> Option<CampaignView> {
        self.campaigns.get(&campaign_id.0).map(|c| CampaignView {
            sender: c.sender.clone(),
            token: c.token.clone(),
            amount: U128(c.amount),
            merkle_root: to_hex(&c.merkle_root),
            deadline_ns: U64(c.deadline_ns),
            balance: U128(c.balance),
            in_flight: U128(c.in_flight),
            policy: c.policy,
            snapshot: c.snapshot.iter().map(|k| to_hex(k)).collect(),
            storage_reserved: U128(c.storage_reserved),
        })
    }

    pub fn claim_state(&self, campaign_id: U64, commitment: String) -> &'static str {
        match self.claims.get(&(campaign_id.0, hex32(&commitment))) {
            None => "unclaimed",
            Some(ClaimStatus::Pending { .. }) => "pending",
            Some(ClaimStatus::Claimed) => "claimed",
        }
    }
}

impl Contract {
    fn assert_owner(&self) {
        if env::predecessor_account_id() != self.owner_id {
            fail(E107);
        }
    }

    fn policy_snapshot(&self, policy: Policy, deadline_ns: u64) -> Vec<[u8; 32]> {
        match policy {
            Policy::Owner => self
                .owner_keys
                .iter()
                .filter(|(_, until)| **until >= deadline_ns)
                .map(|(k, _)| *k)
                .collect(),
            // shortcut: no approved measurements exist until T11 adds approve_measurements,
            // so an attested campaign is refused with E127 until then.
            Policy::Attested => Vec::new(),
        }
    }

    /// Ends a pending claim: paid -> claimed; not paid -> unclaimed with funds back in
    /// balance and the removed entry's bytes back in the reservation. The
    /// ft_storage_deposit part is never credited back (spec).
    fn settle(&mut self, key: (u64, [u8; 32]), amount: u128, paid: bool) {
        let entry_cost = storage_cost(self.claim_entry_bytes);
        if let Some(c) = self.campaigns.get_mut(&key.0) {
            c.in_flight = c.in_flight.saturating_sub(amount);
            if !paid {
                c.balance += amount;
                c.storage_reserved += entry_cost;
            }
        }
        if paid {
            self.claims.insert(key, ClaimStatus::Claimed);
        } else {
            self.claims.remove(&key);
        }
    }

    fn debit_prepay(&mut self, account: &AccountId, cost: u128) {
        let free = self.prepay.get(account).copied().unwrap_or(0);
        let left = free.checked_sub(cost).unwrap_or_else(|| fail(E128));
        self.prepay.insert(account.clone(), left);
    }

    /// ft_storage_deposit + one claim entry's bytes. Callers have checked the token.
    fn per_claim_storage(&self, token: &AccountId) -> u128 {
        let ft = self.ft_storage_deposit.get(token).copied().unwrap_or_else(|| fail(E126));
        ft + storage_cost(self.claim_entry_bytes)
    }

    /// The synchronous half of `claim`, in the spec's fixed order (1-11).
    pub fn check_claim(&self, a: &ClaimArgs) -> CheckedClaim {
        // 1
        let c = self.campaigns.get(&a.campaign_id.0).unwrap_or_else(|| fail(E110));
        // 2
        let now = env::block_timestamp();
        let commitment = hex32(&a.commitment);
        if a.proof.len() > MAX_PROOF_LEN {
            fail(E108);
        }
        let proof: Vec<[u8; 32]> = a.proof.iter().map(|p| hex32(p)).collect();
        let destination: AccountId = a.destination.parse().unwrap_or_else(|_| fail(E108));
        let signer = hex32(&a.signer);
        let signature: [u8; 64] =
            hex_decode(&a.signature).try_into().unwrap_or_else(|_| fail(E108));
        if a.expires_at_ns.0 > now.saturating_add(MAX_SIGNATURE_TTL_NS) {
            fail(E108);
        }
        // 3
        if a.amount.0 == 0 {
            fail(E109);
        }
        // 4
        if now > c.deadline_ns {
            fail(E125);
        }
        // 5
        if a.expires_at_ns.0 < now {
            fail(E114);
        }
        // 6
        match self.claims.get(&(a.campaign_id.0, commitment)) {
            Some(ClaimStatus::Claimed) => fail(E105),
            Some(ClaimStatus::Pending { .. }) => fail(E123),
            None => {}
        }
        // 7
        if !verify_proof(leaf_hash(&commitment, a.amount.0), &proof, &c.merkle_root) {
            fail(E102);
        }
        // 8: policy, then ed25519 over the payload rebuilt from our own context.
        let allowed = match c.policy {
            Policy::Owner => self
                .owner_keys
                .get(&signer)
                .is_some_and(|until| *until >= now && c.snapshot.contains(&signer)),
            Policy::Attested => self.agents.get(&signer).is_some_and(|a| {
                a.valid_until_ns >= now && c.snapshot.contains(&a.measurement_id)
            }),
        };
        if !allowed {
            fail(E101);
        }
        let msg = payload(
            &self.network,
            env::current_account_id().as_str(),
            a.campaign_id.0,
            &commitment,
            a.amount.0,
            destination.as_str(),
            a.expires_at_ns.0,
        );
        if !env::ed25519_verify(&signature, &msg, &signer) {
            fail(E101);
        }
        // 9
        if c.balance < a.amount.0 {
            fail(E129);
        }
        // 10
        if c.storage_reserved < self.per_claim_storage(&c.token) {
            fail(E128);
        }
        // 11
        if env::prepaid_gas().as_gas() < required_claim_gas().as_gas() {
            fail(E130);
        }
        CheckedClaim {
            campaign_id: a.campaign_id.0,
            commitment,
            amount: a.amount.0,
            destination,
            signer,
        }
    }
}

// ---- spec bytes ----

pub fn leaf_hash(commitment: &[u8; 32], amount: u128) -> [u8; 32] {
    let mut b = Vec::with_capacity(49);
    b.push(0x00);
    b.extend_from_slice(commitment);
    b.extend_from_slice(&amount.to_le_bytes());
    env::sha256_array(&b)
}

pub fn node_hash(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    let mut v = Vec::with_capacity(65);
    v.push(0x01);
    v.extend_from_slice(lo);
    v.extend_from_slice(hi);
    env::sha256_array(&v)
}

pub fn verify_proof(leaf: [u8; 32], proof: &[[u8; 32]], root: &[u8; 32]) -> bool {
    proof.iter().fold(leaf, |h, s| node_hash(&h, s)) == *root
}

pub fn payload(
    network: &str,
    contract_id: &str,
    campaign_id: u64,
    commitment: &[u8; 32],
    amount: u128,
    destination: &str,
    expires_at_ns: u64,
) -> Vec<u8> {
    let mut b = DOMAIN_TAG.to_vec();
    for s in [network, contract_id] {
        push_str(&mut b, s);
    }
    b.extend_from_slice(&campaign_id.to_le_bytes());
    b.extend_from_slice(commitment);
    b.extend_from_slice(&amount.to_le_bytes());
    push_str(&mut b, destination);
    b.extend_from_slice(&expires_at_ns.to_le_bytes());
    b
}

fn push_str(b: &mut Vec<u8>, s: &str) {
    // Account ids are <= 64 bytes and network is fixed, so the u8 prefix cannot overflow.
    b.push(u8::try_from(s.len()).unwrap_or_else(|_| fail(E108)));
    b.extend_from_slice(s.as_bytes());
}

// ---- helpers ----

/// Gas a relayer attaches to `claim`: storage_deposit + ft_transfer + callback + own work.
pub fn required_claim_gas() -> Gas {
    Gas::from_gas(
        GAS_STORAGE_DEPOSIT.as_gas()
            + GAS_FT_TRANSFER.as_gas()
            + GAS_CALLBACK.as_gas()
            + GAS_CLAIM_MARGIN.as_gas(),
    )
}

/// The callback's only question. The host still copies the result into a register
/// (charged per byte); we only skip reading it back, and an oversized result still
/// means the transfer succeeded.
fn transfer_succeeded() -> bool {
    !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed))
}

fn storage_cost(bytes: u64) -> u128 {
    bytes as u128 * env::storage_byte_cost().as_yoctonear()
}

fn ft_transfer(token: AccountId, receiver: AccountId, amount: u128) -> Promise {
    let args = json!({ "receiver_id": receiver, "amount": U128(amount) });
    Promise::new(token).function_call(
        "ft_transfer".to_string(),
        serde_json::to_vec(&args).unwrap_or_else(|_| fail(E108)),
        NearToken::from_yoctonear(1),
        GAS_FT_TRANSFER,
    )
}

fn emit(event: &str, data: serde_json::Value) {
    let e = json!({ "standard": "zarf-near", "version": "1.0.0", "event": event, "data": [data] });
    env::log_str(&format!("EVENT_JSON:{e}"));
}

/// Lowercase hex only (spec: "lowercase hex, no 0x").
fn hex_decode(s: &str) -> Vec<u8> {
    fn nib(c: u8) -> u8 {
        match c {
            b'0'..=b'9' => c - b'0',
            b'a'..=b'f' => c - b'a' + 10,
            _ => fail(E108),
        }
    }
    if s.len() % 2 != 0 {
        fail(E108);
    }
    s.as_bytes().chunks(2).map(|p| (nib(p[0]) << 4) | nib(p[1])).collect()
}

fn hex32(s: &str) -> [u8; 32] {
    hex_decode(s).try_into().unwrap_or_else(|_| fail(E108))
}

fn to_hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

#[cfg(test)]
mod tests;
