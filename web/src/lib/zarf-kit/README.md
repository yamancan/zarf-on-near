# zarf-kit

Files copied from the Zarf main repo, `web/packages/ui/lib`, at a reviewed revision, at the same relative paths, unchanged except:

- `stores/themeStore.svelte.ts`: `@zarf/core` imports replaced by `$app/environment` and `console.warn`.
- `components/ui/ZenSelect.svelte`: `@zarf/ui/actions/clickOutside` imported by relative path.
- `components/ui/ZenButton.svelte`: adds an `href` form (renders an `<a>` with the same classes) so no `<button>` sits in an `<a>`.
- `components/brand/ZLockup.svelte`: new; the kit lockup from the Zarf design canvas handover (mark 0.75 × font size, gap 0.4 × mark,
  Saira 600, -0.025em, no tile), mark path from `design/zarf-logo-1000.svg`.
- `components/ui/Tooltip.svelte`: text wraps at 16rem instead of nowrap (a sentence must fit a 390 px screen).
- `components/ui/PageHeader.svelte`: the generic `$props<…>()` call written as an annotation (svelte-check rejects the generic form).
