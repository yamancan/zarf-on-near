//! Unit tests. Spec vectors: `spec/vectors.json` (shared with the TS layers).

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
    json!({ "merkle_root": root, "deadline_ns": U64(deadline_ns), "policy": policy }).to_string()
}

/// Contract with the vector signer registered, USDC bounds read, sender pre-paid.
fn base() -> Contract {
    let ctx = v()["context"].clone();
    at(owner(), now());
    let mut c = Contract::new(
        owner(),
        ctx["network"].as_str().unwrap().into(),
        vec![usdc()],
        U64(n(&ctx["min_lifetime_ns"])),
        U64(7 * DAY_NS),
    );
    c.ft_storage_deposit.insert(usdc(), USDC_MIN);
    c.add_owner_key(v()["keys"]["signer"].as_str().unwrap().into(), U64(deadline() + DAY_NS));
    set_ctx(sender(), now(), 10u128.pow(24), 300);
    c.storage_deposit(None);
    c
}

/// `base()` plus the vector campaigns at ids 7 (main) and 8 (single).
fn seeded() -> Contract {
    let mut c = base();
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
    c.claims.insert(key, ClaimStatus::Pending);
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
    c.agents.get_mut(&hex32(&a.signer)).unwrap().valid_until_ns = now() - 1;
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
    c.ft_on_transfer(sender(), U128(1), create_msg(&root(), deadline(), "owner"));
    let mut fresh = c.get_campaign(U64(9)).unwrap().snapshot;
    fresh.sort();
    let mut both = vec![signer, rogue];
    both.sort();
    assert_eq!(fresh, both);
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
fn sender_without_prepay_for_destination_storage_is_e128() {
    let mut c = seeded();
    c.storage.insert(sender(), USDC_MIN - 1);
    assert_err(E128, || {
        c.check_claim(&valid(0));
    });
}

#[test]
fn low_gas_is_e130_and_view_reports_requirement() {
    let c = seeded();
    assert_eq!(c.required_claim_gas().0, Gas::from_tgas(50).as_gas());
    set_ctx(acc("relayer.testnet"), now(), 0, 49);
    assert_err(E130, || {
        c.check_claim(&valid(0));
    });
}

// ---- ft_on_transfer ----

fn root() -> String {
    v()["campaigns"]["main"]["merkle_root"].as_str().unwrap().into()
}

#[test]
fn create_assigns_counter_ids_snapshots_and_emits() {
    let mut c = base();
    let before = c.storage_balance_of(sender()).0;
    at(usdc(), now());
    let r = c.ft_on_transfer(sender(), U128(500), create_msg(&root(), deadline(), "owner"));
    assert!(matches!(r, PromiseOrValue::Value(U128(0))));
    assert!(get_logs()[0].starts_with("EVENT_JSON:{"));
    assert!(get_logs()[0].contains("\"event\":\"campaign_created\""));
    c.ft_on_transfer(sender(), U128(1), create_msg(&root(), deadline(), "owner"));
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
    assert!(c.storage_balance_of(sender()).0 < before, "campaign storage is charged to the sender");
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
        json!({ "merkle_root": root(), "deadline_ns": U64(deadline()), "policy": "owner", "sealed_salt": "00" }).to_string(),
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
    c.storage.insert(sender(), 0);
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
fn storage_deposit_charges_new_entry_and_accumulates() {
    at(owner(), now());
    let mut c = Contract::new(owner(), "testnet".into(), vec![usdc()], U64(1), U64(1));
    set_ctx(sender(), now(), 10u128.pow(22), 300);
    let first = c.storage_deposit(None).0;
    assert!(first > 0 && first < 10u128.pow(22), "entry bytes are paid from the deposit");
    let second = c.storage_deposit(None).0;
    assert_eq!(second, first + 10u128.pow(22));

    set_ctx(acc("poor.testnet"), now(), 1, 300);
    assert_err(E128, || {
        c.storage_deposit(None);
    });
}

#[test]
fn token_bounds_are_read_from_the_token() {
    at(owner(), now());
    let mut c = Contract::new(owner(), "testnet".into(), vec![usdc()], U64(1), U64(1));
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

    with_result(acc("zarf-near.testnet"), deadline() + 1, PromiseResult::Successful(vec![]));
    c.on_reclaim(U64(7), U128(free));
    assert!(get_logs()[0].contains("\"event\":\"reclaimed\""));
}

// ---- init ----

#[test]
fn network_is_validated_and_exposed() {
    at(owner(), now());
    assert_err(E108, || {
        Contract::new(owner(), "devnet".into(), vec![], U64(1), U64(1));
    });
    let c = Contract::new(owner(), "mainnet".into(), vec![], U64(1), U64(1));
    assert_eq!(c.get_network(), "mainnet");
}
