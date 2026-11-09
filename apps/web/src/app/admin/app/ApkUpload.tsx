'use client';

import { useState } from 'react';

/** Sends the APK as the raw request body with a progress bar (files are ~100 MB). */
export function ApkUpload() {
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState<number | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  function upload(form: HTMLFormElement) {
    const data = new FormData(form);
    const version = String(data.get('version') ?? '').trim();
    if (!file || !version) {
      setMessage({ ok: false, text: 'Bitte Datei und Version angeben.' });
      return;
    }
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', '/admin/app/upload');
    xhr.setRequestHeader('content-type', 'application/vnd.android.package-archive');
    xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
    xhr.setRequestHeader('x-app-version', encodeURIComponent(version));
    xhr.setRequestHeader('x-app-notes', encodeURIComponent(String(data.get('notes') ?? '')));
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      setProgress(null);
      let body: { error?: string } = {};
      try {
        body = JSON.parse(xhr.responseText) as { error?: string };
      } catch {
        // ignore
      }
      if (xhr.status === 200) {
        window.location.href = `/admin/app?ok=${encodeURIComponent(`Version ${version} ist online.`)}`;
      } else {
        setMessage({
          ok: false,
          text:
            body.error ??
            (xhr.status === 413
              ? 'Die Datei ist zu groß für den Server (Caddy-Limit prüfen).'
              : `Upload fehlgeschlagen (${xhr.status}).`),
        });
      }
    };
    xhr.onerror = () => {
      setProgress(null);
      setMessage({ ok: false, text: 'Verbindung abgebrochen. Bitte noch einmal versuchen.' });
    };
    setMessage(null);
    setProgress(0);
    xhr.send(file);
  }

  return (
    <form
      className="form-grid"
      style={{ alignItems: 'start' }}
      onSubmit={(e) => {
        e.preventDefault();
        upload(e.currentTarget);
      }}
    >
      <label className="field" style={{ gridColumn: '1 / -1' }}>
        <span>APK-Datei</span>
        <input
          type="file"
          accept=".apk,application/vnd.android.package-archive"
          required
          onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setFile(f);
            // "CardScanner-1.2.30.apk" → suggest the version
            const m = f && /(\d+\.\d+\.\d+)/.exec(f.name);
            const input = e.target.form?.elements.namedItem('version') as HTMLInputElement | null;
            if (m && input && !input.value) input.value = m[1]!;
          }}
        />
      </label>
      <label className="field">
        <span>Version</span>
        <input name="version" required maxLength={40} placeholder="z. B. 1.2.30" />
        <small className="muted">Steht in der App unter ⚙ → About.</small>
      </label>
      <label className="field">
        <span>Notiz (intern, optional)</span>
        <input name="notes" maxLength={1000} placeholder="z. B. erste Beta für Käufer" />
      </label>
      <div style={{ gridColumn: '1 / -1' }}>
        {progress === null ? (
          <button className="btn btn--accent" type="submit">
            Hochladen
          </button>
        ) : (
          <div role="status" aria-live="polite">
            <progress max={100} value={progress} style={{ width: '100%' }} /> {progress} %
          </div>
        )}
        {message && (
          <p className={message.ok ? 'notice' : 'notice notice--warn'} role="alert">
            {message.text}
          </p>
        )}
      </div>
    </form>
  );
}
