'use client';

export function PrintButton() {
  return (
    <button className="btn btn--accent" type="button" onClick={() => window.print()}>
      Drucken
    </button>
  );
}
