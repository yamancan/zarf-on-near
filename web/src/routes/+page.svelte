<svelte:head><title>Zarf: pay any email</title></svelte:head>

<h1>Pay any email.</h1>
<p>
  Send USDC to an email address. The recipient opens a link, signs in with Google and receives it. The email never
  goes on chain; our verifier sees it once, to check the claim.
</p>
<p><a class="cta primary" href="https://zarf-near-faucet-testnet.sparkling-queen-5e77.workers.dev/try">Try it with your Gmail</a></p>
<p><a class="cta" href="/create">Send USDC</a></p>
<ol>
  <li>You enter emails and amounts.</li>
  <li>Each person gets a private link.</li>
  <li>They sign in with Google and choose where the USDC goes.</li>
</ol>
<p class="muted"><a href="/campaigns">Your campaigns</a> · NEAR testnet: test funds with no value.</p>

<style>
  .cta {
    display: block;
    padding: 0.75rem 1rem;
    border-radius: 8px;
    border: 1px solid var(--accent);
    color: var(--fg);
    text-align: center;
    text-decoration: none;
  }
  .cta.primary {
    background: var(--accent);
    color: var(--bg);
  }
  ol {
    padding-left: 1.25rem;
  }
</style>
