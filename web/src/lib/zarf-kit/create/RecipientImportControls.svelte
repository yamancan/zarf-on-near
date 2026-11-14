<script lang="ts">
    import { Plus, Upload, ClipboardPaste, AlertTriangle, FileText, X } from 'lucide-svelte';
    import ZenButton from '../components/ui/ZenButton.svelte';

    interface Props {
        hasRows: boolean;
        pasteHelp: string;
        pastePlaceholder: string;
        errors?: string[];
        error?: string | null;
        onAddRow: () => void;
        onClear: () => void;
        onParseText: (content: string) => boolean | Promise<boolean>;
        onImportFile: (file: File) => boolean | Promise<boolean>;
        onDownloadTemplate?: () => void;
        onDismissErrors?: () => void;
    }

    let {
        hasRows,
        pasteHelp,
        pastePlaceholder,
        errors = [],
        error = null,
        onAddRow,
        onClear,
        onParseText,
        onImportFile,
        onDownloadTemplate,
        onDismissErrors,
    }: Props = $props();

    let importOpen = $state(false);
    let importText = $state('');
    let fileError = $state<string | null>(null);
    let fileInput = $state<HTMLInputElement | undefined>(undefined);

    async function applyText() {
        fileError = null;
        if (await onParseText(importText)) {
            importOpen = false;
            importText = '';
        }
    }

    async function handleFileChange(event: Event) {
        const input = event.currentTarget as HTMLInputElement;
        const file = input.files?.[0];
        if (!file) return;
        // Capture first, then reset before awaiting: an old completion must not reset a newer pick.
        input.value = '';
        fileError = null;
        try {
            await onImportFile(file);
        } catch {
            fileError = 'Could not import this file. Try selecting it again.';
        }
    }
</script>

<div class="space-y-4">
    <div class="flex flex-wrap items-center gap-2">
        <ZenButton variant="ghost" size="sm" onclick={onAddRow}>
            <Plus class="mr-1 h-4 w-4" /> Add Row
        </ZenButton>
        <ZenButton variant="ghost" size="sm" onclick={() => (importOpen = !importOpen)}>
            <ClipboardPaste class="mr-1 h-4 w-4" /> Paste List
        </ZenButton>
        <ZenButton variant="ghost" size="sm" onclick={() => fileInput?.click()}>
            <Upload class="mr-1 h-4 w-4" /> Import CSV
        </ZenButton>
        <input
            bind:this={fileInput}
            type="file"
            accept=".csv,text/csv,text/plain"
            class="hidden"
            onchange={handleFileChange}
        />
        {#if onDownloadTemplate}
            <ZenButton variant="ghost" size="sm" onclick={onDownloadTemplate}>
                <FileText class="mr-1 h-4 w-4" /> Template
            </ZenButton>
        {/if}
        {#if hasRows}
            <ZenButton variant="ghost" size="sm" onclick={onClear}>
                <X class="mr-1 h-4 w-4" /> Clear
            </ZenButton>
        {/if}
    </div>

    {#if importOpen}
        <div class="space-y-3 rounded-xl border border-zen-border-subtle bg-zen-fg/[0.02] p-4">
            <label for="recipient-bulk-import" class="text-xs font-medium text-zen-fg-muted">
                {pasteHelp}
            </label>
            <textarea
                id="recipient-bulk-import"
                bind:value={importText}
                rows="5"
                spellcheck="false"
                placeholder={pastePlaceholder}
                class="w-full rounded-lg border border-zen-border-subtle bg-zen-bg p-3 font-mono text-xs text-zen-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-zen-fg/70"
            ></textarea>
            <div class="flex items-center gap-2">
                <ZenButton variant="primary" size="sm" onclick={applyText}>Add to List</ZenButton>
                <ZenButton variant="ghost" size="sm" onclick={() => (importOpen = false)}>
                    Cancel
                </ZenButton>
            </div>
        </div>
    {/if}

    {#if fileError || error}
        <div
            role="alert"
            class="flex items-start gap-3 rounded-xl bg-zen-error/5 p-3 text-sm text-zen-error"
        >
            <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
            <span>{fileError ?? error}</span>
        </div>
    {/if}

    {#if errors.length > 0}
        <div role="alert" class="rounded-xl bg-zen-warning/5 p-3 text-xs text-zen-warning">
            <div class="flex items-center gap-2 font-semibold">
                <AlertTriangle class="h-4 w-4" />
                {errors.length === 1 ? '1 line was skipped' : `${errors.length} lines were skipped`}
                {#if onDismissErrors}
                    <button
                        type="button"
                        onclick={onDismissErrors}
                        class="ml-auto font-medium underline-offset-2 hover:underline"
                    >
                        Dismiss
                    </button>
                {/if}
            </div>
            <ul class="mt-1 max-h-32 list-disc space-y-0.5 overflow-y-auto pl-6">
                {#each errors.slice(0, 8) as issue, i (i)}
                    <li>{issue}</li>
                {/each}
                {#if errors.length > 8}
                    <li>…and {errors.length - 8} more</li>
                {/if}
            </ul>
        </div>
    {/if}
</div>
