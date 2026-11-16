'use client';

import { useEffect } from 'react';

const DARK_SURFACE = '#1a2037';
const LIGHT_SURFACE = '#ffffff';

const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;
const isDark = () => {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : systemDark();
};

/** The browser bar's colour follows the page. */
function syncThemeColor() {
  const t = document.documentElement.dataset.theme;
  document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]').forEach((m) => {
    if (!m.dataset.content) m.dataset.content = m.content;
    m.content = t ? (t === 'dark' ? DARK_SURFACE : LIGHT_SURFACE) : m.dataset.content;
  });
}

/**
 * Switches between light and dark. The pick is kept in localStorage; picking what the system
 * shows anyway drops it, so the page follows the system again. The icon is chosen by CSS.
 */
export function ThemeToggle({ label }: { label: string }) {
  useEffect(syncThemeColor, []);
  return (
    <button
      type="button"
      className="icon-btn theme-toggle"
      aria-label={label}
      title={label}
      onClick={() => {
        const next = isDark() ? 'light' : 'dark';
        const root = document.documentElement;
        try {
          if ((next === 'dark') === systemDark()) {
            delete root.dataset.theme;
            localStorage.removeItem('theme');
          } else {
            root.dataset.theme = next;
            localStorage.setItem('theme', next);
          }
        } catch {
          root.dataset.theme = next;
        }
        syncThemeColor();
      }}
    >
      {/* moon: shown in light mode (switch to dark) */}
      <svg
        className="theme-toggle__moon"
        viewBox="0 0 24 24"
        width="20"
        height="20"
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinejoin="round"
        />
      </svg>
      {/* sun: shown in dark mode (switch to light) */}
      <svg
        className="theme-toggle__sun"
        viewBox="0 0 24 24"
        width="20"
        height="20"
        aria-hidden="true"
        focusable="false"
      >
        <circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" strokeWidth="1.9" />
        <path
          d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
        />
      </svg>
    </button>
  );
}
