//! near-workspaces tests for the async claim path (spec/claim.md v2.1, design §4.2).
//! Wasm comes from `make wasm` in contract/: release, test-callback-panic, mock-ft.

use ed25519_dalek::{Signer, SigningKey};
use near_workspaces::network::Sandbox;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::{Account, Contract, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const WASM_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/near");
const AMOUNT: u128 = 5_000_000;
const DEPOSIT: u128 = 20_000_000;
const HOUR_NS: u64 = 3_600 * 1_000_000_000;
const COMMITMENT: [u8; 32] = [0x42; 32];
/// The vector signer seed (spec/vectors.json keys.signer_seed); test-only.
const SIGNER_SEED: [u8; 32] = [1; 32];

fn wasm(name: &str) -> Vec<u8> {
    let path = format!("{WASM_DIR}/{name}");
    std::fs::read(&path).unwrap_or_else(|_| panic!("missing {path}: run `make wasm` in contract/"))
}
fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}
fn sha(parts: &[&[u8]]) -> [u8; 32] {
    let mut h = Sha256::new();
    for p in parts {
        h.update(p);
    }
    h.finalize().into()
}
fn leaf(c: &[u8; 32], amount: u128) -> [u8; 32] {
    sha(&[&[0x00], c, &amount.to_le_bytes()])
}
fn push_str(b: &mut Vec<u8>, s: &str) {
    b.push(s.len() as u8);
    b.extend_from_slice(s.as_bytes());
}

struct Env {
    worker: Worker<Sandbox>,
    zarf: Contract,
    ft: Contract,
    sender: Account,
    relayer: Account,
    owner: Account,
}

async fn setup(zarf_wasm: &str) -> anyhow::Result<Env> {
    let worker = near_workspaces::sandbox().await?;
    let owner = worker.dev_create_account().await?;
    let sender = worker.dev_create_account().await?;
    let relayer = worker.dev_create_account().await?;
    let ft = worker.dev_deploy(&wasm("mock-ft/mock_ft.wasm")).await?;
    let zarf = worker.dev_deploy(&wasm(zarf_wasm)).await?;

    ft.call("new")
        .args_json(json!({ "owner_id": sender.id(), "total_supply": "1000000000" }))
        .transact()
        .await?
        .into_result()?;
    zarf.call("new")
        .args_json(json!({
            "owner_id": owner.id(), "network": "testnet", "token_ids": [ft.id()],
            "min_lifetime_ns": "1000000000", "agent_ttl_ns": "604800000000000",
        }))
        .transact()
        .await?
        .into_result()?;
    // The escrow must hold tokens, so it registers itself on the token.
    sender
        .call(ft.id(), "storage_deposit")
        .args_json(json!({ "account_id": zarf.id() }))
        .deposit(NearToken::from_millinear(10))
        .transact()
        .await?
        .into_result()?;
    owner
        .call(zarf.id(), "refresh_token_storage")
        .args_json(json!({ "token_id": ft.id() }))
        .max_gas()
        .transact()
        .await?
        .into_result()?;
    let signer = SigningKey::from_bytes(&SIGNER_SEED).verifying_key().to_bytes();
    owner
        .call(zarf.id(), "add_owner_key")
        .args_json(json!({ "signer": hex(&signer), "valid_until_ns": u64::MAX.to_string() }))
        .transact()
        .await?
        .into_result()?;
    sender
        .call(zarf.id(), "prepay_deposit")
        .args_json(json!({}))
        .deposit(NearToken::from_near(1))
        .transact()
        .await?
        .into_result()?;
    Ok(Env { worker, zarf, ft, sender, relayer, owner })
}

async fn now_ns(e: &Env) -> anyhow::Result<u64> {
    Ok(e.worker.view_block().await?.timestamp())
}

