import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

// Language routing for the storefront only; API, admin, media and static files are left alone.
// Set codes contain dots ("sv03.5"), so only real file extensions are excluded.
export default createMiddleware(routing);

export const config = {
  matcher: [
    '/((?!api|admin|media|dev|_next|_vercel|.*\\.(?:ico|png|jpe?g|svg|gif|webp|avif|txt|xml|json|js|css|map|woff2?|webmanifest)$).*)',
  ],
};
