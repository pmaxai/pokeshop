import type { MetadataRoute } from 'next';
import { config } from '@/server/config';

export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  const staging = config.baseUrl.includes('staging.');
  return {
    rules: staging
      ? { userAgent: '*', disallow: '/' }
      : {
          userAgent: '*',
          allow: '/',
          // Cart, checkout and the private pages behind a token, in both languages.
          disallow: [
            '/admin',
            '/api',
            '/dev',
            '/cart',
            '/checkout',
            '/order/',
            '/gift-vouchers/',
            '/app/license/',
            '/de/warenkorb',
            '/de/kasse',
            '/de/bestellung/',
            '/de/gutscheine/',
            '/de/app/lizenz/',
          ],
        },
    sitemap: staging ? undefined : `${config.baseUrl}/sitemap.xml`,
  };
}
