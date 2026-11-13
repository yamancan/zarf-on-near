<script lang="ts">
  // Landing: the Zarf landing page (main repo apps/landing/src/routes/+page.svelte) with one grain layer, the hero (the
  // one call-to-action pair) and How It Works. Zarf's final CTA section is left out: it repeated the hero's buttons.
  import Hero from '$lib/Hero.svelte';
  import HowItWorks from '$lib/landing/HowItWorks.svelte';

  const TRY_URL = 'https://near.zarf.to/try';
</script>

<svelte:head><title>Zarf: Send Tokens to an Email</title></svelte:head>

<!-- main repo apps/landing +page.svelte:64-68: a fixed ground behind everything, one grain layer above it -->
<div class="fixed inset-0 bg-base-100 -z-10" aria-hidden="true"></div>
<div class="landing-grain fixed inset-0 pointer-events-none z-[25]" aria-hidden="true"></div>

<!-- Content lifted above the grain (main repo +page.svelte:128) -->
<div class="relative z-30">
  <Hero tryUrl={TRY_URL} />
  <HowItWorks />
</div>
