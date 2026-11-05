'use client';

import { useActionState } from 'react';
import { createApiKey, type CreateKeyState } from '../actions';

export function CreateKeyForm() {
  const [state, action, pending] = useActionState<CreateKeyState, FormData>(createApiKey, {});
  return (
    <>
      {state.secret && (
        <div className="notice notice--ok" role="status">
          <strong>
            Schlüssel angelegt. Trag beides jetzt in der Scanner-App ein – das Geheimnis wird nicht
            noch einmal angezeigt.
          </strong>
          <span className="secret">Schlüssel-ID: {state.keyId}</span>
          <span className="secret">Geheimnis: {state.secret}</span>
        </div>
      )}
      {state.error && (
        <p className="notice notice--err" role="alert">
          {state.error}
        </p>
      )}
      <form action={action} className="toolbar">
        <label className="field">
          <span>Name</span>
          <input name="name" placeholder="z. B. Scanner Lager" required />
        </label>
        <label className="field">
          <span>Nur von diesen IPs (optional)</span>
          <input name="ips" placeholder="203.0.113.7, 10.0.0.0/24" style={{ minWidth: '16rem' }} />
        </label>
        <button className="btn" type="submit" disabled={pending}>
          {pending ? 'Wird angelegt …' : 'Schlüssel anlegen'}
        </button>
      </form>
    </>
  );
}
