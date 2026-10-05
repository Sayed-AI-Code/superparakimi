import { expect, test } from '@playwright/test';

/**
 * The slice-1 smoke (spec §10): sign up with email/password, reach /app,
 * paraphrase canned text against the mocked upstream, and watch the meter
 * decrement.
 *
 * Note the extra hop: signUpWithEmail does NOT create a session — it redirects
 * to /signin?registered=1 (see app/signup/page.tsx), so the honest flow signs
 * up and THEN signs in. Skipping that second step would mean the smoke never
 * actually exercised an authenticated generation, which is the entire point.
 */
// Fresh address per test: the dev database persists across the run, so a
// reused email would make the second test fail on "already registered" rather
// than on anything about the feature under test.
function newEmail(): string {
  return `smoke-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
}

const PASSWORD = 'correct-horse-battery';
const SOURCE_TEXT = 'The fox is quick and the dog is lazy.';
const CANNED_PARAPHRASE = 'The quick brown fox jumps over the lazy dog.';

test('sign up → sign in → paraphrase streams → meter decrements', async ({ page }) => {
  const EMAIL = newEmail();
  // 1. Sign up.
  await page.goto('/signup');
  await page.getByLabel(/email/i).fill(EMAIL);
  await page.getByLabel(/password/i).fill(PASSWORD);
  await page.getByRole('button', { name: /create account|sign up/i }).click();

  // Account created, but no session yet — the page hands off to /signin.
  await expect(page).toHaveURL(/\/signin\?registered=1/);

  // 2. Sign in.
  await page.getByLabel(/email/i).fill(EMAIL);
  await page.getByLabel(/password/i).fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();

  // 3. Authenticated workspace. Two separate meters say almost the same
  // sentence, so they get two locators rather than one regex that matches
  // both and trips Playwright's strict mode — and they are genuinely two
  // different facts: #usage-meter is the server-rendered nav read of the
  // quota straight out of the database, #usage-summary is the client's own
  // count, which only moves if the SSE round-trip actually landed.
  await expect(page).toHaveURL(/\/app/);
  await expect(page.locator('#usage-meter')).toContainText('10 of 10 left today');
  const summary = page.locator('#usage-summary');
  await expect(summary).toContainText('10 of 10 left today.');

  // 4. Paraphrase canned text.
  await page.locator('#source').fill(SOURCE_TEXT);
  await page.getByRole('button', { name: 'Paraphrase', exact: true }).click();

  // 5. The full canned text lands in the output pane. Asserting the whole
  // string (not just "is non-empty") is what proves the SSE frames were
  // reassembled across chunk boundaries rather than partially rendered.
  const output = page.locator('pre[data-status]');
  await expect(output).toBeVisible();
  await expect(output).toContainText(CANNED_PARAPHRASE, { timeout: 30_000 });

  // 6. Meter decremented — the quota was actually consumed and reported.
  await expect(summary).toContainText('9 of 10 left today.', { timeout: 15_000 });

  // 7. Sending is possible again (the button re-enabled once the stream
  // ended) — proves the streaming flag cleared rather than the UI hanging.
  await expect(page.getByRole('button', { name: 'Paraphrase', exact: true })).toBeEnabled();
});

test('a second generation decrements to 8 and the button gates at zero', async ({ page }) => {
  const EMAIL = newEmail();
  await page.goto('/signup');
  await page.getByLabel(/email/i).fill(EMAIL);
  await page.getByLabel(/password/i).fill(PASSWORD);
  await page.getByRole('button', { name: /create account|sign up/i }).click();
  await expect(page).toHaveURL(/\/signin\?registered=1/);

  await page.getByLabel(/email/i).fill(EMAIL);
  await page.getByLabel(/password/i).fill(PASSWORD);
  await page.getByRole('button', { name: /sign in/i }).click();
  await expect(page).toHaveURL(/\/app/);

  const summary = page.locator('#usage-summary');
  const output = page.locator('pre[data-status]');

  await page.locator('#source').fill(SOURCE_TEXT);
  await page.getByRole('button', { name: 'Paraphrase', exact: true }).click();
  await expect(output).toContainText(CANNED_PARAPHRASE, { timeout: 30_000 });
  await expect(summary).toContainText('9 of 10 left today.', { timeout: 15_000 });

  // Second run: two upstream calls total, meter at 8.
  await page.locator('#source').fill('Another sentence to rewrite please.');
  await page.getByRole('button', { name: 'Paraphrase', exact: true }).click();
  await expect(output).toContainText(CANNED_PARAPHRASE, { timeout: 30_000 });
  await expect(summary).toContainText('8 of 10 left today.', { timeout: 15_000 });
});
