/**
 * Theme Store - Application Theme Management
 *
 * Manages binary dark/light theme selection.
 * Maps to data-theme tokens: light='paper-porcelain', dark='glass-porcelain'
 * Persists to localStorage and applies to document root.
 *
 * @module stores/themeStore
 */

import { browser } from '$app/environment';
const warn = (...a: unknown[]) => console.warn(...a);
import type { Theme } from './types';

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
let stopFollowingSystem: (() => void) | undefined;

// ============================================================================
// Derived Values
// ============================================================================

const isDark = $derived(currentTheme === 'dark');
const isLight = $derived(currentTheme === 'light');

// ============================================================================
// Persistence Helpers
// ============================================================================

/**
 * Apply independently of storage: blocked storage must not prevent the toggle.
 */
function apply(theme: Theme) {
    currentTheme = theme;
    document.documentElement.setAttribute('data-theme', THEME_MAP[theme]);
}

function persist(theme: Theme) {
    if (!browser) return;

    try {
        localStorage.setItem(STORAGE_KEY, theme);
    } catch (error) {
        warn('[ThemeStore] Failed to persist theme:', error);
    }
}

/**
 * Follow the device until an explicit choice is saved. Returns the mount cleanup.
 */
function restore() {
    if (!browser) return;
    stopFollowingSystem?.();
    stopFollowingSystem = undefined;

    try {
        const saved = localStorage.getItem(STORAGE_KEY);
        if (saved === 'dark' || saved === 'light') {
            apply(saved);
            return;
        }
    } catch (error) {
        warn('[ThemeStore] Failed to restore theme:', error);
    }

    const preference = window.matchMedia('(prefers-color-scheme: dark)');
    const follow = () => apply(preference.matches ? 'dark' : 'light');
    follow();
    preference.addEventListener('change', follow);
    const stop = () => preference.removeEventListener('change', follow);
    stopFollowingSystem = stop;
    return stop;
}

// ============================================================================
// Mutation Actions
// ============================================================================

function setTheme(theme: Theme) {
    currentTheme = theme;
    if (!browser) return;
    stopFollowingSystem?.();
    stopFollowingSystem = undefined;
    apply(theme);
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
