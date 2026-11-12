import type { Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/public';
import { ONECLICK_API } from '$lib/intents';
import { DOH_ORIGIN } from '$lib/create/googleSignIn';


/** The sender pages load wallet code (NEAR Connect); the claim pages never do, so their CSP stays narrow. */
export const isSenderPage = (path: string) => /^\/(create|campaigns)(\/|$)/.test(path);

/**
 * Sender pages run NEAR Connect: each wallet's code and UI live in a sandboxed srcdoc iframe (opaque origin, no
 * access to this page), which inherits this CSP and loads its own styles, fonts, images, frames and APIs from
 * hosts the wallets choose. Those directives open to https on these pages only. script-src does not change:
 * only our own scripts and nonce'd inline scripts run, so nothing new can read the page's emails or salts.
 */
export function senderPolicy(csp: string): string {
  const open = (name: string, add: string) => {
    const re = new RegExp(`(^|;\\s*)${name} ([^;]*)`);
    return (p: string) => (re.test(p) ? p.replace(re, (_, pre, v) => `${pre}${name} ${v} ${add}`) : `${p}; ${name} 'self' ${add}`);
  };
  // DOH_ORIGIN is named on its own so the recipient-domain check survives if https: is ever narrowed.
  return [open('connect-src', `${DOH_ORIGIN} https: wss:`), open('img-src', 'https:'), open('style-src', 'https:'), open('font-src', 'https: data:'), open('frame-src', 'https:')]
    .reduce((p, f) => f(p), csp);
}

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
  let policy = csp && extra ? csp.replace("connect-src 'self'", `connect-src 'self' ${extra}`) : csp;
  if (policy && isSenderPage(event.url.pathname)) policy = senderPolicy(policy);
  if (policy) res.headers.set('Content-Security-Policy', policy);
  // The claim path carries campaign + commitment; never leak it to Google or anyone else.
  res.headers.set('Referrer-Policy', 'no-referrer');
  res.headers.set('X-Content-Type-Options', 'nosniff');
  return res;
};
