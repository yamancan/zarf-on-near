<script lang="ts" module>
  export type ClaimMode = 'existing' | 'new' | 'chain';
</script>

<script lang="ts">
  // The claim card (T-032, owner point 8): one focus. Title and sender, the amount large with the USDC mark, "Send to"
  // as one segmented control with icons, then the Google button. The claim page fills `body` with the choice's own
  // field; /create renders the same card with `preview` as "What They See": inert, nothing in it takes a click.
  import type { Snippet } from 'svelte';
  import { tick } from 'svelte';
  import { Info, ScanFace, UserPlus } from 'lucide-svelte';
  import Avatar from '$lib/Avatar.svelte';
  import GoogleG from '$lib/GoogleG.svelte';
  import Mark from '$lib/Mark.svelte';
  import { MARKS, PAYOUT_CHAINS } from '$lib/chains';
  import Tooltip from '$lib/zarf-kit/components/ui/Tooltip.svelte';
  import ZenButton from '$lib/zarf-kit/components/ui/ZenButton.svelte';

  let {
    title,
    sender,
    left = '',
    deadline = '',
    amount,
    unit,
    modes,
    mode,
    onpick = () => {},
    preview = false,
    ready = false,
    mainnetOnly = false,
    onsignin = () => {},
    body,
    footer,
  }: {
    title: string;
    /** The sender's account; empty shows "From you" (the /create preview before a wallet is connected). */
    sender: string;
    left?: string;
    deadline?: string;
    amount: string;
    unit: string;
    modes: [ClaimMode, string][];
    mode: ClaimMode;
    onpick?: (m: ClaimMode) => void;
    preview?: boolean;
    ready?: boolean;
    /** Other Chain on testnet: the payout runs on mainnet only, so the button says so instead of Google. */
    mainnetOnly?: boolean;
    onsignin?: () => void;
    body?: Snippet;
    footer?: Snippet;
  } = $props();

  const CHAIN_MARKS = PAYOUT_CHAINS.filter((c) => ['base', 'sol', 'arb'].includes(c.key));
  let group = $state<HTMLElement>();

  function key(e: KeyboardEvent) {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!d) return;
    e.preventDefault();
    const i = modes.findIndex(([v]) => v === mode);
    onpick(modes[(i + d + modes.length) % modes.length][0]);
    tick().then(() => group?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus());
  }
</script>

<div class="space-y-8 {preview ? 'select-none cursor-default' : ''}" inert={preview || undefined} aria-hidden={preview || undefined}>
  <div class="min-w-0">
    {#if preview}<div class="text-xl font-semibold">{title}</div>{:else}<h1 class="text-xl font-semibold">{title}</h1>{/if}
    <p class="text-sm text-zen-fg-muted font-light mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
      <span class="inline-flex items-center gap-1.5 min-w-0">{#if sender}<Avatar name={sender} /><span class="font-mono truncate">{sender}</span>{:else}From you{/if}</span>
      <span class="inline-flex items-center gap-1.5 whitespace-nowrap">
        {#if left}<span class="tabular-nums" title={deadline ? `Claim by ${deadline}` : undefined}>{left}</span>{/if}
        {#if !preview}
          <Tooltip text="Never on chain; our verifier sees it once." position="bottom">
            <button type="button" class="inline-flex items-center justify-center w-6 h-6 rounded-full text-zen-fg-subtle hover:text-zen-fg" aria-label="Who sees the email: the email never goes on chain. Our verifier sees it once, to check this claim.">
              <Info class="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </Tooltip>
        {/if}
      </span>
    </p>
  </div>

  <div class="flex items-center gap-3">
    <span class="sr-only">Claim amount</span>
    <Mark svg={MARKS.usdc} class="w-10 h-10" />
    <span class="text-5xl font-semibold tracking-tight text-zen-fg tabular-nums">{amount}</span>
    <span class="text-base text-zen-fg-muted">{unit}</span>
  </div>

  <div class="space-y-3">
    {#if modes.length > 1}
      <span id="dest-q" class="block text-sm text-zen-fg-muted">Send to</span>
      <!-- One segmented control; radiogroup semantics: arrows move, one tab stop -->
      <div bind:this={group} class="grid gap-1 p-1 rounded-[1.25rem] sm:rounded-full bg-zen-fg/5" style="grid-template-columns: repeat({modes.length}, minmax(0, 1fr));" role="radiogroup" aria-labelledby="dest-q" tabindex="-1" onkeydown={key}>
        {#each modes as [value, text] (value)}
          <button
            type="button"
            role="radio"
            aria-checked={mode === value}
            tabindex={mode === value ? 0 : -1}
            data-mode={value}
            onclick={() => onpick(value)}
            class="flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-1.5 min-w-0 h-14 sm:h-11 px-2 rounded-2xl sm:rounded-full text-xs sm:text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zen-fg/40 {mode === value
              ? 'bg-zen-bg text-zen-fg shadow-sm'
              : 'text-zen-fg-muted hover:text-zen-fg'}"
          >
            {#if value === 'existing'}<Mark svg={MARKS.near} class="w-4 h-4" />
            {:else if value === 'new'}{#if text === 'Face ID'}<ScanFace class="w-4 h-4 shrink-0" aria-hidden="true" />{:else}<UserPlus class="w-4 h-4 shrink-0" aria-hidden="true" />{/if}
            {:else}<span class="inline-flex gap-0.5 shrink-0">{#each CHAIN_MARKS as c (c.key)}<Mark svg={c.logo} class="w-4 h-4" />{/each}</span>{/if}
            <span class="truncate">{text}</span>
          </button>
        {/each}
      </div>
    {/if}
    {@render body?.()}
  </div>

  <div class="space-y-3">
    {#if mainnetOnly}
      <ZenButton variant="primary" class="w-full" disabled>Mainnet Only</ZenButton>
    {:else}
      <ZenButton variant="primary" class="google w-full" disabled={preview || !ready} onclick={onsignin}>
        <GoogleG />Sign in with Google
      </ZenButton>
    {/if}
    {@render footer?.()}
  </div>
</div>
