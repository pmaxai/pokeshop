import { redirect } from 'next/navigation';
import { currentAdmin, devLoginAllowed, entraConfigured } from '@/server/admin-auth';
import { devLogin } from '../actions';

export const dynamic = 'force-dynamic';
export const metadata = { title: 'Anmelden' };

const ERRORS: Record<string, string> = {
  entra:
    'Die Microsoft-Anmeldung ist noch nicht eingerichtet (ENTRA_TENANT_ID, ENTRA_CLIENT_ID, ENTRA_CLIENT_SECRET).',
  state: 'Die Anmeldung ist abgelaufen. Bitte noch einmal anmelden.',
  token: 'Microsoft hat die Anmeldung nicht bestätigt. Bitte noch einmal versuchen.',
  tenant: 'Dieses Konto gehört nicht zu eurem Microsoft-365-Mandanten.',
  not_allowed:
    'Dein Konto ist nicht für den Admin freigeschaltet. Es muss in der Gruppe „Shop-Admins“ oder „Shop-Staff“ sein.',
  cancelled: 'Die Anmeldung wurde abgebrochen.',
};

export default async function Login({ searchParams }: { searchParams: Promise<{ err?: string }> }) {
  if (await currentAdmin()) redirect('/admin');
  const { err } = await searchParams;
  return (
    <main>
      <div className="login">
        <h1 style={{ fontSize: 'var(--t-xl)' }}>pokemonkarten.at Admin</h1>
        {err && <p className="notice notice--err">{ERRORS[err] ?? 'Anmeldung fehlgeschlagen.'}</p>}
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
