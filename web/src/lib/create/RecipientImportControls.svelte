<script lang="ts">
  // Zarf's RecipientImportControls (apps/create/src/lib/components/recipients), plus Open Backup and "same amount for all".
  import { AlertTriangle, ClipboardPaste, FolderOpen, Plus, Upload, X } from 'lucide-svelte';
  import ZenButton from '$lib/zen/components/ZenButton.svelte';

  let {
    hasRows,
    disabled = false,
    backupDisabled = false,
    skipped = [],
    error = null,
    onAddRow,
    onClear,
    onPaste,
    onImportFile,
    onOpenBackup,
    onDismissSkipped,
  }: {
    hasRows: boolean;
    disabled?: boolean;
    backupDisabled?: boolean;
    skipped?: string[];
    error?: string | null;
    onAddRow: () => void;
    onClear: () => void;
    /** False when nothing could be read: the panel stays open with the text. */
    onPaste: (text: string, sameAmount: string) => boolean;
    onImportFile: (file: File) => Promise<boolean>;
    onOpenBackup: (file: File | undefined) => void;
    onDismissSkipped: () => void;
  } = $props();

  let open = $state(false);
  let text = $state('');
  let same = $state('');
  let fileError = $state<string | null>(null);
  let fileInput = $state<HTMLInputElement>();

  function apply() {
    fileError = null;
    if (onPaste(text, same)) {
      open = false;
      text = same = '';
    }
  }

  async function onFile(e: Event & { currentTarget: HTMLInputElement }) {
    const file = e.currentTarget.files?.[0];
    if (!file) return;
    e.currentTarget.value = ''; // the same file can be picked again
    fileError = null;
    try {
      await onImportFile(file);
    } catch {
      fileError = 'Could not read this file. Try selecting it again.';
    }
  }
</script>

<div class="space-y-4">
  <div class="flex flex-wrap items-center gap-2">
    <ZenButton variant="ghost" size="sm" onclick={onAddRow} {disabled}><Plus class="mr-1 h-4 w-4" aria-hidden="true" /> Add Row</ZenButton>
    <ZenButton variant="ghost" size="sm" onclick={() => (open = !open)} aria-expanded={open} aria-controls="paste-list" {disabled}><ClipboardPaste class="mr-1 h-4 w-4" aria-hidden="true" /> Paste List</ZenButton>
    <ZenButton variant="ghost" size="sm" onclick={() => fileInput?.click()} {disabled}><Upload class="mr-1 h-4 w-4" aria-hidden="true" /> Import CSV</ZenButton>
    <input bind:this={fileInput} type="file" accept=".csv,.tsv,.txt,text/csv,text/plain" class="hidden" onchange={onFile} tabindex="-1" aria-hidden="true" />
    <label id="backup" class="inline-flex">
      <span class="inline-flex cursor-pointer items-center rounded-full px-4 py-2 text-xs font-medium text-zen-fg-muted transition-colors hover:bg-zen-fg/5 hover:text-zen-fg has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-zen-fg {backupDisabled ? 'pointer-events-none opacity-50' : ''}">
        <FolderOpen class="mr-1 h-4 w-4" aria-hidden="true" /> Open Backup
        <input class="sr-only" type="file" accept="application/json,.json" disabled={backupDisabled} onchange={(e) => onOpenBackup(e.currentTarget.files?.[0])} />
      </span>
    </label>
    {#if hasRows}
      <ZenButton variant="ghost" size="sm" onclick={onClear} {disabled}><X class="mr-1 h-4 w-4" aria-hidden="true" /> Clear</ZenButton>
    {/if}
  </div>

  {#if open}
    <div id="paste-list" class="space-y-3 rounded-xl border border-zen-border-subtle bg-zen-fg/[0.02] p-4">
      <label for="paste-text" class="text-xs font-medium text-zen-fg-muted">One per line: email, amount. Amount optional.</label>
      <textarea
        id="paste-text"
        bind:value={text}
        rows="5"
        spellcheck="false"
        placeholder={'alice@gmail.com,10\nbob@gmail.com'}
        class="w-full rounded-lg border border-zen-border-subtle bg-zen-bg p-3 font-mono text-base text-zen-fg focus:outline-none focus:ring-1 focus:ring-zen-fg/30 sm:text-xs"
      ></textarea>
      <label class="flex items-center justify-between gap-3">
        <span class="text-xs font-medium text-zen-fg-muted">Same Amount for All</span>
        <input
          bind:value={same}
          type="text"
          inputmode="decimal"
          placeholder="Optional"
          class="h-8 w-28 rounded-lg border border-zen-border bg-zen-fg/[0.03] px-2.5 text-right font-mono text-base tabular-nums text-zen-fg focus:border-zen-fg/40 focus:outline-none sm:text-xs"
        />
      </label>
      <div class="flex items-center gap-2">
        <ZenButton variant="primary" size="sm" onclick={apply} disabled={!text.trim()}>Add to List</ZenButton>
        <ZenButton variant="ghost" size="sm" onclick={() => (open = false)}>Cancel</ZenButton>
      </div>
    </div>
  {/if}

  {#if fileError || error}
    <div role="alert" class="flex items-start gap-3 rounded-xl bg-zen-error/5 p-3 text-sm text-zen-error">
      <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      <span>{fileError ?? error}</span>
    </div>
  {/if}

  {#if skipped.length > 0}
    <div role="alert" class="rounded-xl bg-zen-warning/5 p-3 text-xs text-zen-warning">
      <div class="flex items-center gap-2 font-semibold">
        <AlertTriangle class="h-4 w-4" aria-hidden="true" />
        {skipped.length === 1 ? '1 line was skipped' : `${skipped.length} lines were skipped`}
        <button type="button" onclick={onDismissSkipped} class="ml-auto font-medium underline-offset-2 hover:underline">Dismiss</button>
      </div>
      <ul class="mt-1 max-h-32 list-disc space-y-0.5 overflow-y-auto pl-6">
        {#each skipped.slice(0, 8) as line, i (i)}<li>{line}</li>{/each}
        {#if skipped.length > 8}<li>…and {skipped.length - 8} more</li>{/if}
      </ul>
    </div>
  {/if}
</div>
