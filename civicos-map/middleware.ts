import { NextRequest, NextResponse } from 'next/server';

function allowedParents(): string[] {
  return (process.env.NEXT_PUBLIC_CIVIC_PARENT_ORIGINS || 'http://localhost:3100')
    .split(',')
    .map(value => value.trim())
    .filter(value => {
      try {
        const parsed = new URL(value);
        return parsed.origin === value && ['http:', 'https:'].includes(parsed.protocol);
      } catch { return false; }
    });
}

export function middleware(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const development = process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : '';
  const parents = allowedParents();
  parents.push(request.nextUrl.origin);
  const policy = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    `frame-ancestors 'self' ${parents.join(' ')}`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://tiles.openfreemap.org",
    "font-src 'self' data: https://tiles.openfreemap.org",
    "connect-src 'self' https://tiles.openfreemap.org",
    "worker-src 'self' blob:",
  ].join('; ');
  const headers = new Headers(request.headers);
  headers.set('Content-Security-Policy', policy);
  headers.set('x-nonce', nonce);
  const response = NextResponse.next({ request: { headers } });
  response.headers.set('Content-Security-Policy', policy);
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
