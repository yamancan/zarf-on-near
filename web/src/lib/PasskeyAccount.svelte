<script lang="ts">
  // T-021: opens a passkey account with one Face ID (the key is re-derived, never stored) and shows its balances.
  // `expected`: the claim's destination; another passkey's account is refused. Without it, any passkey account opens.
  import { env } from '$env/dynamic/public';
  import { middle } from '$lib/claim';
  import { formatAmount } from '$lib/create/recipients';
  import { UNIT } from '$lib/network';
  import Note from '$lib/Note.svelte';
  import ZenButton from '$lib/zarf-kit/components/ui/ZenButton.svelte';
  import { accountBalances, formatNear, unlockPasskeyAccount } from '$lib/passkey';
  import { keyFile, type ImplicitAccount } from '$lib/implicit';

  let { expected = '', label = 'Open My Account with Face ID' }: { expected?: string; label?: string } = $props();
  let opened = $state<{ id: string; near: bigint; token: bigint } | null>(null);
  let unlocked = $state.raw<ImplicitAccount | null>(null); // the re-derived key, kept only for "Download Key" (B5)
  let saved = $state(false);
  let opening = $state(false);
  let error = $state('');

  async function open() {
    error = '';
    opening = true;
    let id = '';
    try {
      unlocked = await unlockPasskeyAccount();
      id = unlocked.accountId;
    } catch {
      error = 'Face ID was cancelled, or this browser cannot open the passkey. Try again.';
      opening = false;
      return;
    }
    if (expected && id !== expected) {
      error = `That passkey opens another account (${middle(id, 8)}). Pick the one you made for this claim.`;
      unlocked = null;
      opening = false;
      return;
    }
    try {
      opened = { id, ...(await accountBalances(env.PUBLIC_NEAR_RPC_URL ?? '', env.PUBLIC_TOKEN_ID ?? '', id)) };
    } catch {
      opened = null;
      error = `Account ${middle(id, 8)} is open, but its balance could not be read. Try again in a moment.`;
    } finally {
      opening = false;
    }
  }

  // The same key file as the claim page's key-file fallback (implicit.ts keyFile), for a NEAR wallet to import.
  function download() {
    const url = URL.createObjectURL(new Blob([keyFile(unlocked!)], { type: 'application/json' }));
    Object.assign(document.createElement('a'), { href: url, download: `${unlocked!.accountId}.json` }).click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    saved = true;
  }
</script>

{#if opened}
  <!-- A plain row under a hairline, no box (T-023 waste list item 8); then the key, for a NEAR wallet (B5) -->
  <div class="w-full pt-4 border-t border-zen-border-subtle text-sm text-left flex flex-col items-start gap-2" role="status">
    <p class="text-zen-fg-muted">Your account <span class="font-mono text-zen-fg" title={opened.id}>{middle(opened.id, 6)}</span></p>
    <p class="font-medium">{formatAmount(opened.token)} {UNIT} · {formatNear(opened.near)} NEAR</p>
    {#if unlocked}
      <ZenButton variant="secondary" size="sm" onclick={download}>{saved ? 'Key Saved' : 'Download Key'}</ZenButton>
      <p class="text-xs text-zen-fg-subtle">Without this key or your passkey, the USDC cannot be moved.</p>
    {/if}
  </div>
{:else}
  <ZenButton variant="secondary" class="w-full" disabled={opening} onclick={open}>{label}</ZenButton>
  {#if error}<Note tone="error">{error}</Note>{/if}
{/if}
