import type { Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/public';
import { ONECLICK_API } from '$lib/intents';

/** Origins the page may call, from the same config the page uses. An unparsable value is skipped, never a 500. */
export function connectOrigins(urls: (string | undefined)[]): string {
  return urls
    .flatMap((u) => {
      try {
        const { protocol, origin } = new URL(u ?? '');
        return protocol === 'https:' || protocol === 'http:' ? [origin] : [];
      } catch {
        return [];
      }
    })
    .join(' ');
}

export const handle: Handle = async ({ event, resolve }) => {
  const res = await resolve(event);
  const csp = res.headers.get('Content-Security-Policy');
  const extra = connectOrigins([env.PUBLIC_VERIFIER_URL, env.PUBLIC_RELAYER_URL, env.PUBLIC_NEAR_RPC_URL, ONECLICK_API]);
  if (csp && extra) res.headers.set('Content-Security-Policy', csp.replace("connect-src 'self'", `connect-src 'self' ${extra}`));
  // The claim path carries campaign + commitment; never leak it to Google or anyone else.
  res.headers.set('Referrer-Policy', 'no-referrer');
  res.headers.set('X-Content-Type-Options', 'nosniff');
  return res;
};
