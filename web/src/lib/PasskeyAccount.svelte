<script lang="ts">
  // T-021: opens a passkey account with one Face ID (the key is re-derived, never stored) and shows its balances.
  // `expected`: the claim's destination; another passkey's account is refused. Without it, any passkey account opens.
  import { env } from '$env/dynamic/public';
  import { middle } from '$lib/claim';
  import { formatAmount } from '$lib/create/recipients';
  import { UNIT } from '$lib/network';
  import Note from '$lib/Note.svelte';
  import ZenButton from '$lib/zen/components/ZenButton.svelte';
  import { accountBalances, formatNear, unlockPasskeyAccount } from '$lib/passkey';

  let { expected = '', label = 'Open My Account with Face ID' }: { expected?: string; label?: string } = $props();
  let opened = $state<{ id: string; near: bigint; token: bigint } | null>(null);
  let opening = $state(false);
  let error = $state('');

  async function open() {
    error = '';
    opening = true;
    let id = '';
    try {
      id = (await unlockPasskeyAccount()).accountId;
    } catch {
      error = 'Face ID was cancelled, or this browser cannot open the passkey. Try again.';
      opening = false;
      return;
    }
    if (expected && id !== expected) {
      error = `That passkey opens another account (${middle(id, 8)}). Pick the one you made for this claim.`;
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
</script>

{#if opened}
  <div class="w-full rounded-2xl border border-zen-border-subtle p-4 text-sm text-left space-y-1" role="status">
    <p class="text-zen-fg-muted">Your account <span class="font-mono text-zen-fg" title={opened.id}>{middle(opened.id, 8)}</span></p>
    <p class="font-medium">{formatAmount(opened.token)} {UNIT} · {formatNear(opened.near)} NEAR</p>
  </div>
{:else}
  <ZenButton variant="secondary" class="w-full" disabled={opening} onclick={open}>{label}</ZenButton>
  {#if error}<Note tone="error">{error}</Note>{/if}
{/if}
