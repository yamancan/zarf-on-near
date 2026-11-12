// Design spec G1: Title Case (Chicago), small words lower-case unless first or last.
const SMALL = new Set(['a', 'an', 'the', 'and', 'or', 'but', 'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'via']);
export const titleCase = (s: string): string =>
  s.split(' ').map((w, i, all) => (i > 0 && i < all.length - 1 && SMALL.has(w.toLowerCase()) ? w.toLowerCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(' ');
