<svelte:head><title>Privacy and terms · Zarf</title></svelte:head>

<article class="prose-zarf w-full max-w-2xl mx-auto px-4 sm:px-6 py-8 md:py-12">
<header class="mb-10 space-y-2">
  <h1 class="text-2xl md:text-3xl font-light tracking-tight">Privacy and terms</h1>
  <p class="text-sm md:text-base text-zen-fg-muted font-light">Operated by Trion Labs. Contact: [CONTACT EMAIL].</p>
</header>

<h2>Your email</h2>
<p>
  When you claim, you sign in with Google. Our verifier receives your email address from Google, checks that it
  matches your claim link, and signs the claim. It processes the email only at that moment and never stores it.
  Your email never goes on chain.
</p>
<p>
  The judge page (<code>/try</code>) uses the email you type only to create your test claim link. For its daily
  limits it keeps counters keyed by an irreversible HMAC of the email and of your IP address, never either one
  in the clear.
</p>
<p>
  We ask Google only for <code>openid</code> and <code>email</code>. We use no analytics. The judge page loads
  Cloudflare Turnstile, a human check, from challenges.cloudflare.com; the claim and send pages load no third-party
  scripts.
</p>

<h2>Cross-chain payouts</h2>
<p>
  If you choose USDC on another chain, your destination address and the amount go to NEAR Intents 1Click, a third-party
  swap service, which also sees your IP address. 1Click's status for the deposit address of your payout is public, so
  anyone who knows that address can link the claim to your destination address.
</p>

<h2>Testnet only</h2>
<p>This service runs on NEAR testnet. The tokens are test funds with no value.</p>

<h2>No warranty</h2>
<p>
  The service is provided "as is", without warranty of any kind. To the extent the law allows, we are not liable
  for any loss from using it.
</p>

<h2>Contact</h2>
<p>[CONTACT EMAIL]</p>
</article>

<style>
  .prose-zarf :global(h2) {
    font-size: 1rem;
    font-weight: 600;
    margin: 2.5rem 0 0.75rem;
  }
  .prose-zarf :global(p) {
    font-size: 0.9375rem;
    line-height: 1.7;
    color: var(--zen-fg-muted);
    margin: 0 0 1rem;
  }
</style>
