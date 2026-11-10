<script lang="ts">
  import { page } from '$app/state';
</script>

<svelte:head><title>Not found · Zarf</title></svelte:head>

{#if page.status === 404}
  <h1>This page does not exist</h1>
  <p>If you followed a claim link, open it again from the message you received, in full.</p>
{:else}
  <h1>Something went wrong</h1>
  <p>Try again in a minute. If you followed a claim link, open it again from the message you received.</p>
{/if}
<p><a href="/">What is Zarf?</a></p>
