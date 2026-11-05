import '../globals.css';
import './admin.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: { default: 'Admin', template: '%s | Admin pokemonkarten.at' },
  robots: { index: false, follow: false },
};

// The admin is German only and has its own root layout (no shop header or footer).
export default function AdminRootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de-AT">
      <body className="admin">{children}</body>
    </html>
  );
}
