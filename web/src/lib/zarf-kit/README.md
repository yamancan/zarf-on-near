# zarf-kit

Files copied from the Zarf main repo, `web/packages/ui/lib`, at a reviewed revision, at the same relative paths, unchanged except:

- `stores/themeStore.svelte.ts`: `@zarf/core` imports replaced by `$app/environment` and `console.warn`.
- `components/ui/ZenSelect.svelte`: `@zarf/ui/actions/clickOutside` imported by relative path.
- `components/brand/ZLockup.svelte`: new; the kit lockup from the Zarf design canvas handover (mark 0.75 × font size, gap 0.4 × mark,
  Saira 600, -0.025em, no tile), mark path from `design/zarf-logo-1000.svg`.
- `components/ui/PageHeader.svelte`: the generic `$props<…>()` call written as an annotation (svelte-check rejects the generic form); types only, markup and classes unchanged.

Links that look like buttons follow Zarf's own pattern (apps/landing +page.svelte:157-166): `<a href><ZenButton tabindex={-1}>…</ZenButton></a>`.

`create/`: from the Zarf main repo's `web/apps/create/src/lib/components/recipients/` at that revision, changed only as listed:

- `RecipientAllocationGrid.svelte`: import paths (`../components/ui/ZenButton.svelte`, `./format`).
- `RecipientImportControls.svelte`: import paths; button labels in Title Case ("Add Row", "Paste List", "Add to List").
- `rowChecks.ts`: `emailRowRules` and its `@zarf/core` imports removed (NEAR's rules are `gridRules` in `lib/create/grid.ts`).
- `format.ts`: `formatAmount` from `web/packages/core/lib/utils/format.ts` lines 1-30.
