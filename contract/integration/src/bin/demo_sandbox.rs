//! `make -C contract demo-sandbox`: a local NEAR sandbox seeded for `make demo`.
//!
//! Test-only. The sandbox, its accounts and keys never touch a real network; the verifier
//! key it registers is spec/vectors.json `keys.signer`, a public test key.
//!
//! Deploys mock-ft and the escrow (deploy + `new` batched), reads the token's storage
//! bounds, registers the vector signer, creates a relayer with a claim-only function-call
//! key, funds the `DEMO_VECTOR_CAMPAIGN` campaign from the vectors, prints the env block
//! scripts/demo.mjs reads, and keeps the sandbox alive until SIGINT/SIGTERM.

use near_workspaces::operations::Function;
use near_workspaces::types::{AccessKey, Gas, KeyType, NearToken, SecretKey};
use serde_json::{json, Value};
use tokio::signal::unix::{signal, SignalKind};

const WASM_DIR: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../target/near");
const VECTORS: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/../../spec/vectors.json"));
const DAY_NS: u64 = 86_400 * 1_000_000_000;
const MIN_LIFETIME_NS: u64 = 600 * 1_000_000_000; // testnet value (spec)
const AGENT_TTL_NS: u64 = 7 * DAY_NS;

fn wasm(name: &str) -> anyhow::Result<Vec<u8>> {
    let path = format!("{WASM_DIR}/{name}");
    std::fs::read(&path).map_err(|e| anyhow::anyhow!("{path}: {e} (run `make wasm` in contract/)"))
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let vectors: Value = serde_json::from_str(VECTORS)?;
    let which = std::env::var("DEMO_VECTOR_CAMPAIGN").unwrap_or_else(|_| "single".into());
    let campaign = &vectors["campaigns"][&which];
    anyhow::ensure!(campaign.is_object(), "no vector campaign {which:?}");
    let leaves = campaign["recipients"].as_array().unwrap();
    let total: u128 = leaves.iter().map(|r| r["amount"].as_str().unwrap().parse::<u128>().unwrap()).sum();

    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let sub = |name: &'static str, near: u128| {
        let root = root.clone();
        async move {
            anyhow::Ok(root.create_subaccount(name).initial_balance(NearToken::from_near(near))
                .transact().await?.into_result()?)
        }
    };
    let escrow = sub("zarf", 50).await?;
    let ft = sub("usdc", 20).await?;
    let owner = sub("owner", 10).await?;
    let sender = sub("sender", 20).await?;
    let relayer = sub("relayer", 10).await?;
    let destination = sub("alice", 5).await?;

    ft.batch(ft.id())
        .deploy(&wasm("mock-ft/mock_ft.wasm")?)
        .call(Function::new("new").args_json(json!({ "owner_id": sender.id(), "total_supply": total.to_string() })))
        .transact().await?.into_result()?;
    // Deploy and `new` in one transaction: nobody can initialise the escrow first.
    escrow.batch(escrow.id())
        .deploy(&wasm("release/zarf_near.wasm")?)
        .call(Function::new("new").args_json(json!({
            "owner_id": owner.id(), "network": "testnet", "token_ids": [ft.id()],
            "min_lifetime_ns": MIN_LIFETIME_NS.to_string(), "agent_ttl_ns": AGENT_TTL_NS.to_string(),
        })).gas(Gas::from_tgas(100)))
        .transact().await?.into_result()?;

    owner.call(escrow.id(), "refresh_token_storage")
        .args_json(json!({ "token_id": ft.id() })).max_gas()
        .transact().await?.into_result()?;
    let now = worker.view_block().await?.timestamp();
    let deadline = now + DAY_NS;
    owner.call(escrow.id(), "add_owner_key")
        .args_json(json!({ "signer": vectors["keys"]["signer"], "valid_until_ns": (deadline + 30 * DAY_NS).to_string() }))
        .transact().await?.into_result()?;

    // Claim-only relayer key: it can call `claim` on the escrow and attach no deposit.
    let relayer_key = SecretKey::from_random(KeyType::ED25519);
    relayer.batch(relayer.id())
        .add_key(relayer_key.public_key(), AccessKey::function_call_access(escrow.id(), &["claim"], None))
        .transact().await?.into_result()?;

    sender.call(ft.id(), "storage_deposit")
        .args_json(json!({ "account_id": escrow.id() })).deposit(NearToken::from_millinear(10))
        .transact().await?.into_result()?;
    sender.call(escrow.id(), "prepay_deposit")
        .args_json(json!({})).deposit(NearToken::from_near(1))
        .transact().await?.into_result()?;
    let msg = json!({
        "merkle_root": campaign["merkle_root"], "deadline_ns": deadline.to_string(),
        "policy": "owner", "leaf_count": leaves.len(),
    });
    let out = sender.call(ft.id(), "ft_transfer_call")
        .args_json(json!({ "receiver_id": escrow.id(), "amount": total.to_string(), "msg": msg.to_string() }))
        .deposit(NearToken::from_yoctonear(1)).max_gas()
        .transact().await?;
    let created = out.logs().into_iter().find(|l| l.contains("campaign_created"))
        .ok_or_else(|| anyhow::anyhow!("campaign not created: {out:?}"))?.to_string();
    let event: Value = serde_json::from_str(created.trim_start_matches("EVENT_JSON:"))?;
    let campaign_id = event["data"][0]["campaign_id"].as_str().unwrap().to_string();

    println!("# zarf demo sandbox (test-only keys; never use on a real network)");
    println!("export NEAR_RPC_URL={}", worker.rpc_addr());
    println!("export CONTRACT_ID={}", escrow.id());
    println!("export NETWORK=testnet");
    println!("export RELAYER_ACCOUNT_ID={}", relayer.id());
    println!("export RELAYER_KEY={relayer_key}");
    println!("export DEMO_CAMPAIGN_ID={campaign_id}");
    println!("export DEMO_VECTOR_CAMPAIGN={which}");
    println!("export DEMO_DESTINATION={}", destination.id());
    println!("# sandbox running; Ctrl-C or SIGTERM stops it");

    // Returning drops the worker, which stops the sandbox process.
    let mut term = signal(SignalKind::terminate())?;
    tokio::select! {
        _ = tokio::signal::ctrl_c() => {}
        _ = term.recv() => {}
    }
    Ok(())
}
