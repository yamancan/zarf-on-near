//! Unit tests. Spec vectors: `spec/vectors.json` (shared with the TS layers).
#![allow(unused_must_use)] // tests drop the returned promises on purpose

use super::*;
use near_sdk::serde_json::Value;
use near_sdk::test_utils::{get_logs, VMContextBuilder};
use near_sdk::{testing_env, PromiseResult, RuntimeFeesConfig};
use std::panic::{catch_unwind, AssertUnwindSafe};

const VECTORS: &str = include_str!("../../spec/vectors.json");
const USDC_MIN: u128 = 1_250_000_000_000_000_000_000; // 0.00125 NEAR, read on chain in S1
const DAY_NS: u64 = 86_400 * 1_000_000_000;

fn v() -> Value {
    serde_json::from_str(VECTORS).unwrap()
}
fn n(x: &Value) -> u64 {
    x.as_str().unwrap().parse().unwrap()
}
fn acc(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn owner() -> AccountId {
    acc("owner.testnet")
}
fn usdc() -> AccountId {
    acc("usdc.testnet")
}
fn sender() -> AccountId {
    acc("sender.testnet")
}
fn me() -> AccountId {
    acc("zarf-near.testnet")
}
fn init(network: &str) -> Contract {
    at(me(), now());
    Contract::new(
        owner(),
        network.into(),
        vec![usdc()],
        U64(n(&v()["context"]["min_lifetime_ns"])),
        U64(7 * DAY_NS),
        U64(MIN_RESOLVE_DELAY_NS),
    )
}

fn set_ctx(predecessor: AccountId, now: u64, deposit: u128, gas_tgas: u64) {
    let ctx = VMContextBuilder::new()
        .current_account_id(acc("zarf-near.testnet"))
        .predecessor_account_id(predecessor.clone())
        .signer_account_id(predecessor)
        .block_timestamp(now)
        .attached_deposit(NearToken::from_yoctonear(deposit))
        .prepaid_gas(Gas::from_tgas(gas_tgas))
        .build();
    testing_env!(ctx);
}
fn at(predecessor: AccountId, now: u64) {
    set_ctx(predecessor, now, 0, 300);
}
fn with_result(predecessor: AccountId, now: u64, result: PromiseResult) {
    let ctx = VMContextBuilder::new()
        .current_account_id(acc("zarf-near.testnet"))
        .predecessor_account_id(predecessor)
        .block_timestamp(now)
        .build();
    testing_env!(
        ctx,
        near_sdk::test_vm_config(),
        RuntimeFeesConfig::test(),
        Default::default(),
        vec![result]
    );
}

/// Runs `f`, which must panic, and returns the panic message.
fn err(f: impl FnOnce()) -> String {
    let e = catch_unwind(AssertUnwindSafe(f)).expect_err("expected a panic");
    e.downcast_ref::<String>()
        .cloned()
        .or_else(|| e.downcast_ref::<&str>().map(|s| s.to_string()))
        .unwrap()
}
fn assert_err(code: &str, f: impl FnOnce()) {
    let m = err(f);
    assert!(m.contains(code), "expected {code}, got {m}");
}

fn now() -> u64 {
    n(&v()["context"]["now_ns"])
}
fn deadline() -> u64 {
    n(&v()["context"]["deadline_ns"])
}

fn create_msg(root: &str, deadline_ns: u64, policy: &str) -> String {
    json!({ "merkle_root": root, "deadline_ns": U64(deadline_ns), "policy": policy, "leaf_count": 5 })
        .to_string()
}

/// Contract with the vector signer registered, USDC bounds read, sender pre-paid.
fn base() -> Contract {
    base_on("testnet")
}
fn base_on(network: &str) -> Contract {
    let mut c = init(network);
    c.ft_storage_deposit.insert(usdc(), USDC_MIN);
    at(owner(), now());
    let vs = v();
    let signer = vs["keys"]["signer"].as_str().unwrap();
    if network == "mainnet" {
        // add_owner_key refuses the public test keys on mainnet; plant it to test E101.
        c.owner_keys.insert(hex32(signer), deadline() + DAY_NS);
    } else {
        c.add_owner_key(signer.into(), U64(deadline() + DAY_NS));
    }
    set_ctx(sender(), now(), 10u128.pow(24), 300);
    c.prepay_deposit(None);
    c
}
fn per_claim(c: &Contract) -> u128 {
    c.storage_costs(usdc()).per_claim_storage.0
}

/// `base()` plus the vector campaigns at ids 7 (main) and 8 (single).
fn seeded() -> Contract {
    seeded_on("testnet")
}
fn seeded_on(network: &str) -> Contract {
    let mut c = base_on(network);
    let vs = v();
    for name in ["main", "single"] {
        let camp = &vs["campaigns"][name];
        c.next_campaign_id = n_u(&camp["campaign_id"]);
        at(usdc(), now());
        c.ft_on_transfer(
            sender(),
            U128(10u128.pow(13)),
            create_msg(camp["merkle_root"].as_str().unwrap(), deadline(), "owner"),
        );
    }
    at(acc("relayer.testnet"), now());
    c
}
fn n_u(x: &Value) -> u64 {
    match x {
        Value::String(s) => s.parse().unwrap(),
        _ => x.as_u64().unwrap(),
    }
}

fn args(claim: &Value) -> ClaimArgs {
    serde_json::from_value(claim["call_args"].clone()).unwrap()
}
fn valid(i: usize) -> ClaimArgs {
    args(&v()["claims"]["valid"][i])
}

// ---- vectors ----

#[test]
fn vectors_are_loaded_and_non_empty() {
    let vs = v();
    assert!(vs["spec"].as_str().unwrap().contains("v2"));
    assert!(!vs["claims"]["valid"].as_array().unwrap().is_empty());
    assert!(!vs["claims"]["invalid"].as_array().unwrap().is_empty());
    assert!(!vs["campaigns"]["main"]["recipients"].as_array().unwrap().is_empty());
}

#[test]
fn leaves_match_vectors() {
    at(owner(), now());
    let vs = v();
    let mut count = 0;
    for name in ["main", "single"] {
        for r in vs["campaigns"][name]["recipients"].as_array().unwrap() {
            let leaf = leaf_hash(&hex32(r["commitment"].as_str().unwrap()), n_u128(&r["amount"]));
            assert_eq!(to_hex(&leaf), r["leaf"].as_str().unwrap());
            count += 1;
        }
    }
    assert!(count > 0);
}
fn n_u128(x: &Value) -> u128 {
    x.as_str().unwrap().parse().unwrap()
}

#[test]
fn valid_proofs_reach_roots_including_empty_proof() {
    at(owner(), now());
    let vs = v();
    let mut saw_empty = false;
    for c in vs["claims"]["valid"].as_array().unwrap() {
        let a = args(c);
        let root = hex32(vs["campaigns"][c["campaign"].as_str().unwrap()]["merkle_root"].as_str().unwrap());
        let proof: Vec<[u8; 32]> = a.proof.iter().map(|p| hex32(p)).collect();
        saw_empty |= proof.is_empty();
        assert!(verify_proof(leaf_hash(&hex32(&a.commitment), a.amount.0), &proof, &root), "{}", c["name"]);
    }
    assert!(saw_empty, "spec v2 has a single-leaf vector with an empty proof");
}

#[test]
fn payload_rebuilt_from_args_matches_vectors() {
    at(owner(), now());
    let vs = v();
    let ctx = &vs["context"];
    for c in vs["claims"]["valid"].as_array().unwrap() {
        let a = args(c);
        let p = payload(
            ctx["network"].as_str().unwrap(),
            ctx["contract_id"].as_str().unwrap(),
            a.campaign_id.0,
            &hex32(&a.commitment),
            a.amount.0,
            &a.destination,
            a.expires_at_ns.0,
        );
        assert_eq!(to_hex(&p), c["payload"].as_str().unwrap(), "{}", c["name"]);
    }
}

#[test]
fn every_valid_vector_passes_check_claim() {
    let c = seeded();
    let vs = v();
    let all = vs["claims"]["valid"].as_array().unwrap();
    assert!(!all.is_empty());
    for vec in all {
        let a = args(vec);
        let ok = c.check_claim(&a);
        assert_eq!(ok.amount, a.amount.0, "{}", vec["name"]);
        assert_eq!(ok.destination.as_str(), a.destination);
    }
}

#[test]
fn every_invalid_vector_fails_with_its_code() {
    let c = seeded();
    let vs = v();
    let all = vs["claims"]["invalid"].as_array().unwrap();
    assert!(!all.is_empty());
    for vec in all {
        let code = vec["expect"].as_str().unwrap();
        let m = err(|| {
            c.check_claim(&args(vec));
        });
        assert!(m.contains(code), "{}: expected {code}, got {m}", vec["name"]);
    }
}

// ---- claim check order and boundaries ----

#[test]
fn unknown_campaign_is_e110_before_bad_input() {
    let c = seeded();
    let mut a = valid(0);
    a.campaign_id = U64(99);
    a.commitment = "NOT HEX".into();
    assert_err(E110, || {
        c.check_claim(&a);
    });
}

#[test]
fn malformed_inputs_are_e108() {
    let c = seeded();
    let cases: Vec<Box<dyn Fn(&mut ClaimArgs)>> = vec![
        Box::new(|a| a.commitment = a.commitment.to_uppercase()),
        Box::new(|a| a.commitment.truncate(62)),
        Box::new(|a| a.proof = vec![a.commitment.clone(); MAX_PROOF_LEN + 1]),
        Box::new(|a| a.destination = "Bad Account!".into()),
        Box::new(|a| a.signer.truncate(62)),
        Box::new(|a| a.signature.truncate(126)),
        Box::new(|a| a.expires_at_ns = U64(now() + MAX_SIGNATURE_TTL_NS + 1)),
    ];
    for f in cases {
        let mut a = valid(0);
        f(&mut a);
        assert_err(E108, || {
            c.check_claim(&a);
        });
    }
}

#[test]
fn zero_amount_is_e109() {
    let c = seeded();
    let mut a = valid(0);
    a.amount = U128(0);
    assert_err(E109, || {
        c.check_claim(&a);
    });
}

#[test]
fn claim_window_is_inclusive_of_deadline() {
    let c = seeded();
    // At now == deadline the window is still open: the next check (expiry) fires instead.
    at(acc("relayer.testnet"), deadline());
    assert_err(E114, || {
        c.check_claim(&valid(0));
    });
    at(acc("relayer.testnet"), deadline() + 1);
    assert_err(E125, || {
        c.check_claim(&valid(0));
    });
}

#[test]
fn expired_signature_is_e114() {
    let c = seeded();
    at(acc("relayer.testnet"), valid(0).expires_at_ns.0 + 1);
    assert_err(E114, || {
        c.check_claim(&valid(0));
    });
}

#[test]
fn claimed_and_pending_are_refused() {
    let mut c = seeded();
    let a = valid(0);
    let key = (a.campaign_id.0, hex32(&a.commitment));
    c.claims.insert(key, ClaimStatus::Claimed);
    assert_err(E105, || {
        c.check_claim(&a);
    });
    c.claims.insert(key, ClaimStatus::Pending { amount: a.amount.0, started_ns: now() });
    assert_err(E123, || {
        c.check_claim(&a);
    });
    assert_eq!(c.claim_state(a.campaign_id, a.commitment.clone()), "pending");
}

#[test]
fn removed_or_expired_signer_is_e101() {
    let mut c = seeded();
    let a = valid(0);
    at(acc("relayer.testnet"), now());
    *c.owner_keys.get_mut(&hex32(&a.signer)).unwrap() = now() - 1;
    assert_err(E101, || {
        c.check_claim(&a);
    });
    at(owner(), now());
    c.remove_agent(a.signer.clone());
    assert_err(E101, || {
        c.check_claim(&a);
    });
}

#[test]
fn signer_added_after_creation_is_not_in_snapshot() {
    let mut c = seeded();
    let signer = v()["keys"]["signer"].as_str().unwrap().to_string();
    let rogue = v()["keys"]["rogue_signer"].as_str().unwrap().to_string();
    at(owner(), now());
    c.add_owner_key(rogue.clone(), U64(deadline() + DAY_NS));
    assert_eq!(c.get_campaign(U64(7)).unwrap().snapshot, vec![signer.clone()]);
    at(usdc(), now());
    c.ft_on_transfer(sender(), U128(1), create_msg(&other_root(1), deadline(), "owner"));
    let mut fresh = c.get_campaign(U64(9)).unwrap().snapshot;
    fresh.sort();
    let mut both = vec![signer, rogue];
    both.sort();
    assert_eq!(fresh, both);
    // M2: the rogue key is registered and valid, but campaign 7's snapshot predates it.
    let rogue_vec = v()["claims"]["invalid"]
        .as_array()
        .unwrap()
        .iter()
        .find(|x| x["name"] == "signer-not-registered")
        .unwrap()
        .clone();
    at(acc("relayer.testnet"), now());
    assert_err(E101, || {
        c.check_claim(&args(&rogue_vec));
    });
}

#[test]
fn underfunded_campaign_is_e129() {
    let mut c = seeded();
    let a = valid(0);
    c.campaigns.get_mut(&a.campaign_id.0).unwrap().balance = a.amount.0 - 1;
    assert_err(E129, || {
        c.check_claim(&a);
    });
}

#[test]
fn campaign_reservation_too_low_is_e128() {
    let mut c = seeded();
    let need = per_claim(&c);
    c.campaigns.get_mut(&7).unwrap().storage_reserved = need - 1;
    assert_err(E128, || {
        c.check_claim(&valid(0));
    });
    // Another campaign's reservation is never used.
    assert!(c.campaigns.get(&8).unwrap().storage_reserved >= need);
}

#[test]
fn low_gas_is_e130_and_view_reports_requirement() {
    let c = seeded();
    let need = c.required_claim_gas().0;
    assert_eq!(need, claim_gas_needed().as_gas());
    assert!(need >= (GAS_STORAGE_DEPOSIT.as_gas() + GAS_FT_TRANSFER.as_gas() + GAS_CALLBACK.as_gas()));
    set_ctx(acc("relayer.testnet"), now(), 0, need / 1_000_000_000_000 - 1);
    assert_err(E130, || {
        c.check_claim(&valid(0));
    });
}

// ---- ft_on_transfer ----

fn root() -> String {
    v()["campaigns"]["main"]["merkle_root"].as_str().unwrap().into()
}
/// A root no vector uses (roots are idempotency keys, E132).
fn other_root(i: u8) -> String {
    to_hex(&[i; 32])
}

#[test]
fn create_assigns_counter_ids_snapshots_and_emits() {
    let mut c = base();
    let before = c.prepay_balance_of(sender()).0;
    at(usdc(), now());
    let r = c.ft_on_transfer(sender(), U128(500), create_msg(&root(), deadline(), "owner"));
    assert!(matches!(r, PromiseOrValue::Value(U128(0))));
    assert!(get_logs()[0].starts_with("EVENT_JSON:{"));
    assert!(get_logs()[0].contains("\"event\":\"campaign_created\""));
    c.ft_on_transfer(sender(), U128(1), create_msg(&other_root(1), deadline(), "owner"));
    assert!(c.get_campaign(U64(2)).is_none());

    let view = serde_json::to_value(c.get_campaign(U64(0)).unwrap()).unwrap();
    assert_eq!(view["sender"], "sender.testnet");
    assert_eq!(view["token"], "usdc.testnet");
    assert_eq!(view["amount"], "500");
    assert_eq!(view["balance"], "500");
    assert_eq!(view["in_flight"], "0");
    assert_eq!(view["merkle_root"], root());
    assert_eq!(view["deadline_ns"], deadline().to_string());
    assert_eq!(view["policy"], "owner");
    assert_eq!(view["snapshot"], json!([v()["keys"]["signer"]]));
    let reserved = 5 * per_claim(&c);
    assert_eq!(view["storage_reserved"], reserved.to_string());
    // Two campaigns: each reserved 5 claims and paid its own bytes.
    assert!(c.prepay_balance_of(sender()).0 < before - 2 * reserved);
}

#[test]
fn create_reserves_or_refuses_e128_and_rejects_zero_leaves() {
    let mut c = base();
    let need = 5 * per_claim(&c);
    c.prepay.insert(sender(), need - 1);
    at(usdc(), now());
    assert_err(E128, || {
        c.ft_on_transfer(sender(), U128(1), create_msg(&root(), deadline(), "owner"));
    });
    let zero = json!({ "merkle_root": root(), "deadline_ns": U64(deadline()), "policy": "owner", "leaf_count": 0 });
    assert_err(E108, || {
        c.ft_on_transfer(sender(), U128(1), zero.to_string());
    });
}

#[test]
fn create_refuses_unknown_token_and_token_without_bounds() {
    let mut c = base();
    at(acc("evil.testnet"), now());
    assert_err(E126, || {
        c.ft_on_transfer(sender(), U128(1), create_msg(&root(), deadline(), "owner"));
    });
    c.ft_storage_deposit.remove(&usdc());
    at(usdc(), now());
    assert_err(E126, || {
        c.ft_on_transfer(sender(), U128(1), create_msg(&root(), deadline(), "owner"));
    });
}

#[test]
fn create_refuses_zero_amount_and_bad_msg() {
    let mut c = base();
    at(usdc(), now());
    assert_err(E109, || {
        c.ft_on_transfer(sender(), U128(0), create_msg(&root(), deadline(), "owner"));
    });
    for msg in [
        "not json".to_string(),
        create_msg(&root().to_uppercase(), deadline(), "owner"),
        create_msg(&root(), deadline(), "anyone"),
        json!({ "merkle_root": root(), "deadline_ns": U64(deadline()), "policy": "owner", "leaf_count": 1, "sealed_salt": "00" }).to_string(),
        json!({ "merkle_root": root(), "deadline_ns": U64(deadline()), "policy": "owner" }).to_string(),
    ] {
        assert_err(E108, || {
            c.ft_on_transfer(sender(), U128(1), msg.clone());
        });
    }
}

#[test]
fn create_enforces_min_lifetime_boundary() {
    let mut c = base();
    let min = n(&v()["context"]["min_lifetime_ns"]);
    at(usdc(), now());
    assert_err(E119, || {
        c.ft_on_transfer(sender(), U128(1), create_msg(&root(), now() + min - 1, "owner"));
    });
    // Exactly now + min_lifetime is allowed; the vector key outlives it.
    c.ft_on_transfer(sender(), U128(1), create_msg(&root(), now() + min, "owner"));
}

#[test]
fn create_with_empty_snapshot_is_e127() {
    let mut c = base();
    at(usdc(), now());
    // The vector key is valid until deadline + 1 day; a later deadline leaves it out.
    assert_err(E127, || {
        c.ft_on_transfer(sender(), U128(1), create_msg(&root(), deadline() + 2 * DAY_NS, "owner"));
    });
    // shortcut: no measurements can be approved before T11.
    assert_err(E127, || {
        c.ft_on_transfer(sender(), U128(1), create_msg(&root(), deadline(), "attested"));
    });
}

#[test]
fn create_without_storage_prepay_is_e128() {
    let mut c = base();
    c.prepay.insert(sender(), 0);
    at(usdc(), now());
    assert_err(E128, || {
        c.ft_on_transfer(sender(), U128(1), create_msg(&root(), deadline(), "owner"));
    });
}

// ---- registry ----

#[test]
fn registry_owner_path() {
    let mut c = base();
    let signer = v()["keys"]["signer"].as_str().unwrap().to_string();
    let rogue = v()["keys"]["rogue_signer"].as_str().unwrap().to_string();

    at(sender(), now());
    assert_err(E107, || c.add_owner_key(rogue.clone(), U64(1)));
    assert_err(E107, || c.remove_agent(signer.clone()));

    at(owner(), now());
    assert_err(E108, || c.add_owner_key(signer.clone(), U64(1)));
    assert_err(E108, || c.add_owner_key(signer.to_uppercase(), U64(1)));

    let view = serde_json::to_value(c.get_agent(signer.clone()).unwrap()).unwrap();
    assert_eq!(view, json!({ "kind": "owner", "valid_until_ns": (deadline() + DAY_NS).to_string() }));

    c.remove_agent(signer.clone());
    assert!(c.get_agent(signer.clone()).is_none());
    c.add_owner_key(signer.clone(), U64(5)); // remove + add = key extension
    assert_eq!(c.get_agent(signer).unwrap().valid_until_ns.0, 5);
}

// ---- storage pre-pay ----

#[test]
fn prepay_deposit_charges_new_entry_and_accumulates() {
    let mut c = init("testnet");
    set_ctx(sender(), now(), 10u128.pow(22), 300);
    let first = c.prepay_deposit(None).0;
    assert!(first > 0 && first < 10u128.pow(22), "entry bytes are paid from the deposit");
    let second = c.prepay_deposit(None).0;
    assert_eq!(second, first + 10u128.pow(22));
    assert_eq!(c.prepay_balance_of(sender()).0, second);

    set_ctx(acc("poor.testnet"), now(), 1, 300);
    assert_err(E128, || {
        c.prepay_deposit(None);
    });
}

#[test]
fn prepay_withdraw_takes_only_free_balance() {
    let mut c = seeded();
    let free = c.prepay_balance_of(sender()).0;
    at(sender(), now());
    assert_err(E128, || {
        c.prepay_withdraw(Some(U128(free + 1)));
    });
    assert_err(E109, || {
        c.prepay_withdraw(Some(U128(0)));
    });
    c.prepay_withdraw(Some(U128(1)));
    assert_eq!(c.prepay_balance_of(sender()).0, free - 1);
    c.prepay_withdraw(None);
    assert_eq!(c.prepay_balance_of(sender()).0, 0);
    // Reservations are untouched by a withdraw.
    assert_eq!(c.campaigns.get(&7).unwrap().storage_reserved, 5 * per_claim(&c));
}

#[test]
fn fund_campaign_storage_tops_up_until_the_deadline() {
    let mut c = seeded();
    let before = c.campaigns.get(&7).unwrap().storage_reserved;
    set_ctx(acc("anyone.testnet"), now(), 7, 300);
    assert_eq!(c.fund_campaign_storage(U64(7)).0, before + 7);
    assert_err(E110, || {
        c.fund_campaign_storage(U64(99));
    });
    set_ctx(acc("anyone.testnet"), now(), 0, 300);
    assert_err(E109, || {
        c.fund_campaign_storage(U64(7));
    });
    set_ctx(acc("anyone.testnet"), deadline() + 1, 7, 300);
    assert_err(E125, || {
        c.fund_campaign_storage(U64(7));
    });
}

#[test]
fn storage_costs_view() {
    let c = base();
    let s = serde_json::to_value(c.storage_costs(usdc())).unwrap();
    let entry: u128 = s["claim_entry_cost"].as_str().unwrap().parse().unwrap();
    assert_eq!(s["ft_storage_deposit"], USDC_MIN.to_string());
    assert!(entry > 0, "claim entry bytes are measured in new");
    assert_eq!(s["per_claim_storage"], (USDC_MIN + entry).to_string());
    assert_err(E126, || {
        c.storage_costs(acc("evil.testnet"));
    });
}

#[test]
fn token_bounds_are_read_from_the_token() {
    let mut c = init("testnet");
    at(sender(), now());
    assert_err(E107, || {
        c.refresh_token_storage(usdc());
    });
    at(owner(), now());
    assert_err(E126, || {
        c.refresh_token_storage(acc("evil.testnet"));
    });
    let bounds = br#"{"min":"1250000000000000000000","max":"1250000000000000000000"}"#.to_vec();
    with_result(acc("zarf-near.testnet"), now(), PromiseResult::Successful(bounds));
    assert_eq!(c.on_token_storage(usdc()).0, USDC_MIN);
    assert_eq!(c.ft_storage_deposit.get(&usdc()).copied(), Some(USDC_MIN));
    with_result(acc("someone.testnet"), now(), PromiseResult::Failed);
    assert_err(E107, || {
        c.on_token_storage(usdc());
    });
    // m4: the right caller, but the view failed.
    with_result(me(), now(), PromiseResult::Failed);
    assert_err(E108, || {
        c.on_token_storage(usdc());
    });
}

// ---- reclaim ----

#[test]
fn reclaim_only_by_sender_and_only_after_deadline() {
    let mut c = seeded();
    at(sender(), now());
    assert_err(E110, || {
        c.reclaim(U64(99));
    });
    at(acc("stranger.testnet"), deadline() + 1);
    assert_err(E107, || {
        c.reclaim(U64(7));
    });
    at(sender(), deadline());
    assert_err(E117, || {
        c.reclaim(U64(7));
    });
}

#[test]
fn reclaim_excludes_in_flight_and_reverts_on_failed_transfer() {
    let mut c = seeded();
    c.campaigns.get_mut(&7).unwrap().in_flight = 100;
    let free = c.campaigns.get(&7).unwrap().balance;

    at(sender(), deadline() + 1);
    c.reclaim(U64(7));
    let after = c.campaigns.get(&7).unwrap().clone();
    assert_eq!((after.balance, after.in_flight), (0, 100));
    assert_err(E118, || {
        c.reclaim(U64(7));
    });

    with_result(acc("stranger.testnet"), deadline() + 1, PromiseResult::Failed);
    assert_err(E107, || c.on_reclaim(U64(7), U128(free)));

    with_result(acc("zarf-near.testnet"), deadline() + 1, PromiseResult::Failed);
    c.on_reclaim(U64(7), U128(free));
    assert_eq!(c.campaigns.get(&7).unwrap().balance, free);
    assert!(get_logs()[0].contains("\"event\":\"reclaim_reverted\""));
    assert!(get_logs()[0].contains(E115));

    // m3: success leaves the balance where reclaim put it.
    let before = c.campaigns.get(&7).unwrap().balance;
    with_result(acc("zarf-near.testnet"), deadline() + 1, PromiseResult::Successful(vec![]));
    c.on_reclaim(U64(7), U128(free));
    assert!(get_logs()[0].contains("\"event\":\"reclaimed\""));
    assert_eq!(c.campaigns.get(&7).unwrap().balance, before);
}

#[test]
fn reclaim_releases_unused_reservation_even_when_fully_claimed() {
    let mut c = seeded();
    let reserved = c.campaigns.get(&8).unwrap().storage_reserved;
    let free = c.prepay_balance_of(sender()).0;
    c.campaigns.get_mut(&8).unwrap().balance = 0; // as if every leaf was paid
    at(sender(), deadline() + 1);
    c.reclaim(U64(8));
    assert_eq!(c.prepay_balance_of(sender()).0, free + reserved);
    assert_eq!(c.campaigns.get(&8).unwrap().storage_reserved, 0);
    assert_err(E118, || {
        c.reclaim(U64(8));
    });
}

// ---- init ----

#[test]
fn network_is_validated_and_exposed() {
    at(me(), now());
    assert_err(E108, || {
        Contract::new(owner(), "devnet".into(), vec![], U64(1), U64(1), U64(MIN_RESOLVE_DELAY_NS));
    });
    assert_eq!(init("mainnet").get_network(), "mainnet");
}

#[test]
fn new_is_private() {
    at(owner(), now());
    assert_err(E107, || {
        Contract::new(owner(), "testnet".into(), vec![], U64(1), U64(1), U64(MIN_RESOLVE_DELAY_NS));
    });
}

#[test]
fn valid_vector_fails_on_another_network_or_contract() {
    // m5: the vectors are signed for testnet / zarf-near.testnet.
    let c = seeded_on("mainnet");
    assert_err(E101, || {
        c.check_claim(&valid(0));
    });
}

#[test]
fn valid_vector_fails_under_another_contract_id() {
    // One fixture per test: mocked storage persists within a test thread.
    let c = seeded();
    let ctx = VMContextBuilder::new()
        .current_account_id(acc("other-zarf.testnet"))
        .predecessor_account_id(acc("relayer.testnet"))
        .block_timestamp(now())
        .prepaid_gas(Gas::from_tgas(300))
        .build();
    testing_env!(ctx);
    assert_err(E101, || {
        c.check_claim(&valid(0));
    });
}

#[test]
fn check_order_pairs() {
    // m6: an input hitting two conditions reports the earlier one.
    let mut c = seeded();
    let a = valid(0);
    let key = (a.campaign_id.0, hex32(&a.commitment));
    let wrong_proof = { let mut x = a.clone(); x.proof = valid(2).proof; x };
    c.claims.insert(key, ClaimStatus::Claimed);
    assert_err(E105, || { c.check_claim(&wrong_proof); });
    c.claims.remove(&key);
    let bad_both = { let mut x = wrong_proof.clone(); x.signature = valid(1).signature; x };
    assert_err(E102, || { c.check_claim(&bad_both); });

    let need = per_claim(&c);
    let camp = c.campaigns.get_mut(&7).unwrap();
    camp.balance = a.amount.0 - 1;
    camp.storage_reserved = need - 1;
    // Enough gas to run the checks, too little for the claim (the mock enforces gas).
    set_ctx(acc("relayer.testnet"), now(), 0, claim_gas_needed().as_tgas() - 1);
    assert_err(E129, || { c.check_claim(&a); });
    c.campaigns.get_mut(&7).unwrap().balance = a.amount.0;
    assert_err(E128, || { c.check_claim(&a); });
    c.campaigns.get_mut(&7).unwrap().storage_reserved = need;
    assert_err(E130, || { c.check_claim(&a); });
}

// ---- claim (async) ----

fn do_claim(c: &mut Contract, a: &ClaimArgs) {
    c.claim(
        a.campaign_id,
        a.commitment.clone(),
        a.amount,
        a.proof.clone(),
        a.destination.clone(),
        a.expires_at_ns,
        a.signer.clone(),
        a.signature.clone(),
    );
}

#[test]
fn claim_moves_funds_to_in_flight_and_draws_its_reservation() {
    let mut c = seeded();
    let a = valid(0);
    let before = c.campaigns.get(&7).unwrap().clone();
    let other = c.campaigns.get(&8).unwrap().storage_reserved;
    let prepay = c.prepay_balance_of(sender()).0;
    do_claim(&mut c, &a);
    let after = c.campaigns.get(&7).unwrap().clone();
    assert_eq!(after.balance, before.balance - a.amount.0);
    assert_eq!(after.in_flight, a.amount.0);
    assert_eq!(after.storage_reserved, before.storage_reserved - per_claim(&c));
    assert_eq!(c.campaigns.get(&8).unwrap().storage_reserved, other);
    assert_eq!(c.prepay_balance_of(sender()).0, prepay, "free pre-pay is not touched");
    assert_eq!(c.claim_state(a.campaign_id, a.commitment.clone()), "pending");
    assert!(get_logs()[0].contains("\"event\":\"claim_started\""));
    // storage_deposit, ft_transfer and the callback are all scheduled.
    assert_eq!(near_sdk::test_utils::get_created_receipts().len(), 3);
    // A second attempt while in flight is refused.
    assert_err(E123, || do_claim(&mut c, &a));
}

#[test]
fn callback_success_marks_claimed() {
    let mut c = seeded();
    let a = valid(0);
    do_claim(&mut c, &a);
    with_result(acc("zarf-near.testnet"), now(), PromiseResult::Successful(vec![]));
    c.on_claim(a.campaign_id, a.commitment.clone(), a.amount, acc(&a.destination), U64(now()));
    assert_eq!(c.claim_state(a.campaign_id, a.commitment.clone()), "claimed");
    assert_eq!(c.campaigns.get(&7).unwrap().in_flight, 0);
    assert!(get_logs()[0].contains("\"event\":\"claim_paid\""));
    at(acc("relayer.testnet"), now());
    assert_err(E105, || do_claim(&mut c, &a));
}

#[test]
fn callback_failure_restores_claim_but_not_storage_debit() {
    let mut c = seeded();
    let a = valid(0);
    let balance = c.campaigns.get(&7).unwrap().balance;
    let reserved = c.campaigns.get(&7).unwrap().storage_reserved;
    do_claim(&mut c, &a);
    with_result(acc("zarf-near.testnet"), now(), PromiseResult::Failed);
    c.on_claim(a.campaign_id, a.commitment.clone(), a.amount, acc(&a.destination), U64(now()));
    assert_eq!(c.claim_state(a.campaign_id, a.commitment.clone()), "unclaimed");
    let camp = c.campaigns.get(&7).unwrap().clone();
    assert_eq!((camp.balance, camp.in_flight), (balance, 0));
    // m1: the removed entry's bytes come back; the ft_storage_deposit part does not.
    assert_eq!(camp.storage_reserved, reserved - USDC_MIN);
    assert!(get_logs()[0].contains("\"event\":\"claim_reverted\""));
    assert!(get_logs()[0].contains(E115));
}

#[test]
fn callback_rejects_outside_callers() {
    let mut c = seeded();
    let a = valid(0);
    do_claim(&mut c, &a);
    with_result(acc("relayer.testnet"), now(), PromiseResult::Successful(vec![]));
    assert_err(E107, || c.on_claim(a.campaign_id, a.commitment.clone(), a.amount, acc(&a.destination), U64(now())));
}

#[test]
fn reclaim_during_in_flight_claim_leaves_it_alone() {
    let mut c = seeded();
    let a = valid(0);
    do_claim(&mut c, &a);
    let free = c.campaigns.get(&7).unwrap().balance;
    at(sender(), deadline() + 1);
    c.reclaim(U64(7));
    assert_eq!(c.campaigns.get(&7).unwrap().in_flight, a.amount.0);
    // The late callback still settles the claim against in_flight.
    with_result(acc("zarf-near.testnet"), deadline() + 1, PromiseResult::Failed);
    c.on_claim(a.campaign_id, a.commitment.clone(), a.amount, acc(&a.destination), U64(now()));
    let camp = c.campaigns.get(&7).unwrap().clone();
    assert_eq!((camp.balance, camp.in_flight), (a.amount.0, 0));
    assert!(free > 0);
}

#[test]
fn resolve_pending_is_owner_only_and_waits_an_hour() {
    let mut c = seeded();
    let a = valid(0);
    do_claim(&mut c, &a);
    let resolve = |c: &mut Contract, paid| {
        c.resolve_pending(a.campaign_id, a.commitment.clone(), paid, "receipt-id".into())
    };
    at(sender(), now() + MIN_RESOLVE_DELAY_NS);
    assert_err(E107, || resolve(&mut c, true));
    at(owner(), now() + MIN_RESOLVE_DELAY_NS - 1);
    assert_err(E107, || resolve(&mut c, true));
    at(owner(), now() + MIN_RESOLVE_DELAY_NS);
    let reserved = c.campaigns.get(&7).unwrap().storage_reserved;
    resolve(&mut c, false);
    assert_eq!(c.claim_state(a.campaign_id, a.commitment.clone()), "unclaimed");
    assert_eq!(c.campaigns.get(&7).unwrap().storage_reserved, reserved + (per_claim(&c) - USDC_MIN));
    assert!(get_logs()[0].contains("\"event\":\"pending_resolved\""));
    assert!(get_logs()[0].contains("receipt-id"));
    assert_eq!(c.campaigns.get(&7).unwrap().in_flight, 0);
    // Nothing is pending any more.
    assert_err(E108, || resolve(&mut c, true));
    // A callback arriving after the resolution is a no-op.
    with_result(acc("zarf-near.testnet"), now(), PromiseResult::Successful(vec![]));
    c.on_claim(a.campaign_id, a.commitment.clone(), a.amount, acc(&a.destination), U64(now()));
    assert_eq!(c.claim_state(a.campaign_id, a.commitment.clone()), "unclaimed");
    assert!(get_logs().is_empty());
}

#[test]
fn resolve_pending_paid_marks_claimed() {
    let mut c = seeded();
    let a = valid(0);
    let balance = c.campaigns.get(&7).unwrap().balance;
    do_claim(&mut c, &a);
    at(owner(), now() + MIN_RESOLVE_DELAY_NS);
    c.resolve_pending(a.campaign_id, a.commitment.clone(), true, "receipt-id".into());
    assert_eq!(c.claim_state(a.campaign_id, a.commitment.clone()), "claimed");
    let camp = c.campaigns.get(&7).unwrap().clone();
    assert_eq!((camp.balance, camp.in_flight), (balance - a.amount.0, 0));
}

#[test]
fn late_callback_of_a_resolved_attempt_does_not_settle_the_next_one() {
    // M1: A's callback is delayed past the hour, the owner resolves A as unpaid, the
    // recipient claims again (B); A's late Failed callback must leave B pending.
    let mut c = seeded();
    let a = valid(0);
    do_claim(&mut c, &a); // attempt A at now()
    at(owner(), now() + MIN_RESOLVE_DELAY_NS);
    c.resolve_pending(a.campaign_id, a.commitment.clone(), false, "receipt-a".into());
    // B would need a fresh signature; insert its pending entry directly.
    let key = (a.campaign_id.0, hex32(&a.commitment));
    let b_started = now() + MIN_RESOLVE_DELAY_NS;
    c.claims.insert(key, ClaimStatus::Pending { amount: a.amount.0, started_ns: b_started });
    c.campaigns.get_mut(&7).unwrap().in_flight += a.amount.0;
    with_result(me(), b_started + 1, PromiseResult::Failed);
    c.on_claim(a.campaign_id, a.commitment.clone(), a.amount, acc(&a.destination), U64(now()));
    assert_eq!(c.claim_state(a.campaign_id, a.commitment.clone()), "pending");
    assert_eq!(c.campaigns.get(&7).unwrap().in_flight, a.amount.0);
    assert!(get_logs().is_empty());
    // B's own callback still settles B.
    c.on_claim(a.campaign_id, a.commitment.clone(), a.amount, acc(&a.destination), U64(b_started));
    assert_eq!(c.claim_state(a.campaign_id, a.commitment.clone()), "unclaimed");
}

#[test]
fn campaign_bytes_cost_bounds_the_real_creation_cost() {
    let mut c = base();
    at(owner(), now());
    c.add_owner_key(v()["keys"]["rogue_signer"].as_str().unwrap().into(), U64(deadline() + DAY_NS));
    let costs = c.storage_costs(usdc());
    let bound = costs.campaign_bytes_cost.0;
    let reserve = 5 * costs.per_claim_storage.0;
    let free = c.prepay_balance_of(sender()).0;
    at(usdc(), now());
    c.ft_on_transfer(sender(), U128(1), create_msg(&root(), deadline(), "owner"));
    let spent = free - c.prepay_balance_of(sender()).0 - reserve;
    assert!(spent > 0 && spent <= bound, "spent {spent} > bound {bound}");
    // A later campaign (list entries already exist) costs no more than the first.
    let free = c.prepay_balance_of(sender()).0;
    c.ft_on_transfer(sender(), U128(1), create_msg(&other_root(2), deadline(), "owner"));
    let later = free - c.prepay_balance_of(sender()).0 - reserve;
    assert!(later <= spent && later <= bound);
    // Each owner key raises the bound by exactly 32 bytes.
    at(owner(), now());
    c.remove_agent(v()["keys"]["rogue_signer"].as_str().unwrap().into());
    let smaller = c.storage_costs(usdc()).campaign_bytes_cost.0;
    assert_eq!(bound - smaller, 32 * env::storage_byte_cost().as_yoctonear());
}

#[test]
fn get_config_view() {
    let c = base();
    let cfg = serde_json::to_value(c.get_config()).unwrap();
    assert_eq!(
        cfg,
        json!({
            "network": "testnet",
            "min_lifetime_ns": v()["context"]["min_lifetime_ns"],
            "agent_ttl_ns": (7 * DAY_NS).to_string(),
            "resolve_delay_ns": MIN_RESOLVE_DELAY_NS.to_string(),
            "token_ids": ["usdc.testnet"],
            "storage_byte_cost": env::storage_byte_cost().as_yoctonear().to_string(),
        })
    );
}

#[test]
fn duplicate_root_is_e132_and_changes_nothing() {
    let mut c = base();
    at(usdc(), now());
    c.ft_on_transfer(sender(), U128(500), create_msg(&root(), deadline(), "owner"));
    assert_eq!(c.campaign_by_root(sender(), root()), Some(U64(0)));
    assert_eq!(c.campaign_by_root(sender(), other_root(1)), None);
    assert_eq!(c.campaign_by_root(acc("other.testnet"), root()), None);
    let free = c.prepay_balance_of(sender()).0;
    let next = c.next_campaign_id;
    assert_err(E132, || {
        c.ft_on_transfer(sender(), U128(500), create_msg(&root(), deadline(), "owner"));
    });
    assert_eq!(c.next_campaign_id, next);
    assert_eq!(c.prepay_balance_of(sender()).0, free);
    assert!(c.get_campaign(U64(1)).is_none());
    // Order: E108 (msg) before E132, E132 before E119.
    assert_err(E108, || {
        c.ft_on_transfer(sender(), U128(1), json!({ "merkle_root": root() }).to_string());
    });
    assert_err(E132, || {
        c.ft_on_transfer(sender(), U128(1), create_msg(&root(), now(), "owner"));
    });
}

#[test]
fn another_sender_may_use_the_same_root() {
    // Reviewer M1: a global key would let anyone front-run and occupy a sender's root.
    let mut c = base();
    let other = acc("other.testnet");
    set_ctx(other.clone(), now(), 10u128.pow(24), 300);
    c.prepay_deposit(None);
    at(usdc(), now());
    c.ft_on_transfer(other.clone(), U128(1), create_msg(&root(), deadline(), "owner"));
    c.ft_on_transfer(sender(), U128(1), create_msg(&root(), deadline(), "owner"));
    assert_eq!(c.campaign_by_root(other.clone(), root()), Some(U64(0)));
    assert_eq!(c.campaign_by_root(sender(), root()), Some(U64(1)));
    assert_eq!(c.get_campaign(U64(1)).unwrap().sender, sender());
    assert_err(E132, || {
        c.ft_on_transfer(other.clone(), U128(1), create_msg(&root(), deadline(), "owner"));
    });
}

#[test]
fn campaigns_of_lists_per_sender_in_order_with_pagination() {
    let mut c = base();
    let other = acc("other.testnet");
    set_ctx(other.clone(), now(), 10u128.pow(25), 300);
    c.prepay_deposit(None);
    set_ctx(sender(), now(), 10u128.pow(25), 300);
    c.prepay_deposit(None);
    at(usdc(), now());
    let mut mine = Vec::new();
    for i in 0..140u8 {
        let who = if i % 4 == 0 { other.clone() } else { sender() };
        let id = c.next_campaign_id;
        let msg = json!({ "merkle_root": other_root(i + 10), "deadline_ns": U64(deadline()), "policy": "owner", "leaf_count": 1 });
        at(usdc(), now()); // a fresh context per call: the mock caps total log length
        c.ft_on_transfer(who.clone(), U128(1), msg.to_string());
        if who == sender() {
            mine.push(U64(id));
        }
    }
    assert_eq!(mine.len(), 105);
    let ids = |from, limit| c.campaigns_of(sender(), from, limit);
    assert_eq!(ids(None, None), mine[..50].to_vec());
    // The cap: 105 exist, a limit of 500 returns exactly 100.
    assert_eq!(ids(Some(0), Some(500)), mine[..100].to_vec());
    assert_eq!(ids(Some(100), Some(500)), mine[100..].to_vec());
    assert_eq!(ids(Some(10), Some(5)), mine[10..15].to_vec());
    assert!(ids(Some(105), None).is_empty());
    assert!(ids(Some(u32::MAX), Some(u32::MAX)).is_empty());
    assert_eq!(c.campaigns_of(other.clone(), None, Some(100)).len(), 35);
    assert!(c.campaigns_of(acc("nobody.testnet"), None, None).is_empty());
}

#[test]
fn mainnet_refuses_the_public_test_keys() {
    let keys = &v()["keys"];
    assert_eq!(PUBLIC_TEST_KEYS, [keys["signer"].as_str().unwrap(), keys["rogue_signer"].as_str().unwrap()]);
    let mut c = init("mainnet");
    at(owner(), now());
    for k in PUBLIC_TEST_KEYS {
        assert_err(E108, || c.add_owner_key(k.into(), U64(u64::MAX)));
    }
    c.add_owner_key(other_root(3), U64(u64::MAX));
    // Testnet keeps accepting them: the sandbox and the vector tests rely on it.
    let mut t = init("testnet");
    at(owner(), now());
    t.add_owner_key(PUBLIC_TEST_KEYS[0].into(), U64(u64::MAX));
}

#[test]
fn mainnet_floors_resolve_delay_at_one_hour() {
    at(me(), now());
    assert_err(E108, || {
        Contract::new(owner(), "mainnet".into(), vec![], U64(1), U64(1), U64(MIN_RESOLVE_DELAY_NS - 1));
    });
    let m = Contract::new(owner(), "mainnet".into(), vec![], U64(1), U64(1), U64(MIN_RESOLVE_DELAY_NS));
    assert_eq!(m.get_config().resolve_delay_ns.0, MIN_RESOLVE_DELAY_NS);
}

#[test]
fn testnet_may_use_a_short_resolve_delay() {
    at(me(), now());
    let mut c = Contract::new(owner(), "testnet".into(), vec![usdc()], U64(1), U64(1), U64(5_000_000_000));
    c.ft_storage_deposit.insert(usdc(), USDC_MIN);
    at(owner(), now());
    c.add_owner_key(v()["keys"]["signer"].as_str().unwrap().into(), U64(deadline() + DAY_NS));
    set_ctx(sender(), now(), 10u128.pow(24), 300);
    c.prepay_deposit(None);
    c.next_campaign_id = 7;
    at(usdc(), now());
    c.ft_on_transfer(sender(), U128(10u128.pow(13)), create_msg(&root(), deadline(), "owner"));
    at(acc("relayer.testnet"), now());
    let a = valid(0);
    do_claim(&mut c, &a);
    at(owner(), now() + 4_999_999_999);
    assert_err(E107, || c.resolve_pending(a.campaign_id, a.commitment.clone(), false, "r".into()));
    at(owner(), now() + 5_000_000_000);
    c.resolve_pending(a.campaign_id, a.commitment.clone(), false, "r".into());
    assert_eq!(c.claim_state(a.campaign_id, a.commitment.clone()), "unclaimed");
}