/// One-leaf campaign (root = leaf, empty proof); returns its campaign id.
async fn create(e: &Env, deadline_ns: u64) -> anyhow::Result<u64> {
    let msg = json!({
        "merkle_root": hex(&leaf(&COMMITMENT, AMOUNT)),
        "deadline_ns": deadline_ns.to_string(), "policy": "owner", "leaf_count": 1,
    });
    let out = e
        .sender
        .call(e.ft.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": e.zarf.id(), "amount": DEPOSIT.to_string(), "msg": msg.to_string() }))
        .deposit(NearToken::from_yoctonear(1))
        .max_gas()
        .transact()
        .await?;
    let log = out
        .logs()
        .into_iter()
        .find(|l| l.contains("campaign_created"))
        .expect("campaign_created event")
        .to_string();
    let ev: Value = serde_json::from_str(log.trim_start_matches("EVENT_JSON:"))?;
    Ok(ev["data"][0]["campaign_id"].as_str().unwrap().parse()?)
}

async fn claim(e: &Env, id: u64, dest: &Account) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    let expires = now_ns(e).await? + 10 * 60 * 1_000_000_000;
    let mut p = b"ZARF-NEAR-CLAIM-V1".to_vec();
    push_str(&mut p, "testnet");
    push_str(&mut p, e.zarf.id().as_str());
    p.extend_from_slice(&id.to_le_bytes());
    p.extend_from_slice(&COMMITMENT);
    p.extend_from_slice(&AMOUNT.to_le_bytes());
    push_str(&mut p, dest.id().as_str());
    p.extend_from_slice(&expires.to_le_bytes());
    let key = SigningKey::from_bytes(&SIGNER_SEED);
    let sig = key.sign(&p).to_bytes();
    Ok(e.relayer
        .call(e.zarf.id(), "claim")
        .args_json(json!({
            "campaign_id": id.to_string(), "commitment": hex(&COMMITMENT), "amount": AMOUNT.to_string(),
            "proof": [], "destination": dest.id(), "expires_at_ns": expires.to_string(),
            "signer": hex(&key.verifying_key().to_bytes()), "signature": hex(&sig),
        }))
        .gas(Gas::from_tgas(100))
        .transact()
        .await?)
}

async fn campaign(e: &Env, id: u64) -> anyhow::Result<Value> {
    Ok(e.zarf.view("get_campaign").args_json(json!({ "campaign_id": id.to_string() })).await?.json()?)
}
async fn state(e: &Env, id: u64) -> anyhow::Result<String> {
    Ok(e.zarf
        .view("claim_state")
        .args_json(json!({ "campaign_id": id.to_string(), "commitment": hex(&COMMITMENT) }))
        .await?
        .json()?)
}
async fn ft_balance(e: &Env, who: &Account) -> anyhow::Result<u128> {
    let v: String = e.ft.view("ft_balance_of").args_json(json!({ "account_id": who.id() })).await?.json()?;
    Ok(v.parse()?)
}

#[tokio::test]
async fn claim_pays_an_unregistered_destination_once() -> anyhow::Result<()> {
    let e = setup("release/zarf_near.wasm").await?;
    let id = create(&e, now_ns(&e).await? + HOUR_NS).await?;
    let bob = e.worker.dev_create_account().await?;

    let out = claim(&e, id, &bob).await?;
    assert!(out.is_success(), "{out:?}");
    assert_eq!(ft_balance(&e, &bob).await?, AMOUNT);
    assert_eq!(state(&e, id).await?, "claimed");
    let c = campaign(&e, id).await?;
    assert_eq!(c["balance"], (DEPOSIT - AMOUNT).to_string());
    assert_eq!(c["in_flight"], "0");
    assert!(out.logs().iter().any(|l| l.contains("claim_paid")));

    let again = claim(&e, id, &bob).await?;
    assert!(format!("{:?}", again.into_result().unwrap_err()).contains("E105_ALREADY_CLAIMED"));
    Ok(())
}

