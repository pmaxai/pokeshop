import type { AdminUser } from '@/server/admin-auth';
import { logout } from './actions';

const LINKS = [
  { href: '/admin', label: 'Übersicht', key: 'home' },
  { href: '/admin/produkte', label: 'Produkte', key: 'products' },
  { href: '/admin/api-keys', label: 'API-Schlüssel', key: 'keys', owner: true },
] as const;

export function AdminShell({
  user,
  active,
  notice,
  children,
}: {
  user: AdminUser;
  active: (typeof LINKS)[number]['key'];
  notice?: { ok?: string | undefined; err?: string | undefined };
  children: React.ReactNode;
}) {
  return (
    <>
      <header className="admin-bar">
        <div className="wrap">
          <strong>pokemonkarten.at</strong>
          <nav style={{ display: 'flex', gap: 'var(--s-4)' }} aria-label="Admin">
            {LINKS.filter((l) => !('owner' in l) || user.role === 'owner').map((l) => (
              <a key={l.key} href={l.href} aria-current={active === l.key ? 'page' : undefined}>
                {l.label}
              </a>
            ))}
            <a href="/" target="_blank" rel="noreferrer">
              Shop ansehen
            </a>
          </nav>
          <form action={logout} className="who">
            <span>
              {user.name ?? user.email} ({user.role === 'owner' ? 'Inhaber' : 'Mitarbeiter'})
            </span>
            <button type="submit">Abmelden</button>
          </form>
        </div>
      </header>
      <main className="wrap">
        {notice?.ok && (
          <p className="notice notice--ok" role="status">
            {notice.ok}
          </p>
        )}
        {notice?.err && (
          <p className="notice notice--err" role="alert">
            {notice.err}
          </p>
        )}
        {children}
      </main>
    </>
  );
}
