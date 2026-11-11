<script lang="ts">
    // Copied from the main repo (web/packages/ui/lib/components/ui). Changes: min-h-11 on the label (44 px target);
    // disabled dims the box only, so the label stays readable (critic r2 P2-12).
    import type { HTMLInputAttributes } from 'svelte/elements';
    import { Check } from 'lucide-svelte';

    interface Props extends HTMLInputAttributes {
        label?: string;
        checked?: boolean;
    }

    let {
        label,
        checked = $bindable(false),
        class: className = '',
        disabled,
        ...rest
    }: Props = $props();
</script>

<label
    class="flex items-center gap-2 min-h-11 cursor-pointer group {disabled
        ? 'cursor-not-allowed'
        : ''}"
>
    <div class="relative">
        <input type="checkbox" class="sr-only peer" bind:checked {disabled} {...rest} />
        <div
            class="
                w-4 h-4 rounded peer-disabled:opacity-50
                border-[0.5px] border-zen-border-strong
                bg-transparent
                transition-all duration-[var(--zen-motion-base)]
                peer-checked:bg-zen-primary
                peer-checked:border-zen-primary
                peer-focus-visible:ring-2
                peer-focus-visible:ring-[var(--zen-ring-color)]
                peer-focus-visible:ring-offset-2
                peer-focus-visible:ring-offset-zen-bg
                group-hover:border-zen-fg-muted
                {className}
            "
        >
            {#if checked}
                <Check class="w-full h-full p-0.5 text-zen-primary-content" strokeWidth={3} />
            {/if}
        </div>
    </div>
    {#if label}
        <span
            class="text-xs text-zen-fg-muted group-hover:text-zen-fg transition-colors select-none"
        >
            {label}
        </span>
    {/if}
</label>
