import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';

const withNextIntl = createNextIntlPlugin('./src/i18n/request.ts');

const config: NextConfig = {
  transpilePackages: ['@pokeshop/core'],
  // pdfkit reads its font files from node_modules at runtime (gift voucher PDFs).
  serverExternalPackages: ['postgres', 'sharp', 'pdfkit'],
  poweredByHeader: false,
  reactStrictMode: true,
  typedRoutes: false,
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
