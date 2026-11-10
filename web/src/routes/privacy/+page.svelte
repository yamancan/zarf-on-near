<svelte:head><title>Privacy and terms · Zarf</title></svelte:head>

<h1>Privacy and terms</h1>
<p class="muted">Operated by Trion Labs. Contact: [CONTACT EMAIL].</p>

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

<style>
  h2 {
    font-size: 1.1rem;
    margin: 1.5rem 0 0.5rem;
  }
</style>
