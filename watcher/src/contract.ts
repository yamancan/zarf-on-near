// The escrow's watch() view (contract/src/lib.rs WatchView) and what in it must page someone.

export interface WatchView {
  pending_upgrade: { code_hash: string; source: string; ready_at_ns: string; applying?: boolean } | null;
  pending_owner: { new_owner: string; ready_at_ns: string } | null;
  frozen_until_ns: string;
  owner_keys: { signer: string; active_from_ns: string; valid_until_ns: string }[];
}

export interface ContractExpect {
  owner: string;
  /** Hex ed25519 keys of our verifier(s), as watch().owner_keys lists them. */
  signers: string[];
}

export const nsToIso = (ns: string): string => new Date(Number(BigInt(ns) / 1_000_000n)).toISOString();

/** Every line is a reason to page: a proposal waits only upgrade_delay_ns (10 min testnet, 1 h mainnet). */
export function contractFindings(w: WatchView, owner: string, ex: ContractExpect): string[] {
  const f: string[] = [];
  const u = w.pending_upgrade;
  if (u) {
    f.push(`UPGRADE PROPOSED: code sha256 ${u.code_hash}, source "${u.source}", can be applied from ${nsToIso(u.ready_at_ns)}${u.applying ? ' (BEING APPLIED NOW)' : ''}`);
  }
  if (w.pending_owner) f.push(`OWNER CHANGE PROPOSED: ${w.pending_owner.new_owner}, can be accepted from ${nsToIso(w.pending_owner.ready_at_ns)}`);
  if (owner !== ex.owner) f.push(`OWNER CHANGED: ${owner} (expected ${ex.owner})`);
  const live = new Set(w.owner_keys.map((k) => k.signer));
  for (const k of w.owner_keys) {
    if (!ex.signers.includes(k.signer)) f.push(`VERIFIER KEY ADDED: ${k.signer}, signs from ${nsToIso(k.active_from_ns)}`);
  }
  for (const s of ex.signers) if (!live.has(s)) f.push(`VERIFIER KEY REMOVED: ${s}`);
  return f;
}

/** What view_account and view_access_key_list say about the escrow account itself (blue-team B2). */
export interface AccountView {
  code_hash: string;
  keys: { public_key: string; access_key: { permission: unknown } }[];
}

/**
 * Read from the protocol, not from the contract: a deployed upgrade whose watch() still shows the old values,
 * or a key that could deploy code without the timelock, pages here even if the escrow's own views say nothing.
 */
export function accountFindings(a: AccountView, expectedCodeHash: string): string[] {
  const f: string[] = [];
  if (a.code_hash !== expectedCodeHash) f.push(`CODE HASH CHANGED: ${a.code_hash} (expected ${expectedCodeHash})`);
  for (const k of a.keys) {
    const p = k.access_key.permission;
    f.push(`ACCESS KEY ON THE ESCROW: ${k.public_key} (${p === 'FullAccess' ? 'full access' : 'function call'})`);
  }
  return f;
}
