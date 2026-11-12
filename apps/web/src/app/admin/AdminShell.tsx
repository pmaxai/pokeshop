import type { AdminUser } from '@/server/admin-auth';
import { logout } from './actions';
import { contactCounts } from '@pokeshop/core/contact';
import { db } from '@/server/config';

const LINKS = [
  { href: '/admin', label: 'Übersicht', key: 'home' },
  { href: '/admin/bestellungen', label: 'Bestellungen', key: 'orders' },
  { href: '/admin/produkte', label: 'Produkte', key: 'products' },
  { href: '/admin/kategorien', label: 'Kategorien', key: 'categories' },
  { href: '/admin/gutscheine', label: 'Gutscheine', key: 'vouchers' },
  { href: '/admin/rabattcodes', label: 'Rabattcodes', key: 'codes' },
  { href: '/admin/app', label: 'App', key: 'app' },
  { href: '/admin/widerrufe', label: 'Widerrufe', key: 'withdrawals' },
  { href: '/admin/nachrichten', label: 'Nachrichten', key: 'messages' },
  { href: '/admin/veranstaltungen', label: 'Veranstaltungen', key: 'events' },
  { href: '/admin/einstellungen', label: 'Einstellungen', key: 'settings', owner: true },
  { href: '/admin/api-keys', label: 'API-Schlüssel', key: 'keys', owner: true },
] as const;

export async function AdminShell({
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
  // Unread contact messages, shown next to "Nachrichten" on every admin page.
  const { unread } = await contactCounts(db());
  return (
    <>
      <header className="admin-bar">
        <div className="wrap">
          <strong>Overpriced Cardboard</strong>
          <nav style={{ display: 'flex', gap: 'var(--s-4)' }} aria-label="Admin">
            {LINKS.filter((l) => !('owner' in l) || user.role === 'owner').map((l) => (
              <a key={l.key} href={l.href} aria-current={active === l.key ? 'page' : undefined}>
                {l.label}
                {l.key === 'messages' && unread > 0 && (
                  <span className="admin-count" aria-label={`${unread} ungelesen`}>
                    {unread}
                  </span>
                )}
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
