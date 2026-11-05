import type { MetadataRoute } from 'next';
import { config } from '@/server/config';

export const dynamic = 'force-dynamic';

export default function robots(): MetadataRoute.Robots {
  const staging = config.baseUrl.includes('staging.');
  return {
    rules: staging
      ? { userAgent: '*', disallow: '/' }
      : { userAgent: '*', allow: '/', disallow: ['/admin', '/api'] },
    sitemap: staging ? undefined : `${config.baseUrl}/sitemap.xml`,
  };
}
