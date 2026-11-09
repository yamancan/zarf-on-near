import type { Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/public';

/** Origins the page may call, taken from the same config the page uses. */
function connectOrigins(): string {
  return [env.PUBLIC_VERIFIER_URL, env.PUBLIC_RELAYER_URL, env.PUBLIC_NEAR_RPC_URL, env.PUBLIC_LEAVES_URL]
    .filter((u): u is string => !!u)
    .map((u) => new URL(u).origin)
    .join(' ');
}

export const handle: Handle = async ({ event, resolve }) => {
  const res = await resolve(event);
  const csp = res.headers.get('Content-Security-Policy');
  const extra = connectOrigins();
  if (csp && extra) res.headers.set('Content-Security-Policy', csp.replace("connect-src 'self'", `connect-src 'self' ${extra}`));
  // The claim path carries campaign + commitment; never leak it to Google or anyone else.
  res.headers.set('Referrer-Policy', 'no-referrer');
  res.headers.set('X-Content-Type-Options', 'nosniff');
  return res;
};
