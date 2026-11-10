/**
 * Theme Store - Application Theme Management
 *
 * Manages binary dark/light theme selection.
 * Maps to data-theme tokens: light='paper-porcelain', dark='glass-porcelain'
 * Persists to localStorage and applies to document root.
 *
 * @module stores/themeStore
 */

// Copied from the main repo (web/packages/ui/lib/stores/themeStore.svelte.ts); the imports and the no-saved-theme default differ.
import { browser } from '$app/environment';

export type Theme = 'dark' | 'light';
const warn = (...a: unknown[]) => console.warn(...a);

const STORAGE_KEY = 'zarf_theme';
const DEFAULT_THEME: Theme = 'dark';

// Theme name → Tailwind v4 @theme registration token
const THEME_MAP: Record<Theme, string> = {
    light: 'paper-porcelain',
    dark: 'glass-porcelain',
};

// ============================================================================
// Internal State (Private)
// ============================================================================

let currentTheme = $state<Theme>(DEFAULT_THEME);

// ============================================================================
// Derived Values
// ============================================================================

const isDark = $derived(currentTheme === 'dark');
const isLight = $derived(currentTheme === 'light');

// ============================================================================
// Persistence Helpers
// ============================================================================

/**
 * Persist theme to localStorage and apply to document
 */
function persist(theme: Theme) {
    if (!browser) return;

    try {
        localStorage.setItem(STORAGE_KEY, theme);
        const themeName = THEME_MAP[theme];
        document.documentElement.setAttribute('data-theme', themeName);
    } catch (error) {
        warn('[ThemeStore] Failed to persist theme:', error);
    }
}

/**
 * Restore theme from localStorage
 */
function restore() {
    if (!browser) return;

    try {
        const saved = localStorage.getItem(STORAGE_KEY) as Theme;

        if (saved && ['dark', 'light'].includes(saved)) {
            currentTheme = saved;
            const themeName = THEME_MAP[saved];
            document.documentElement.setAttribute('data-theme', themeName);
        } else {
            // zarf-near change: with nothing saved, follow the OS (as the judges' page does) and do not
            // persist it, so the OS keeps deciding until the reader picks a theme. app.html does the same pre-paint.
            const os: Theme = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
            currentTheme = os;
            document.documentElement.setAttribute('data-theme', THEME_MAP[os]);
        }
    } catch (error) {
        warn('[ThemeStore] Failed to restore theme:', error);
        persist(DEFAULT_THEME);
    }
}

// ============================================================================
// Mutation Actions
// ============================================================================

function setTheme(theme: Theme) {
    currentTheme = theme;
    persist(theme);
}

function toggleTheme() {
    const newTheme: Theme = currentTheme === 'dark' ? 'light' : 'dark';
    setTheme(newTheme);
}

function reset() {
    setTheme(DEFAULT_THEME);
}

// ============================================================================
// Public API
// ============================================================================

export const themeStore = {
    // Getters (read-only)
    get current() {
        return currentTheme;
    },

    // Derived getters
    get isDark() {
        return isDark;
    },
    get isLight() {
        return isLight;
    },

    // Mutation methods
    setTheme,
    toggleTheme,
    reset,

    // Lifecycle
    restore,
};
