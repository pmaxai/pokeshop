import { NextResponse, type NextRequest } from 'next/server';
import createMiddleware from 'next-intl/middleware';
import { routing } from './i18n/routing';

const languageRouting = createMiddleware(routing);

// Until 2026-11-12 the German pages sat at the domain root. Old links (mails, bookmarks, search
// results) to a German-only path go to the same page under /de; paths both languages share
// (/sets, /app) now show English.
const germanOnly = Object.values(routing.pathnames)
  .flatMap((p) => (typeof p === 'string' ? [] : [p.de]))
  .map((de) => new RegExp(`^${de.replace(/\[\w+\]/g, '[^/]+')}$`));

// Pages that moved (the licence terms became the subscription terms on 2026-11-15).
const MOVED: Record<string, string> = {
  '/app/license-terms': '/app/subscription-terms',
  '/de/app/lizenzbedingungen': '/de/app/abo-bedingungen',
  '/app/lizenzbedingungen': '/de/app/abo-bedingungen',
};

// Language routing for the storefront only; API, admin, media and static files are left alone.
export default function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const moved = MOVED[pathname];
  if (moved) {
    const url = req.nextUrl.clone();
    url.pathname = moved;
    return NextResponse.redirect(url, 308);
  }
  if (germanOnly.some((r) => r.test(pathname))) {
    const url = req.nextUrl.clone();
    url.pathname = `/de${pathname}`;
    return NextResponse.redirect(url, 308);
  }
  return languageRouting(req);
}

// Set codes contain dots ("sv03.5"), so only real file extensions are excluded.
export const config = {
  matcher: [
    // r/<code>: affiliate links, no language prefix
    '/((?!api|admin|media|dev|r/|_next|_vercel|.*\\.(?:ico|png|jpe?g|svg|gif|webp|avif|txt|xml|json|js|css|map|woff2?|webmanifest)$).*)',
  ],
};
