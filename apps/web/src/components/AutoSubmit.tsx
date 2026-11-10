'use client';

import { useEffect } from 'react';

/** Applies filters as soon as a box is ticked (the button stays for keyboard and no-JS use). */
export function AutoSubmit({ formId, panelId }: { formId: string; panelId?: string }) {
  useEffect(() => {
    // Wide screens show the filters beside the list (older browsers need the panel opened).
    const panel = panelId ? (document.getElementById(panelId) as HTMLDetailsElement | null) : null;
    if (panel && window.matchMedia('(min-width: 60rem)').matches) panel.open = true;
    const form = document.getElementById(formId) as HTMLFormElement | null;
    if (!form) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onChange = (e: Event) => {
      const el = e.target as HTMLInputElement;
      // Fields of another form placed inside (form="…"), e.g. the voucher code, are not ours.
      if (el.form && el.form !== form) return;
      clearTimeout(timer);
      timer = setTimeout(() => form.requestSubmit(), el.type === 'checkbox' ? 0 : 600);
    };
    form.addEventListener('change', onChange);
    return () => form.removeEventListener('change', onChange);
  }, [formId, panelId]);
  return null;
}
