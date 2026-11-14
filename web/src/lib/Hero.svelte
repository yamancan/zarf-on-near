<script lang="ts">
  // Ported from the main repo's landing hero (packages/ui/lib/components/landing/Hero.svelte): the ring
  // spotlight, the hash canvas, the 16 px blur that clears the text, the staggered reveal and the status line,
  // with the same values. Differences: the headline is the core line (no rotating word), the hashes are NEAR
  // style (hex) instead of Stellar strkeys, the eyebrow is "Built for NEAR Hackathon" in the "Built on Stellar"
  // lockup's shape (T-040), the CTAs are this app's, and (design spec 3.5) the hero is its content plus py-24/32
  // with no 90vh minimum and no scroll cue. The landing names no testnet except CTA 2 (owner, T-040).
  import { onMount } from 'svelte';
  import Mark from '$lib/Mark.svelte';
  import { MARKS, PAYOUT_CHAINS } from '$lib/chains';
  import { TESTNET, UNAUDITED_LINE } from '$lib/network';
  import { themeStore } from '$lib/zarf-kit/stores/themeStore.svelte';
  import ZenBadge from '$lib/zarf-kit/components/ui/ZenBadge.svelte';
  import ZenButton from '$lib/zarf-kit/components/ui/ZenButton.svelte';

  let { tryUrl }: { tryUrl: string } = $props();

  let canvas: HTMLCanvasElement;
  let container: HTMLDivElement;
  let ctx: CanvasRenderingContext2D | null = null;
  let animationId = 0;
  let width = 0;
  let height = 0;
  let mounted = $state(false);

  const GRID_SPACING = 100;
  const REVEAL_RADIUS = 200;
  const HIDDEN_DATA = ['Private Claim'];

  let mouse = { x: -999, y: -999 };

  // "any chain" (owner, T-040): five chain marks take turns in the headline, the main repo hero's rotating slot
  // (stacked grid cell, fade + blur, 2.6 s). Stellar is the owner's explicit choice although this app pays no Stellar
  // address; the rest are payout chains (lib/chains.ts). The words carry the meaning; the marks are aria-hidden.
  const payoutLogo = (key: string) => PAYOUT_CHAINS.find((c) => c.key === key)!.logo;
  const STELLAR = '<svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 24 24"><path d="M12.003 1.716c-1.37 0-2.7.27-3.948.78A10.18 10.18 0 0 0 2.66 7.901a10.136 10.136 0 0 0-.797 3.954c0 .258.01.516.027.775a1.942 1.942 0 0 1-1.055 1.88L0 14.934v1.902l2.463-1.26.072-.032v.005l.77-.39.758-.385.066-.039 14.807-7.56 1.666-.847 3.392-1.732V2.694L17.792 5.86 3.744 13.025l-.104.055-.017-.115a8.286 8.286 0 0 1-.071-1.105c0-2.255.88-4.377 2.474-5.977a8.462 8.462 0 0 1 2.71-1.820 8.513 8.513 0 0 1 3.2-.654h.067a8.41 8.41 0 0 1 4.09 1.055l1.628-.83.126-.066a10.11 10.11 0 0 0-5.845-1.853zM24 7.143 5.047 16.808l-1.666.847L0 19.382v1.902l3.282-1.671 2.91-1.485 14.058-7.153.105-.055.016.115c.05.369.072.743.072 1.11 0 2.255-.88 4.383-2.475 5.978a8.461 8.461 0 0 1-2.71 1.82 8.305 8.305 0 0 1-3.2.654h-.06c-1.441 0-2.86-.369-4.102-1.061l-.066.033-1.683.857c.594.418 1.232.776 1.903 1.062a10.11 10.11 0 0 0 3.947.797 10.09 10.09 0 0 0 7.17-2.975 10.136 10.136 0 0 0 2.969-7.18c0-.259-.005-.523-.027-.781a1.942 1.942 0 0 1 1.055-1.88L24 9.044z"/></svg>';
  const CHAIN_LOOP = [
    { name: 'Stellar', svg: STELLAR },
    { name: 'Base', svg: payoutLogo('base') },
    { name: 'Ethereum', svg: payoutLogo('eth') },
    { name: 'Solana', svg: payoutLogo('sol') },
    { name: 'Arbitrum', svg: payoutLogo('arb') },
  ];
  let chainIdx = $state(0);

  interface Point {
    x: number;
    y: number;
    baseHash: string;
    revealedText: string | null;
    opacity: number;
    targetOpacity: number;
    isRevealed: boolean;
  }
  let points: Point[] = [];

  const isDark = $derived(!mounted || themeStore.current === 'dark');

  // NEAR implicit accounts and hashes are hex: fragments like "a3f9c2....7c21".
  function generateHash(): string {
    const pick = () => '0123456789abcdef'[Math.floor(Math.random() * 16)];
    return Array.from({ length: 6 }, pick).join('') + '....' + Array.from({ length: 4 }, pick).join('');
  }

  function initPoints() {
    if (!container || !canvas) return;
    const dpr = window.devicePixelRatio || 1;
    width = container.offsetWidth;
    height = container.offsetHeight;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    ctx = canvas.getContext('2d');
    if (ctx) ctx.scale(dpr, dpr);
    points = [];
    const cols = Math.ceil(width / GRID_SPACING);
    const rows = Math.ceil(height / GRID_SPACING);
    let dataIndex = 0;
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        let revealedText = null;
        if (Math.random() > 0.8) revealedText = HIDDEN_DATA[dataIndex++ % HIDDEN_DATA.length];
        points.push({
          x: i * GRID_SPACING + (Math.random() * 40 - 20),
          y: j * GRID_SPACING + (Math.random() * 40 - 20),
          baseHash: generateHash(),
          revealedText,
          opacity: 0,
          targetOpacity: 0,
          isRevealed: false,
        });
      }
    }
  }

  function animate() {
    if (!ctx) return;
    ctx.clearRect(0, 0, width, height);
    const textColor = isDark ? '200, 200, 200' : '60, 55, 70';
    const accentColor = isDark ? '180, 180, 190' : '90, 80, 120';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const revealed: Point[] = [];
    const base: Point[] = [];
    for (const point of points) {
      const dist = Math.hypot(mouse.x - point.x, mouse.y - point.y);
      if (dist < REVEAL_RADIUS) {
        point.targetOpacity = 0.3 + (1 - dist / REVEAL_RADIUS) * 0.7;
        point.isRevealed = dist < REVEAL_RADIUS * 0.6 && !!point.revealedText;
      } else {
        point.targetOpacity = 0;
        point.isRevealed = false;
      }
      point.opacity += (point.targetOpacity - point.opacity) * 0.1;
      if (point.opacity > 0.01) (point.isRevealed ? revealed : base).push(point);
    }
    ctx.font = `11px "JetBrains Mono", monospace`;
    for (const p of base) {
      ctx.fillStyle = `rgba(${textColor}, ${p.opacity})`;
      ctx.fillText(p.baseHash, p.x, p.y);
    }
    ctx.font = `500 13px "Saira", sans-serif`;
    for (const p of revealed) {
      ctx.fillStyle = `rgba(${accentColor}, ${p.opacity})`;
      ctx.fillText(p.revealedText!, p.x, p.y);
    }
    animationId = requestAnimationFrame(animate);
  }

  let framePending = false;
  function handleMouseMove(e: MouseEvent) {
    if (!container || framePending) return;
    framePending = true;
    const { clientX, clientY } = e;
    requestAnimationFrame(() => {
      framePending = false;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      mouse.x = clientX - rect.left;
      mouse.y = clientY - rect.top;
      container.style.setProperty('--mouse-x', `${mouse.x}px`);
      container.style.setProperty('--mouse-y', `${mouse.y}px`);
    });
  }

  function handleMouseLeave() {
    mouse = { x: -999, y: -999 };
    container?.style.setProperty('--mouse-x', '-999px');
    container?.style.setProperty('--mouse-y', '-999px');
  }

  onMount(() => {
    // The app renders in the browser only: wait one frame so the hidden state paints and the reveal transitions run.
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => (mounted = true)));
    // Reduced motion: no canvas animation (the CSS spotlight is mask-position only, as in the main repo).
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!reduceMotion) {
      initPoints();
      animate();
    }
    const resizeObserver = new ResizeObserver(() => {
      if (!reduceMotion) initPoints();
    });
    resizeObserver.observe(container);
    // Under reduced motion the mark still changes, without the transition (as in the main repo).
    const chainTimer = setInterval(() => (chainIdx = (chainIdx + 1) % CHAIN_LOOP.length), 2600);
    return () => {
      clearInterval(chainTimer);
      cancelAnimationFrame(raf);
      if (animationId) cancelAnimationFrame(animationId);
      resizeObserver.disconnect();
    };
  });
