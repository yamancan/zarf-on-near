<script lang="ts">
  let { children } = $props();
</script>

<main>{@render children()}</main>
<footer class="muted"><a href="/privacy">Privacy and terms</a></footer>

<style>
  :global(:root) {
    --bg: #fafaf9;
    --fg: #1c1917;
    --muted: #78716c;
    --line: #d6d3d1;
    --accent: #1c1917;
    --danger: #b91c1c;
    color-scheme: light dark;
  }
  @media (prefers-color-scheme: dark) {
    :global(:root) {
      --bg: #0c0a09;
      --fg: #f5f5f4;
      --muted: #a8a29e;
      --line: #44403c;
      --accent: #f5f5f4;
      --danger: #f87171;
    }
  }
  :global(body) {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font: 16px/1.5 system-ui, sans-serif;
  }
  main {
    max-width: 28rem;
    margin: 0 auto;
    padding: 2rem 16px;
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
