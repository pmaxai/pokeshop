import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { routing } from './src/i18n/routing';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

// Until 2026-11-12 the German pages sat at the domain root. Old links (mails, bookmarks, search
// results) to a German-only path go to the same page under /de.
const germanRootRedirects = Object.values(routing.pathnames)
  .flatMap((p) => (typeof p === 'string' || p.de === p.en ? [] : [p.de]))
  .map((de) => de.replace(/\[(\w+)\]/g, ':$1'))
  .map((source) => ({ source, destination: `/de${source}`, permanent: true }));

const config: NextConfig = {
  transpilePackages: ['@pokeshop/core'],
  // pdfkit reads its font files from node_modules at runtime (gift voucher PDFs).
  serverExternalPackages: ['postgres', 'sharp', 'pdfkit'],
  poweredByHeader: false,
  reactStrictMode: true,
  typedRoutes: false,
  async redirects() {
    return germanRootRedirects;
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
        ],
      },
    ];
  },
};

export default withNextIntl(config);
