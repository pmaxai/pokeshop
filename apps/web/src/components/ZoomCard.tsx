'use client';

import { useRef } from 'react';

/** Opens the large picture of the card in a dialog; Esc or the button closes it. */
export function ZoomCard({
  src,
  alt,
  openLabel,
  closeLabel,
  children,
}: {
  src: string;
  alt: string;
  openLabel: string;
  closeLabel: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  return (
    <>
      <a
        href={src}
        onClick={(e) => {
          e.preventDefault();
          ref.current?.showModal();
        }}
        aria-label={openLabel}
        style={{ cursor: 'zoom-in', display: 'block' }}
      >
        {children}
      </a>
      <dialog
        ref={ref}
        className="zoom-dialog"
        onClick={(e) => {
          if (e.target === ref.current) ref.current?.close();
        }}
      >
        <img src={src} alt={alt} loading="lazy" />
        <form method="dialog">
          <button className="btn" type="submit">
            {closeLabel}
          </button>
        </form>
      </dialog>
    </>
  );
}
