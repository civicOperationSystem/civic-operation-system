import { NextRequest, NextResponse } from 'next/server';

function originFrom(value: string | undefined, fallback: string): string {
  try { return new URL(value || fallback).origin; }
  catch { return fallback; }
}

export function middleware(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const mapOrigin = originFrom(process.env.NEXT_PUBLIC_CIVIC_MAP_URL, 'https://civicos-map.vercel.app/civic');
  const supabaseOrigin = originFrom(process.env.NEXT_PUBLIC_SUPABASE_URL, 'https://*.supabase.co');
  const websocketOrigin = supabaseOrigin.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:');
  const development = process.env.NODE_ENV === 'development' ? " 'unsafe-eval'" : '';
  const policy = [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "form-action 'self'",
    "frame-ancestors 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development}`,
    "style-src 'self' 'unsafe-inline'",
    `img-src 'self' data: blob: ${supabaseOrigin} https://tiles.openfreemap.org`,
    `font-src 'self' data: ${supabaseOrigin}`,
    `connect-src 'self' ${supabaseOrigin} ${websocketOrigin} https://tiles.openfreemap.org`,
    `frame-src 'self' ${mapOrigin}`,
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
