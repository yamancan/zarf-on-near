<script lang="ts">
  import { page } from '$app/state';
  import { loadAttempt, signedIn } from '$lib/claim';

  const attempt = loadAttempt();
  const ok =
    !!signedIn.idToken && attempt?.campaign === page.params.campaign && attempt?.commitment === page.params.commitment;
</script>

{#if !ok || !attempt}
  <h1>Nothing to show yet</h1>
  <p class="muted">Open your claim link to start.</p>
{:else}
  <h1>Signed in</h1>
  <p>Destination: <code>{attempt.destination}</code></p>
  <p class="muted">
    Next (not built yet): the verifier checks your sign-in, the relayer submits the claim, and the transaction link
    appears here.
  </p>
{/if}
