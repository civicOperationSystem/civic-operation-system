import { expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';

export const FRONTEND_URL = 'http://127.0.0.1:3310';
export const MAP_FRAME = 'iframe[title="Interactive CivicOS community map"]';

const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
const userIds = new Map();

// The fake Supabase server (supabase.mjs) accepts these unsigned tokens for any email.
export function magicLinkToken(email) {
  const now = Math.floor(Date.now() / 1000);
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({
    sub: userIds.get(email) || userIds.set(email, randomUUID()).get(email),
    email, aud: 'authenticated', role: 'authenticated', iat: now, exp: now + 3600,
  })}.e2e-signature`;
}

export function magicLinkCallback(path, email) {
  const token = magicLinkToken(email);
  return `${path}${path.includes('?') ? '&' : '?'}e2e_auth_callback=${randomUUID()}#access_token=${encodeURIComponent(token)}&refresh_token=e2e-refresh&token_type=bearer&type=magiclink&expires_in=3600`;
}

async function unlockOfflineData(page) {
  const passphrase = page.getByLabel('Offline passphrase', { exact: true });
  if (!(await passphrase.count())) return;
  await passphrase.fill('CivicOS-offline-test-passphrase');
  const confirmation = page.getByLabel('Confirm offline passphrase');
  if (await confirmation.count()) {
    await confirmation.fill('CivicOS-offline-test-passphrase');
  }
  await page.getByRole('button', { name: /Set passphrase|Unlock offline data/ }).click();
}

export async function signInWithMagicLink(page, path, slug, email) {
  await page.goto(`${FRONTEND_URL}/${path}?org=${slug}`);
  await unlockOfflineData(page);
  await expect(page.getByLabel('Organization')).toHaveAttribute('readonly', '');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Email me a sign-in link' }).click();
  await expect(page.getByRole('status')).toContainText('one-time sign-in link has been sent');
  await page.goto(magicLinkCallback(`${FRONTEND_URL}/${path}?org=${slug}`, email));
  await unlockOfflineData(page);
}

// Chromium does not render off-screen cross-origin iframes, so the map never finishes loading until it is scrolled into view.
export async function waitForMap(iframe) {
  await iframe.scrollIntoViewIfNeeded();
  await expect(iframe.contentFrame().locator('section[aria-busy="false"]')).toBeVisible({ timeout: 30000 });
}
