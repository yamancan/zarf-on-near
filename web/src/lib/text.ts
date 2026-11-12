// Design spec G1: Title Case (Chicago), small words lower-case unless first or last.
const SMALL = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'via']);
export const titleCase = (s: string): string =>
  s.split(' ').map((w, i, all) => (i > 0 && i < all.length - 1 && SMALL.has(w.toLowerCase()) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');

/** The wordmark names the domain only where the page is served from it: "zarf.to" on workers.dev reads as phishing (red-team UX #5). */
export const brandName = (hostname: string): string => (/(^|\.)zarf\.to$/i.test(hostname) ? 'zarf.to' : 'Zarf');
