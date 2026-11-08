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
/// Short `resolve_delay_ns` so the stranded-callback test needn't fast-forward an hour.
const RESOLVE_DELAY_NS: u64 = 30 * 1_000_000_000;
/// Short `upgrade_delay_ns` for the sandbox (mainnet floor is 48 h).
const UPGRADE_DELAY_NS: u64 = 5 * 1_000_000_000;
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
fn node(a: &[u8; 32], b: &[u8; 32]) -> [u8; 32] {
    let (lo, hi) = if a <= b { (a, b) } else { (b, a) };
    sha(&[&[0x01], lo, hi])
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
            "resolve_delay_ns": RESOLVE_DELAY_NS.to_string(),
            "upgrade_delay_ns": UPGRADE_DELAY_NS.to_string(),
            "guardian_id": null,
            "initial_signers": [{
                "signer": hex(&SigningKey::from_bytes(&SIGNER_SEED).verifying_key().to_bytes()),
                "valid_until_ns": u64::MAX.to_string(),
            }],
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
    create_with_root(e, deadline_ns, leaf(&COMMITMENT, AMOUNT)).await
}

async fn create_with_root(e: &Env, deadline_ns: u64, root: [u8; 32]) -> anyhow::Result<u64> {
    let msg = json!({
        "merkle_root": hex(&root),
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
    claim_with_gas(e, id, dest, Gas::from_tgas(300)).await
}

async fn claim_with_gas(
    e: &Env,
    id: u64,
    dest: &Account,
    gas: Gas,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    claim_raw(e, id, dest.id().as_str(), &[], gas).await
}

async fn claim_raw(
    e: &Env,
    id: u64,
    dest: &str,
    proof: &[[u8; 32]],
    gas: Gas,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(claim_tx(e, id, dest, proof, gas).await?.transact().await?)
}

/// The signed claim call, not yet sent (so a test can send it with transact_async).
async fn claim_tx(
    e: &Env,
    id: u64,
    dest: &str,
    proof: &[[u8; 32]],
    gas: Gas,
) -> anyhow::Result<near_workspaces::operations::CallTransaction> {
    let expires = now_ns(e).await? + 10 * 60 * 1_000_000_000;
    let mut p = b"ZARF-NEAR-CLAIM-V1".to_vec();
    push_str(&mut p, "testnet");
    push_str(&mut p, e.zarf.id().as_str());
    p.extend_from_slice(&id.to_le_bytes());
    p.extend_from_slice(&COMMITMENT);
    p.extend_from_slice(&AMOUNT.to_le_bytes());
    push_str(&mut p, dest);
    p.extend_from_slice(&expires.to_le_bytes());
    let key = SigningKey::from_bytes(&SIGNER_SEED);
    let sig = key.sign(&p).to_bytes();
    Ok(e.relayer
        .call(e.zarf.id(), "claim")
        .args_json(json!({
            "campaign_id": id.to_string(), "commitment": hex(&COMMITMENT), "amount": AMOUNT.to_string(),
            "proof": proof.iter().map(|x| hex(x)).collect::<Vec<_>>(), "destination": dest,
            "expires_at_ns": expires.to_string(),
            "signer": hex(&key.verifying_key().to_bytes()), "signature": hex(&sig),
        }))
        .gas(gas))
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
    let costs: Value = e.zarf.view("storage_costs").args_json(json!({ "token_id": e.ft.id() })).await?.json()?;
    let ft_storage: u128 = costs["ft_storage_deposit"].as_str().unwrap().parse()?;
    for (transfers, storage) in [(true, false), (false, true)] {
        // A fresh destination each round: a successful storage_deposit registers it, and a
        // registered destination would make the storage-fail round's ft_transfer succeed.
        let bob = e.worker.dev_create_account().await?;
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
        // The entry's bytes come back; the ft_storage_deposit part does not.
        assert_eq!(after, reserved - ft_storage);
        // Top the one-leaf reservation up again for the next attempt.
        e.sender.call(e.zarf.id(), "fund_campaign_storage")
            .args_json(json!({ "campaign_id": id.to_string() }))
            .deposit(NearToken::from_millinear(10))
            .transact().await?.into_result()?;
    }
    // Once the token works again, the same commitment can still be claimed.
    e.ft.call("set_fail").args_json(json!({ "transfers": false, "storage": false }))
        .transact().await?.into_result()?;
    let carol = e.worker.dev_create_account().await?;
    assert!(claim(&e, id, &carol).await?.is_success());
    assert_eq!(ft_balance(&e, &carol).await?, AMOUNT);
    Ok(())
}

#[tokio::test]
async fn claim_succeeds_with_exactly_required_claim_gas() -> anyhow::Result<()> {
    // Sets GAS_CLAIM_MARGIN: if this fails, read the burnt gas from the outcome and raise it.
    let e = setup("release/zarf_near.wasm").await?;
    let id = create(&e, now_ns(&e).await? + HOUR_NS).await?;
    let need: String = e.zarf.view("required_claim_gas").await?.json()?;
    let bob = e.worker.dev_create_account().await?;
    let out = claim_with_gas(&e, id, &bob, Gas::from_gas(need.parse()?)).await?;
    println!("required_claim_gas = {need}, total burnt = {}", out.total_gas_burnt);
    assert!(out.is_success(), "{out:?}");
    assert_eq!(ft_balance(&e, &bob).await?, AMOUNT);
    Ok(())
}

#[tokio::test]
async fn failed_callback_strands_claim_until_owner_resolves_it() -> anyhow::Result<()> {
    let e = setup("callback-panic/zarf_near.wasm").await?;
    let deadline = now_ns(&e).await? + 10 * 1_000_000_000;
    let id = create(&e, deadline).await?;
    let bob = e.worker.dev_create_account().await?;

    let claimed_at = now_ns(&e).await?;
    let out = claim(&e, id, &bob).await?;
    assert!(!out.is_success(), "the callback must have panicked");
    assert_eq!(ft_balance(&e, &bob).await?, AMOUNT, "the transfer itself succeeded");
    assert_eq!(state(&e, id).await?, "pending");
    assert_eq!(campaign(&e, id).await?["in_flight"], AMOUNT.to_string());

    let resolve = |paid: bool| {
        e.owner.call(e.zarf.id(), "resolve_pending").args_json(json!({
            "campaign_id": id.to_string(), "commitment": hex(&COMMITMENT), "paid": paid,
            "evidence": "receipt-id-from-explorer",
        }))
    };
    // Before resolve_delay_ns has passed, the owner cannot settle it.
    let early = resolve(true).transact().await?;
    assert!(format!("{:?}", early.into_result().unwrap_err()).contains("E107_UNAUTHORIZED"));

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

    while now_ns(&e).await? < claimed_at + RESOLVE_DELAY_NS + 2_000_000_000 {
        e.worker.fast_forward(5).await?;
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

#[tokio::test]
async fn adverse_claim_fits_required_claim_gas() -> anyhow::Result<()> {
    // Worst case for claim's own work: a 64-char implicit destination and 20 proof siblings.
    let e = setup("release/zarf_near.wasm").await?;
    let proof: Vec<[u8; 32]> = (0..20u8).map(|i| [i.wrapping_mul(37).wrapping_add(1); 32]).collect();
    let root = proof.iter().fold(leaf(&COMMITMENT, AMOUNT), |h, s| node(&h, s));
    let id = create_with_root(&e, now_ns(&e).await? + HOUR_NS, root).await?;
    let need: String = e.zarf.view("required_claim_gas").await?.json()?;
    let dest = "ab".repeat(32);
    let out = claim_raw(&e, id, &dest, &proof, Gas::from_gas(need.parse()?)).await?;
    println!("adverse: required_claim_gas = {need}, total burnt = {}", out.total_gas_burnt);
    assert!(out.is_success(), "{out:?}");
    let bal: String = e.ft.view("ft_balance_of").args_json(json!({ "account_id": dest })).await?.json()?;
    assert_eq!(bal, AMOUNT.to_string());
    Ok(())
}

const SOURCE: &str = "github.com/yamancan/zarf-on-near@test";
/// Covers a larger wasm's extra code storage (1e19 yocto per byte) with room to spare.
const UPGRADE_DEPOSIT: u128 = 10_000 * 10_000_000_000_000_000_000;

fn code_hash(wasm: &[u8]) -> String {
    hex(&sha(&[wasm]))
}

async fn propose_and_wait(e: &Env, wasm: &[u8]) -> anyhow::Result<()> {
    e.owner.call(e.zarf.id(), "propose_upgrade")
        .args_json(json!({ "code_hash": code_hash(wasm), "source": SOURCE }))
        .transact().await?.into_result()?;
    let pending: Value = e.zarf.view("pending_upgrade").await?.json()?;
    let ready: u64 = pending["ready_at_ns"].as_str().unwrap().parse()?;
    while now_ns(e).await? < ready {
        e.worker.fast_forward(5).await?;
    }
    Ok(())
}

async fn apply(e: &Env, wasm: Vec<u8>) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    apply_with(e, wasm, UPGRADE_DEPOSIT).await
}

async fn apply_with(
    e: &Env,
    wasm: Vec<u8>,
    deposit: u128,
) -> anyhow::Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(e.owner.call(e.zarf.id(), "apply_upgrade").args(wasm)
        .deposit(NearToken::from_yoctonear(deposit)).max_gas().transact().await?)
}

#[tokio::test]
async fn upgrade_through_the_timelock_keeps_campaigns_and_pending_claims() -> anyhow::Result<()> {
    // v1 strands a claim in `pending` (callback-panic build), then v2 replaces it.
    let e = setup("callback-panic/zarf_near.wasm").await?;
    let id = create(&e, now_ns(&e).await? + HOUR_NS).await?;
    let bob = e.worker.dev_create_account().await?;
    assert!(!claim(&e, id, &bob).await?.is_success());
    assert_eq!(state(&e, id).await?, "pending");
    let before = campaign(&e, id).await?;

    let v2 = wasm("upgrade-v2/zarf_near.wasm");
    // Applying before the delay is refused.
    e.owner.call(e.zarf.id(), "propose_upgrade")
        .args_json(json!({ "code_hash": code_hash(&v2), "source": SOURCE })).transact().await?.into_result()?;
    let early = apply(&e, v2.clone()).await?;
    assert!(format!("{:?}", early.into_result().unwrap_err()).contains("E107_UNAUTHORIZED"));
    e.owner.call(e.zarf.id(), "cancel_upgrade").transact().await?.into_result()?;

    propose_and_wait(&e, &v2).await?;
    let wrong = apply(&e, wasm("release/zarf_near.wasm")).await?;
    assert!(format!("{:?}", wrong.into_result().unwrap_err()).contains("E108_INVALID_INPUT"));
    // M3: v2 is larger than v1, so applying it without a deposit fails in migrate (E128) and
    // rolls the deploy back; the proposal stays pending.
    let v1 = wasm("callback-panic/zarf_near.wasm");
    assert!(v2.len() > v1.len(), "the test needs a larger v2 ({} vs {})", v2.len(), v1.len());
    let unpaid = apply_with(&e, v2.clone(), 0).await?;
    assert!(format!("{unpaid:?}").contains("E128_INSUFFICIENT_STORAGE"), "{unpaid:?}");
    assert!(unpaid.logs().iter().any(|l| l.contains("upgrade_failed")));
    assert_eq!(e.zarf.view_code().await?, v1);
    let still: Value = e.zarf.view("pending_upgrade").await?.json()?;
    assert_eq!(still["source"], SOURCE);
    let out = apply(&e, v2.clone()).await?;
    assert!(out.is_success(), "{out:?}");
    assert!(out.logs().iter().any(|l| l.contains("upgrade_applied")));

    let marker: String = e.zarf.view("upgrade_marker").await?.json()?;
    assert_eq!(marker, "v2");
    assert_eq!(e.zarf.view_code().await?, v2);
    let pending: Value = e.zarf.view("pending_upgrade").await?.json()?;
    assert!(pending.is_null());
    // State survived the migration, including the stranded claim.
    assert_eq!(campaign(&e, id).await?, before);
    assert_eq!(state(&e, id).await?, "pending");
    Ok(())
}

#[tokio::test]
async fn failing_migrate_rolls_the_deploy_back() -> anyhow::Result<()> {
    let e = setup("release/zarf_near.wasm").await?;
    let v1 = wasm("release/zarf_near.wasm");
    let bad = wasm("migrate-panic/zarf_near.wasm");
    propose_and_wait(&e, &bad).await?;
    let out = apply(&e, bad.clone()).await?;
    println!("failing migrate: success={} logs={:?}", out.is_success(), out.logs());
    assert!(!out.logs().iter().any(|l| l.contains("upgrade_applied")));
    assert!(out.logs().iter().any(|l| l.contains("upgrade_failed")));
    assert_eq!(e.zarf.view_code().await?, v1, "the old code is still deployed");
    let pending: Value = e.zarf.view("pending_upgrade").await?.json()?;
    assert_eq!(pending["code_hash"], code_hash(&bad), "the proposal stays pending");
    Ok(())
}

#[test]
fn release_wasm_has_no_test_upgrade_features() {
    let release = wasm("release/zarf_near.wasm");
    for (variant, needle) in [("upgrade-v2", &b"upgrade_marker"[..]), ("migrate-panic", &b"TEST_MIGRATE_PANIC"[..])] {
        let has = |w: &[u8]| w.windows(needle.len()).any(|x| x == needle);
        assert!(has(&wasm(&format!("{variant}/zarf_near.wasm"))), "{variant} must carry its marker");
        assert!(!has(&release), "release must not carry {variant}");
    }
}

#[tokio::test]
async fn reapplying_the_same_code_is_harmless() -> anyhow::Result<()> {
    // As after a lost on_upgrade: the same hash is proposed and applied again. migrate is
    // idempotent, and state is untouched.
    let e = setup("release/zarf_near.wasm").await?;
    let id = create(&e, now_ns(&e).await? + HOUR_NS).await?;
    let before = campaign(&e, id).await?;
    let v1 = wasm("release/zarf_near.wasm");
    for _ in 0..2 {
        propose_and_wait(&e, &v1).await?;
        let out = apply_with(&e, v1.clone(), 0).await?;
        assert!(out.is_success(), "{out:?}");
    }
    assert_eq!(e.zarf.view_code().await?, v1);
    assert_eq!(campaign(&e, id).await?, before);
    Ok(())
}

#[tokio::test]
async fn a_callback_scheduled_by_v1_settles_on_v2() -> anyhow::Result<()> {
    // The claim runs on v1; its ft_transfer is slowed by a few blocks, so the upgrade to v2
    // lands before on_claim. on_claim keeps its name and args, so v2 settles it.
    let e = setup("release/zarf_near.wasm").await?;
    let id = create(&e, now_ns(&e).await? + HOUR_NS).await?;
    let v2 = wasm("upgrade-v2/zarf_near.wasm");
    propose_and_wait(&e, &v2).await?;
    e.ft.call("set_slow").args_json(json!({ "hops": 4 })).transact().await?.into_result()?;
    let bob = e.worker.dev_create_account().await?;

    let pending_claim = claim_tx(&e, id, bob.id().as_str(), &[], Gas::from_tgas(300)).await?
        .transact_async().await?;
    let upgrade = apply(&e, v2.clone()).await?;
    assert!(upgrade.is_success(), "{upgrade:?}");
    assert_eq!(e.zarf.view_code().await?, v2);

    let out = pending_claim.await?;
    assert!(out.is_success(), "{out:?}");
    // Ordering, by block height: the claim receipt ran before the deploy, on_claim after it.
    let claim_rx = out.receipt_outcomes().iter().find(|r| r.logs.iter().any(|l| l.contains("claim_started"))).unwrap();
    let paid_rx = out.receipt_outcomes().iter().find(|r| r.logs.iter().any(|l| l.contains("claim_paid"))).unwrap();
    let applied_rx = upgrade.receipt_outcomes().iter().find(|r| r.logs.iter().any(|l| l.contains("upgrade_applied"))).unwrap();
    let (claimed_at, paid_at, applied_at) = (
        height(&e, claim_rx.block_hash).await?,
        height(&e, paid_rx.block_hash).await?,
        height(&e, applied_rx.block_hash).await?,
    );
    println!("claim at {claimed_at}, upgrade applied at {applied_at}, on_claim at {paid_at}");
    assert!(claimed_at < applied_at && applied_at < paid_at, "{claimed_at} < {applied_at} < {paid_at}");
    assert_eq!(state(&e, id).await?, "claimed");
    assert_eq!(ft_balance(&e, &bob).await?, AMOUNT);
    assert_eq!(campaign(&e, id).await?["in_flight"], "0");
    Ok(())
}

async fn height(e: &Env, hash: near_workspaces::CryptoHash) -> anyhow::Result<u64> {
    Ok(e.worker.view_block().block_hash(hash).await?.height())
}
