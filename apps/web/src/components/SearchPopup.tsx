'use client';

import { useEffect, useRef } from 'react';

/**
 * The header's search: a magnifying-glass button that opens the search box in a popup
 * (a modal <dialog>: Esc or a click outside closes it). "/" opens it from anywhere. Without
 * script the button is a link to the cards page.
 */
export function SearchPopup(p: {
  action: string;
  label: string;
  placeholder: string;
  button: string;
  open: string;
  close: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const show = () => {
    const d = dialog.current;
    if (!d || d.open) return;
    // on the cards page the box starts with the current search
    const q = new URLSearchParams(window.location.search).get('q');
    if (input.current && window.location.pathname.endsWith(p.action)) {
      input.current.value = q ?? '';
    }
    d.showModal();
    input.current?.focus();
    input.current?.select();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t?.closest('input, textarea, select, [contenteditable="true"]')) return;
      e.preventDefault();
      show();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  return (
    <>
      <a
        href={p.action}
        className="icon-btn search-toggle"
        aria-label={p.open}
        title={p.open}
        aria-haspopup="dialog"
        onClick={(e) => {
          e.preventDefault();
          show();
        }}
      >
        <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false">
          <circle cx="10.5" cy="10.5" r="6.2" fill="none" stroke="currentColor" strokeWidth="2" />
          <path
            d="m15.2 15.2 5.3 5.3"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
        </svg>
      </a>
      <dialog
        ref={dialog}
        className="search-pop"
        aria-label={p.label}
        // a click on the backdrop lands on the dialog itself
        onClick={(e) => {
          if (e.target === dialog.current) dialog.current?.close();
        }}
        // Esc closes the popup even when the box has text (a search field would only clear it)
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            dialog.current?.close();
          }
        }}
      >
        <div className="search-pop__body">
          <form role="search" action={p.action} method="get" className="search">
            <label className="visually-hidden" htmlFor="search-q">
              {p.label}
            </label>
            <input
              ref={input}
              id="search-q"
              type="search"
              name="q"
              placeholder={p.placeholder}
              autoComplete="off"
              enterKeyHint="search"
            />
            <button className="btn" type="submit">
              {p.button}
            </button>
          </form>
          <button
            type="button"
            className="search-pop__close"
            aria-label={p.close}
            title={p.close}
            onClick={() => dialog.current?.close()}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
              <path
                d="M6 6l12 12M18 6 6 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>
      </dialog>
    </>
  );
}