#[tokio::test]
async fn failed_transfer_rolls_back_but_keeps_storage_debit() -> anyhow::Result<()> {
    let e = setup("release/zarf_near.wasm").await?;
    let id = create(&e, now_ns(&e).await? + HOUR_NS).await?;
    let bob = e.worker.dev_create_account().await?;
    for (transfers, storage) in [(true, false), (false, true)] {
        e.ft.call("set_fail").args_json(json!({ "transfers": transfers, "storage": storage }))
            .transact().await?.into_result()?;
        let reserved = campaign(&e, id).await?["storage_reserved"].as_str().unwrap().parse::<u128>()?;
        let out = claim(&e, id, &bob).await?;
        assert!(out.logs().iter().any(|l| l.contains("claim_reverted") && l.contains("E115")), "{out:?}");
        assert_eq!(state(&e, id).await?, "unclaimed");
        let c = campaign(&e, id).await?;
        assert_eq!((c["balance"].as_str(), c["in_flight"].as_str()), (Some(&*DEPOSIT.to_string()), Some("0")));
        assert_eq!(ft_balance(&e, &bob).await?, 0);
        let after = c["storage_reserved"].as_str().unwrap().parse::<u128>()?;
        assert!(after < reserved, "the reservation debit is not credited back");
        // Top the one-leaf reservation up again for the next attempt.
        e.sender.call(e.zarf.id(), "fund_campaign_storage")
            .args_json(json!({ "campaign_id": id.to_string() }))
            .deposit(NearToken::from_millinear(10))
            .transact().await?.into_result()?;
    }
    // Once the token works again, the same commitment can still be claimed.
    e.ft.call("set_fail").args_json(json!({ "transfers": false, "storage": false }))
        .transact().await?.into_result()?;
    assert!(claim(&e, id, &bob).await?.is_success());
    assert_eq!(ft_balance(&e, &bob).await?, AMOUNT);
    Ok(())
}

#[tokio::test]
async fn failed_callback_strands_claim_until_owner_resolves_it() -> anyhow::Result<()> {
    let e = setup("callback-panic/zarf_near.wasm").await?;
    let deadline = now_ns(&e).await? + 30 * 1_000_000_000;
    let id = create(&e, deadline).await?;
    let bob = e.worker.dev_create_account().await?;

    let out = claim(&e, id, &bob).await?;
    assert!(!out.is_success(), "the callback must have panicked");
    assert_eq!(ft_balance(&e, &bob).await?, AMOUNT, "the transfer itself succeeded");
    assert_eq!(state(&e, id).await?, "pending");
    assert_eq!(campaign(&e, id).await?["in_flight"], AMOUNT.to_string());

    // Reclaim after the deadline never touches the in-flight amount.
    while now_ns(&e).await? <= deadline {
        e.worker.fast_forward(20).await?;
    }
    let before = ft_balance(&e, &e.sender).await?;
    e.sender.call(e.zarf.id(), "reclaim").args_json(json!({ "campaign_id": id.to_string() }))
        .max_gas().transact().await?.into_result()?;
    assert_eq!(ft_balance(&e, &e.sender).await?, before + DEPOSIT - AMOUNT);
    let c = campaign(&e, id).await?;
    assert_eq!((c["balance"].as_str(), c["in_flight"].as_str()), (Some("0"), Some(&*AMOUNT.to_string())));

    let resolve = |paid: bool| {
        e.owner.call(e.zarf.id(), "resolve_pending").args_json(json!({
            "campaign_id": id.to_string(), "commitment": hex(&COMMITMENT), "paid": paid,
            "evidence": "receipt-id-from-explorer",
        }))
    };
    let early = resolve(true).transact().await?;
    assert!(format!("{:?}", early.into_result().unwrap_err()).contains("E107_UNAUTHORIZED"));

    let started = now_ns(&e).await?;
    while now_ns(&e).await? < started + HOUR_NS {
        e.worker.fast_forward(1_000).await?;
    }
    let out = resolve(true).transact().await?;
    assert!(out.is_success(), "{out:?}");
    assert!(out.logs().iter().any(|l| l.contains("pending_resolved")));
    assert_eq!(state(&e, id).await?, "claimed");
    assert_eq!(campaign(&e, id).await?["in_flight"], "0");
    Ok(())
}

#[test]
fn release_wasm_has_no_test_callback_panic() {
    let release = wasm("release/zarf_near.wasm");
    let test = wasm("callback-panic/zarf_near.wasm");
    let needle = b"TEST_CALLBACK_PANIC";
    let has = |w: &[u8]| w.windows(needle.len()).any(|x| x == needle);
    assert!(has(&test), "the test build must carry the panic, or this check proves nothing");
    assert!(!has(&release));
}
