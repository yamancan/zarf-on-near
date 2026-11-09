/** A dependency we read from (Google's JWKS or the chain) failed. Carries only which one: never request data. */
export class UpstreamError extends Error {
  constructor(readonly source: 'jwks' | 'chain') {
    super(`upstream unavailable: ${source}`);
  }
}
