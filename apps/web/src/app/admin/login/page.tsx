import { redirect } from 'next/navigation';
import { currentAdmin, devLoginAllowed, entraConfigured } from '@/server/admin-auth';
import { devLogin } from '../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Anmelden' };

const ERRORS: Record<string, string> = {
  entra:
    'Die Microsoft-Anmeldung ist noch nicht eingerichtet (ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET).',
  state: 'Die Anmeldung ist abgelaufen. Bitte noch einmal anmelden.',
  tenant_id:
    'ENTRA_TENANT_ID muss die Verzeichnis-ID (Mandanten-ID) der App-Registrierung sein, eine GUID wie 1b2c3d4e-….',
  client_id: 'ENTRA_CLIENT_ID muss die Anwendungs-ID (Client-ID) sein, eine GUID wie 1b2c3d4e-….',
  secret_id:
    'ENTRA_CLIENT_SECRET enthält die ID des geheimen Clientschlüssels. Eingetragen werden muss sein Wert (Spalte „Wert“ / „Value“).',
  token:
    'Microsoft hat die Anmeldung nicht bestätigt. Der Grund steht im Log des Web-Containers (Zeilen mit [entra]).',
  denied:
    'Microsoft hat die Anmeldung abgelehnt. Der Grund steht im Log des Web-Containers (Zeilen mit [entra]).',
  not_assigned:
    'Dein Konto ist der App in Entra nicht zugewiesen (Unternehmensanwendungen → pokemonkarten-admin → Benutzer und Gruppen).',
  tenant: 'Dieses Konto gehört nicht zu eurem Microsoft-365-Mandanten.',
  not_allowed:
    'Dein Konto hat keine Shop-Rolle. In Entra braucht es die App-Rolle „Shop owner“ oder „Shop staff“ (oder die Gruppe „Shop-Admins“ / „Shop-Staff“). Danach neu anmelden.',
  cancelled: 'Die Anmeldung wurde abgebrochen.',
};

export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ err?: string; code?: string }>;
}) {
  if (await currentAdmin()) redirect('/admin');
  const { err, code } = await searchParams;
  const aadsts = code && /^\d{4,7}$/.test(code) ? ` Fehlercode: AADSTS${code}.` : '';
  return (
    <main>
      <div className="login">
        <h1 style={{ fontSize: 'var(--t-xl)' }}>pokemonkarten.at Admin</h1>
        {err && (
          <p className="notice notice--err">
            {ERRORS[err] ?? 'Anmeldung fehlgeschlagen.'}
            {aadsts}
          </p>
        )}
        <a className="btn" href="/admin/auth/login" aria-disabled={!entraConfigured()}>
          Mit Microsoft anmelden
        </a>
        {devLoginAllowed() && (
          <form action={devLogin}>
            <button className="btn btn--quiet" type="submit">
              Lokal ohne Microsoft anmelden (nur Entwicklung)
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
