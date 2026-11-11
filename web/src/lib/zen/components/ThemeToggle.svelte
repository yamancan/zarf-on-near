<script lang="ts">
    import { themeStore } from '../stores/themeStore.svelte';
    import { Moon, Sun } from 'lucide-svelte';

    function toggle() {
        themeStore.toggleTheme();
    }
</script>

<!-- Local change from the main repo: w-11/h-11 (44 px touch target) instead of w-9/h-9. -->
<button
    onclick={toggle}
    class="
        w-11 h-11 rounded-full
        flex items-center justify-center
        text-zen-fg-muted hover:text-zen-fg
        hover:bg-zen-fg/5
        transition-all duration-200
        group
    "
    aria-label="Toggle Theme"
>
    {#if themeStore.isDark}
        <Sun class="w-4 h-4 transition-transform group-hover:rotate-12" />
    {:else}
        <Moon class="w-4 h-4 transition-transform group-hover:-rotate-12" />
    {/if}
</button>
