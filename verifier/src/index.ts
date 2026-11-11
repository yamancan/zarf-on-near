// Release entry. It accepts Google-issued tokens only; the demo issuer lives in src/demo.ts,
// which this file never imports (test/demo.test.ts checks the built bundle).
import { GOOGLE_JWKS_URL, remoteJwks } from './jwks';
import { makeVerifier } from './worker';

export default makeVerifier({ jwks: remoteJwks(GOOGLE_JWKS_URL) });
