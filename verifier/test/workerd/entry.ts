// Test-only Worker: runs the spec vectors inside workerd, whose Ed25519/X25519 support differs from Node's.
import v from '../../../spec/vectors.json';
import { commitment, destinationNonce, hex, importSealKey, importVerifierKey, signClaim, unhex, unsealSalt } from '../../src/claim';

export default {
  async fetch(): Promise<Response> {
    const fails: string[] = [];
    for (const r of v.campaign.recipients)
      if (hex(await commitment(unhex(v.campaign.salt), r.email)) !== r.commitment) fails.push(`commitment ${r.email}`);
    const key = await importVerifierKey(v.keys.verifier_seed);
    for (const c of v.claims.valid) {
      if ((await signClaim(key, c.args)) !== c.signature) fails.push(`signature ${c.name}`);
      if ((await destinationNonce(c.args.destination)) !== c.nonce) fails.push(`nonce ${c.name}`);
    }
    const seal = await importSealKey(v.keys.seal_seed);
    if (hex(await unsealSalt(v.campaign.sealed_salt, seal, v.campaign.merkle_root)) !== v.campaign.salt) fails.push('unseal');
    return Response.json({ checked: v.campaign.recipients.length + 2 * v.claims.valid.length + 1, fails });
  },
};
