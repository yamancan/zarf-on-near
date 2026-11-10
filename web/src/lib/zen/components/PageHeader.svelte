<script lang="ts">
    // Copied from the main repo (web/packages/ui/lib/components/ui), values unchanged.
    import type { Snippet } from 'svelte';

    // (the generic $props<…>() form is typed as below here; svelte-check rejects the generic)
    let { title, description, extra }: { title: string; description: string; extra?: Snippet } = $props();
</script>

<header class="mb-10 text-left">
    <div class="flex items-center justify-between gap-4">
        <div class="space-y-2">
            <h1 class="text-2xl md:text-3xl font-light tracking-tight text-zen-fg">
                {title}
            </h1>
            <p class="text-sm md:text-base text-zen-fg-muted font-light leading-relaxed">
                {description}
            </p>
        </div>
        {#if extra}
            <div class="shrink-0">
                {@render extra()}
            </div>
        {/if}
    </div>
</header>
