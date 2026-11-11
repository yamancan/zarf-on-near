<script lang="ts">
  import PageHeader from '$lib/zen/components/PageHeader.svelte';
</script>

<svelte:head><title>Privacy and terms · Zarf</title></svelte:head>

<article class="prose-zarf w-full max-w-xl mx-auto px-6 py-8 md:py-12">
<PageHeader title="Privacy and terms" description="Operated by Trion Labs. Contact: [CONTACT EMAIL]." />

<h2>Your email</h2>
<p>
  When you claim, you sign in with Google. Our verifier receives your email address from Google, checks that it
  matches your claim link, and signs the claim. It processes the email only at that moment and never stores it.
  Your email never goes on chain.
</p>
<p>
  The <a href="https://zarf-near-faucet-testnet.sparkling-queen-5e77.workers.dev/try" class="underline underline-offset-2 hover:text-zen-fg">test page</a>
  uses the email you type only to create your test claim link. For its daily limits it keeps counters keyed by a
  keyed hash of the email and of your IP address, never either one in the clear.
</p>
<p>
  We ask Google only for <code>openid</code> and <code>email</code>. We use no analytics. The test page loads
  Cloudflare Turnstile, a human check, from challenges.cloudflare.com; the claim and send pages load no third-party
  scripts.
</p>

<h2>Cross-chain payouts</h2>
<p>
  If you choose USDC on another chain, your destination address and the amount go to NEAR Intents 1Click, a third-party
  swap service, which also sees your IP address. 1Click's status for the deposit address of your payout is public, so
  anyone who knows that address can link the claim to your destination address. If the bridge does not complete a
  payout by its deadline, it refunds the sender on NEAR, not your address.
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