</script>

<div
  bind:this={container}
  onmousemove={handleMouseMove}
  onmouseleave={handleMouseLeave}
  role="presentation"
  class="relative w-full pt-24 pb-20 md:pt-32 md:pb-24 flex flex-col items-center justify-center overflow-hidden bg-transparent hero-container"
>
  <!-- 1. Wave grid (spotlight) -->
  <div class="absolute inset-0 pointer-events-none z-0 wave-grid-spotlight" aria-hidden="true"></div>

  <!-- 2. Data points canvas -->
  <canvas bind:this={canvas} aria-hidden="true" class="absolute inset-0 w-full h-full pointer-events-none z-10"></canvas>

  <!-- 3. Text backdrop: blurs the canvas behind the text, faded at the edges by a mask -->
  <div
    class="absolute inset-0 pointer-events-none z-10"
    style="backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); mask-image: radial-gradient(circle at center, black 0%, transparent 60%); -webkit-mask-image: radial-gradient(circle at center, black 0%, transparent 60%);"
  ></div>

  <div class="relative z-30 text-center max-w-4xl px-6 flex flex-col items-center gap-5 md:gap-6">
    <!-- The one eyebrow: the main repo hero's "Built on Stellar" lockup (Hero.svelte:285-314), same classes, NEAR's mark.
         Not a link: there is no hackathon page to send people to. -->
    <div class="transition-all duration-700 ease-out {mounted ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2'}" style="transition-delay: 150ms;">
      <span class="inline-flex items-center gap-2 rounded-full border border-zen-fg/10 bg-zen-fg/[0.04] backdrop-blur-md pl-3.5 pr-4 py-1.5">
        <Mark svg={MARKS.near} class="w-3.5 h-3.5 text-zen-fg/70" />
        <span class="text-[10px] font-semibold tracking-[0.28em] uppercase text-zen-fg/55">Built for NEAR Hackathon</span>
      </span>
    </div>

    <h1
      class="text-4xl sm:text-5xl md:text-6xl font-bold tracking-tighter text-zen-fg leading-[1.12] [text-wrap:balance] transition-opacity duration-1000 ease-out {mounted ? 'opacity-100' : 'opacity-0'}"
      style="transition-delay: 400ms;"
    >
      Send USDC to any email, from any<span class="inline-grid align-[-0.08em] mx-[0.22em] w-[0.78em] h-[0.78em]" aria-hidden="true"
        >{#each CHAIN_LOOP as c, i (c.name)}<span
            class="col-start-1 row-start-1 transition-all duration-500 ease-out motion-reduce:transition-none {i === chainIdx
              ? 'opacity-100 blur-none scale-100'
              : 'opacity-0 blur-sm scale-75'}"><Mark svg={c.svg} class="w-full h-full text-zen-fg" /></span
          >{/each}</span
      >chain.
    </h1>

    <p
      class="text-base md:text-lg text-zen-fg/60 max-w-xl text-center leading-normal [text-wrap:balance] transition-all duration-700 ease-out {mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-5'}"
      style="transition-delay: 600ms;"
    >
      They claim with Gmail or Google Workspace. The email never goes on chain.
    </p>

    <div
      class="flex flex-col sm:flex-row items-center gap-4 mt-6 w-full sm:w-auto transition-all duration-700 ease-out {mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-5'}"
      style="transition-delay: 1200ms;"
    >
      <!-- "Mainnet!" corner tag: the owner's own choice (T-040), a tag on the button, not a sentence. The kit's neutral
           ZenBadge (as FundFromChain's "Mainnet"), on an opaque backing so the button edge does not run through it, and on
           the straight part of the top edge. -->
      <a href="/create" class="relative block w-full sm:w-auto" aria-label="Send USDC (mainnet)"><ZenButton tabindex={-1} variant="primary" size="lg" class="w-full sm:w-auto">
        {#snippet iconLeft()}<Mark svg={MARKS.usdc} class="w-5 h-5" />{/snippet}
        Send USDC
      </ZenButton><span class="pointer-events-none absolute -top-2 right-7 flex rounded-md bg-zen-bg ring-1 ring-zen-fg/10" aria-hidden="true"><ZenBadge size="sm">Mainnet!</ZenBadge></span></a>
      <!-- Glass at rest (T-040): the kit's glass fill and blur (styles/index.css .zen-glass tokens) on the link, in the
           button's own radius, so the ring spotlight does not show through the transparent secondary button. A 5% fg
           tint raises it from the page in dark mode, where the glass fill alone equals the background (critic). ZenButton
           itself is untouched: its ring, hover and pressed fills sit on top. -->
      <a href={tryUrl} class="block w-full sm:w-auto rounded-full" style="background-color: oklch(from var(--zen-bg) l c h / var(--zen-glass-bg-opacity, 0.7)); backdrop-filter: blur(var(--zen-glass-blur, 24px)); -webkit-backdrop-filter: blur(var(--zen-glass-blur, 24px)); box-shadow: inset 0 0 0 999px oklch(from var(--zen-fg) l c h / 0.05);"><ZenButton tabindex={-1} variant="secondary" size="lg" class="w-full sm:w-auto">
        {#snippet iconLeft()}<Mark svg={MARKS.near} class="w-5 h-5" />{/snippet}
        Try on NEAR Testnet
      </ZenButton></a>
    </div>

    <!-- Mainnet keeps the unaudited note (T-001); the landing carries no testnet line (owner, T-040) -->
    {#if !TESTNET}<p class="text-xs text-zen-fg-subtle max-w-md">{UNAUDITED_LINE}</p>{/if}
  </div>

</div>

<style>
  /* Wave grid (spotlight), main repo values */
  .wave-grid-spotlight {
    background-image: repeating-radial-gradient(
      circle at 50% 100%,
      transparent 0,
      transparent 50px,
      color-mix(in oklch, var(--color-base-content), transparent 85%) 50px,
      color-mix(in oklch, var(--color-base-content), transparent 80%) 52px,
      transparent 52px
    );
    background-size: 100% 150%;
    mask-image: radial-gradient(circle 400px at var(--mouse-x, -999px) var(--mouse-y, -999px), black 0%, transparent 100%);
    -webkit-mask-image: radial-gradient(circle 400px at var(--mouse-x, -999px) var(--mouse-y, -999px), black 0%, transparent 100%);
  }
</style>
