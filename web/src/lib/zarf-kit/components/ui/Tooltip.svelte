<script lang="ts">
    interface Props {
        text?: string;
        position?: 'top' | 'bottom' | 'left' | 'right';
        children?: import('svelte').Snippet;
    }

    let { text = 'Coming Soon', position = 'bottom', children }: Props = $props();

    let isHovered = $state(false);
    let isFocused = $state(false);
    let dismissed = $state(false);
    let anchor: HTMLDivElement;

    // Show tooltip on hover OR focus for keyboard accessibility
    let isVisible = $derived((isHovered || isFocused) && !dismissed);

    // Cards can clip overflow. Mount the bubble on the page and keep it within
    // the viewport, including when the trigger moves during scrolling.
    function place(node: HTMLDivElement, side: Props['position']) {
        document.body.appendChild(node);
        function positionBubble() {
            const a = anchor.getBoundingClientRect();
            const b = node.getBoundingClientRect();
            let x = a.left + (a.width - b.width) / 2;
            let y = side === 'top' ? a.top - b.height - 8 : a.bottom + 8;
            if (side === 'left' || side === 'right') {
                x = side === 'left' ? a.left - b.width - 8 : a.right + 8;
                y = a.top + (a.height - b.height) / 2;
            }
            node.style.left = `${Math.max(12, Math.min(x, innerWidth - b.width - 12))}px`;
            node.style.top = `${Math.max(12, Math.min(y, innerHeight - b.height - 12))}px`;
        }
        function escape(event: KeyboardEvent) {
            if (event.key === 'Escape') dismissed = true;
        }
        positionBubble();
        const observer = new ResizeObserver(positionBubble);
        observer.observe(node);
        window.addEventListener('resize', positionBubble);
        window.addEventListener('scroll', positionBubble, true);
        window.addEventListener('keydown', escape);
        return {
            update(next: Props['position']) { side = next; positionBubble(); },
            destroy() {
                observer.disconnect();
                window.removeEventListener('resize', positionBubble);
                window.removeEventListener('scroll', positionBubble, true);
                window.removeEventListener('keydown', escape);
                node.remove();
            },
        };
    }
</script>

<div
    bind:this={anchor}
    class="relative inline-block"
    role="group"
    onmouseenter={() => { isHovered = true; dismissed = false; }}
    onmouseleave={() => (isHovered = false)}
    onfocusin={() => { isFocused = true; dismissed = false; }}
    onfocusout={() => (isFocused = false)}
>
    {@render children?.()}

    {#if isVisible}
        <div
            use:place={position}
            role="tooltip"
            aria-live="polite"
            class="
                fixed z-[100] px-3 py-1.5
                text-xs font-medium
                text-zen-bg bg-zen-fg
                rounded-lg shadow-lg
                w-max max-w-[min(16rem,calc(100vw-24px))] whitespace-normal
                [overflow-wrap:anywhere] text-center pointer-events-none
            "
        >
            {text}
        </div>
    {/if}
</div>
