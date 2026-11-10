<script lang="ts">
  import ZarfMark from '$lib/ZarfMark.svelte';
  let { children } = $props();
</script>

<header><a class="brand" href="/" aria-label="Zarf home"><ZarfMark /><span>Zarf</span></a></header>
<main>{@render children()}</main>
<footer class="muted"><a href="/privacy">Privacy and terms</a></footer>

<style>
  :global(:root) {
    /* Paper Porcelain (light): Soot text on paper; Glass Porcelain (dark): Porcelain on fume. */
    --bg: #f8f8fa;
    --fg: #0b0a13;
    --muted: #78716c;
    --line: #8a8580; /* form borders: 3:1 or more on the page (WCAG 1.4.11) */
    --accent: #0b0a13;
    --danger: #b91c1c;
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :global(:root) {
      --bg: #0a0a0b;
      --fg: #dcdde5;
      --muted: #a8a29e;
      --line: #78716c;
      --accent: #dcdde5;
      --danger: #f87171;
    }
  }
  :global(body) {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font: 16px/1.5 system-ui, sans-serif;
  }
  header {
    max-width: 28rem;
    margin: 0 auto;
    padding: 1.25rem 16px 0;
  }
  .brand {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    text-decoration: none;
    font: 600 1.05rem/1 'Saira', ui-sans-serif, system-ui, sans-serif;
    letter-spacing: -0.02em;
  }
  :global(a) { color: var(--fg); }
  :global(h1), :global(h2), :global(h3) { font-family: 'Saira', ui-sans-serif, system-ui, sans-serif; font-weight: 600; letter-spacing: -0.01em; }
  main {
    max-width: 28rem;
    margin: 0 auto;
    padding: 1.5rem 16px 2rem;
  }
  footer {
    max-width: 28rem;
    margin: 0 auto;
    padding: 0 16px 2rem;
  }
  :global(h1) { font-size: 1.5rem; margin: 0 0 0.25rem; }
  :global(h2) { font-size: 1.1rem; margin: 1.5rem 0 0.5rem; }
  :global(.muted) { color: var(--muted); font-size: 0.875rem; }
  :global(.error) { color: var(--danger); }
  :global(:focus-visible) { outline: 2px solid var(--fg); outline-offset: 2px; }
  :global(code) { word-break: break-all; }
  :global(input[type='text']) {
    width: 100%;
    box-sizing: border-box;
    padding: 0.75rem;
    font: inherit;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: transparent;
    color: inherit;
  }
  :global(button) {
    padding: 0.75rem 1rem;
    font: inherit;
    border-radius: 8px;
    border: 1px solid var(--accent);
    background: transparent;
    color: var(--fg);
    cursor: pointer;
  }
  :global(button.primary) { background: var(--accent); color: var(--bg); width: 100%; }
  :global(button:disabled) { opacity: 0.4; cursor: not-allowed; }
</style>
