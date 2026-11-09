// Test-only Worker: runs the spec vectors inside workerd, whose Ed25519 support differs from Node's.
import v from '../../../spec/vectors.json';
import { claimPayload, commitment, destinationNonce, hex, importSigner, signClaim, unhex } from '../../src/claim';

export default {
  async fetch(): Promise<Response> {
    const fails: string[] = [];
    let checked = 0;
    for (const r of Object.values(v.campaigns).flatMap((c) => c.recipients)) {
      checked++;
      if (hex(await commitment(unhex(r.salt), r.email)) !== r.commitment) fails.push(`commitment ${r.email}`);
    }
    const { key, signer } = await importSigner(v.keys.signer_seed);
    if (signer !== v.keys.signer) fails.push('signer');
    for (const c of v.claims.valid) {
      checked += 2;
      const args = { network: v.context.network, contract_id: v.context.contract_id, ...c.call_args };
      if (hex(claimPayload(args)) !== c.payload || (await signClaim(key, args)) !== c.call_args.signature) fails.push(`signature ${c.name}`);
      if ((await destinationNonce(c.call_args.destination)) !== c.nonce) fails.push(`nonce ${c.name}`);
    }
    return Response.json({ checked, fails });
  },
};
