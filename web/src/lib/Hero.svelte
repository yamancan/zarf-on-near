<script lang="ts">
  // Ported from the main repo's landing hero (packages/ui/lib/components/landing/Hero.svelte): the ring
  // spotlight, the hash canvas, the 16 px blur that clears the text, the staggered reveal and the scroll cue,
  // with the same values. Differences: the headline is the core line (no rotating word), the hashes are NEAR
  // style (hex) instead of Stellar strkeys, the eyebrow carries no chain logo, and the CTAs are this app's.
  import { onMount } from 'svelte';
  import { ArrowRight, ChevronDown } from 'lucide-svelte';
  import { themeStore } from '$lib/zen/stores/themeStore.svelte';
  import ZenButton from '$lib/zen/components/ZenButton.svelte';

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
    return () => {
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
  class="relative w-full min-h-[90vh] flex flex-col items-center justify-center overflow-hidden bg-transparent hero-container"
>
  <!-- 1. Wave grid (spotlight) -->
  <div class="absolute inset-0 pointer-events-none z-0 wave-grid-spotlight"></div>

  <!-- 2. Data points canvas -->
  <p class="sr-only">Decorative background: hashed placeholders that reveal "Private Claim" labels under the cursor. No interactive content.</p>
  <canvas bind:this={canvas} aria-hidden="true" class="absolute inset-0 w-full h-full pointer-events-none z-10"></canvas>

  <!-- 3. Text backdrop: blurs the canvas behind the text, faded at the edges by a mask -->
  <div
    class="absolute inset-0 pointer-events-none z-10"
    style="backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); mask-image: radial-gradient(circle at center, black 0%, transparent 60%); -webkit-mask-image: radial-gradient(circle at center, black 0%, transparent 60%);"
  ></div>

  <!-- Grain (main repo landing-grain), hero only, faded out at the bottom edge -->
  <div class="landing-grain absolute inset-0 pointer-events-none z-20 [mask-image:linear-gradient(to_bottom,black_70%,transparent)]" aria-hidden="true"></div>

  <div class="relative z-30 text-center max-w-4xl px-6 flex flex-col items-center gap-5 md:gap-6">
    <div class="transition-all duration-700 ease-out {mounted ? 'opacity-100 translate-y-0' : 'opacity-0 -translate-y-2'}" style="transition-delay: 150ms;">
      <a
        href="https://near.org"
        target="_blank"
        rel="noopener noreferrer"
        class="group inline-flex items-center gap-2 rounded-full border border-zen-fg/10 bg-zen-fg/[0.04] backdrop-blur-md pl-3.5 pr-4 py-1.5 transition-colors duration-300 hover:border-zen-fg/20 hover:bg-zen-fg/[0.07]"
      >
        <span class="text-[10px] font-semibold tracking-[0.28em] uppercase text-zen-fg/55 transition-colors duration-300 group-hover:text-zen-fg/80">Built on NEAR</span>
      </a>
    </div>

    <h1
      class="text-4xl sm:text-5xl md:text-6xl font-bold tracking-tighter text-zen-fg leading-[1.12] [text-wrap:balance] transition-opacity duration-1000 ease-out {mounted ? 'opacity-100' : 'opacity-0'}"
      style="transition-delay: 400ms;"
    >
      Send tokens to an email.
    </h1>

    <p
      class="text-base md:text-lg text-zen-fg/60 max-w-xl text-center leading-normal transition-all duration-700 ease-out {mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-5'}"
      style="transition-delay: 600ms;"
    >
      They claim with Google. The email never goes on chain.
    </p>

    <div
      class="flex flex-col sm:flex-row items-center gap-4 mt-6 w-full sm:w-auto transition-all duration-700 ease-out {mounted ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-5'}"
      style="transition-delay: 1200ms;"
    >
      <ZenButton href={tryUrl} variant="primary" size="lg" class="rounded-full !bg-zen-fg/90 backdrop-blur-sm !text-zen-bg hover:shadow-lg hover:shadow-zen-fg/10 w-full sm:w-auto">
        Try it with Google
        {#snippet iconRight()}<ArrowRight class="w-3.5 h-3.5" />{/snippet}
      </ZenButton>
      <ZenButton href="/create" variant="secondary" size="lg" class="rounded-full !bg-zen-fg/5 backdrop-blur-md !text-zen-fg/80 !border-zen-fg/10 w-full sm:w-auto">
        Send USDC
      </ZenButton>
    </div>

    <!-- Status line: "Live on" raised from Zarf's /35 to /55 (2.6:1 there; critic P2-12) -->
    <p
      class="inline-flex items-center gap-1.5 text-[11px] font-medium tracking-[0.15em] uppercase text-zen-fg/55 transition-opacity duration-700 ease-out {mounted ? 'opacity-100' : 'opacity-0'}"
      style="transition-delay: 1500ms;"
    >
      Live on <span class="text-zen-fg/70">NEAR testnet</span>
    </p>
  </div>

  <!-- Scroll indicator -->
  <div
    class="absolute bottom-8 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1.5 text-zen-fg/15 z-40 transition-opacity duration-700 ease-out {mounted ? 'opacity-100' : 'opacity-0'}"
    style="transition-delay: 1800ms;"
    aria-hidden="true"
  >
    <ChevronDown class="w-4 h-4 animate-bounce" strokeWidth={1.5} />
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
