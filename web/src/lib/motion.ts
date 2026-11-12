// Design spec G5: card and step swaps fade (300 ms) and fly in from y -16 (500 ms), as the main claim app's
// ClaimStep5Submit; nothing moves under prefers-reduced-motion.
import { fly, scale } from 'svelte/transition';

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

export const swapIn = (node: Element) => fly(node, { y: -16, duration: reduced() ? 0 : 500, opacity: 0 });
/** Success mark: scale from 0.95 over 500 ms. */
export const markIn = (node: Element) => scale(node, { start: 0.95, duration: reduced() ? 0 : 500 });
