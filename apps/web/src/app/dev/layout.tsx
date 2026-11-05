import '../globals.css';

export const metadata = { robots: { index: false, follow: false } };

export default function DevLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="de">
      <body>
        <main id="main" className="wrap" style={{ paddingBlock: '3rem' }}>
          {children}
        </main>
      </body>
    </html>
  );
}
