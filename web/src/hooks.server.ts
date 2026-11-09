import type { Handle } from '@sveltejs/kit';

export const handle: Handle = async ({ event, resolve }) => {
  const res = await resolve(event);
  // The claim path carries campaign + commitment; never leak it to Google or anyone else.
  res.headers.set('Referrer-Policy', 'no-referrer');
  res.headers.set('X-Content-Type-Options', 'nosniff');
  return res;
};
