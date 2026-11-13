<script lang="ts">
  // How It Works, the steps alone (T-023 waste list items 1 and 14): Zarf's step type and indicator from
  // web/packages/ui/lib/components/landing/HowItWorks.svelte, without its mock scenes and its 350vh sticky scroll runway.
  const STEPS = [
    { title: 'Add Emails and Amounts', desc: 'Pay once in USDC. Each person gets one private claim link.' },
    { title: 'They Claim with Google', desc: 'No gas and no seed phrase. Zarf pays the network fee.' },
    { title: 'USDC Arrives', desc: 'In their own account. What nobody claims by the deadline comes back to you.' },
  ];
</script>

<section class="py-24" aria-label="How it works">
  <ol class="container mx-auto px-6 max-w-6xl grid md:grid-cols-3 gap-12 md:gap-16">
    {#each STEPS as step, i (step.title)}
      <li>
        <div class="flex items-center gap-1.5 mb-6" aria-hidden="true">
          <span class="font-mono text-[10px] font-medium text-base-content/70">0{i + 1}</span>
          <div class="h-0.5 w-6 rounded-full bg-base-content/50"></div>
        </div>
        <h2 class="text-2xl font-semibold mb-3 tracking-tight text-base-content">{step.title}</h2>
        <p class="text-sm md:text-base leading-relaxed text-zen-fg-muted max-w-md">{step.desc}</p>
      </li>
    {/each}
  </ol>
</section>
