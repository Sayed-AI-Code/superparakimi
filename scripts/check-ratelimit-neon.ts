// Verifies the shared rate-limit store against the REAL Neon endpoint.
//
// Why a separate script rather than reusing tests/integration/ratelimit-shared.test.ts:
// that suite runs under NODE_ENV=test and its beforeEach calls resetTestDb(),
// which TRUNCATEs users, accounts, sessions and usage_events. Pointing it at
// production Neon would delete every real account. This script never truncates
// and never writes outside a bucket key it just minted, and it deletes that key
// when it is done — so it is safe to run against the live database.
//
// What it proves that the test suite cannot: the Neon HTTP driver, which no
// test on this host or in CI reaches (CI uses postgres:16 over TCP, local uses
// in-process PGlite). Two separate `neon()` clients are two separate HTTPS
// connections with no shared process state, which is the closest available
// stand-in for two warm Vercel Lambdas — the exact thing the in-memory Map
// could not do.
//
// Usage: set -a && . ./.env.local && set +a && npx tsx scripts/check-ratelimit-neon.ts

import { neon } from '@neondatabase/serverless';
import { sql as drizzleSql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/neon-http';

import * as schema from '../db/schema';
import { rateLimitBuckets } from '../db/schema';
import { ANON_LIMIT_60S, RATE_WINDOW_MS, sharedCheckRate } from '../lib/ratelimit';

function windowStartFor(now: number): number {
  return Math.floor(now / RATE_WINDOW_MS) * RATE_WINDOW_MS;
}

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');

  const bucketKey = `verify:neon:${crypto.randomUUID()}`;
  const limit = ANON_LIMIT_60S;

  // Two clients. The Neon HTTP driver is stateless per call, so these are
  // genuinely independent connections to the same endpoint — instance A and
  // instance B.
  const instanceA = drizzle(neon(url), { schema });
  const instanceB = drizzle(neon(url), { schema });

  const now = Date.now();
  console.log(` Neon store check — bucket ${bucketKey}, limit ${limit}/60s`);

  const taken: number[] = [];
  const allowed: number[] = [];
  // Alternate instances so every increment has to be read back through the
  // other one to be honest.
  for (let i = 0; i < limit; i++) {
    const store = i % 2 === 0 ? instanceA : instanceB;
    const res = await sharedCheckRate(store, bucketKey, limit, RATE_WINDOW_MS, now);
    taken.push(i + 1);
    if (res.allowed) allowed.push(i + 1);
  }
  console.log(` took ${allowed.length}/${limit} allowed across two instances`);

  const deniedByIdleInstance = await sharedCheckRate(
    // The instance that only ever made the even-numbered calls has counted 5
    // requests itself, so it cannot reach the 11th from local arithmetic alone.
    limit % 2 === 0 ? instanceA : instanceB,
    bucketKey,
    limit,
    RATE_WINDOW_MS,
    now + 1_000,
  );

  const rows = await instanceA
    .select({ count: rateLimitBuckets.count })
    .from(rateLimitBuckets)
    .where(
      drizzleSql`${rateLimitBuckets.bucketKey} = ${bucketKey}`,
    );

  const stored = rows[0]?.count ?? null;

  // Clean up after ourselves: this is the live database.
  await instanceA
    .delete(rateLimitBuckets)
    .where(drizzleSql`${rateLimitBuckets.bucketKey} = ${bucketKey}`);

  const verdicts: [string, boolean][] = [
    [`all ${limit} increments allowed`, allowed.length === limit],
    [`the ${limit + 1}th denied across instances`, deniedByIdleInstance.allowed === false],
    [`retryAfterSec is 0 < n <= 60`, deniedByIdleInstance.retryAfterSec > 0 && deniedByIdleInstance.retryAfterSec <= 60],
    [`row held exactly ${limit}, not ${limit + 1} (denial wrote nothing)`, stored === limit],
  ];

  console.log('');
  for (const [label, ok] of verdicts) {
    console.log(` ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  }

  const failed = verdicts.filter(([, ok]) => !ok);
  if (failed.length > 0) {
    console.error(`\n${failed.length} assertion(s) failed against Neon.`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nShared-store enforcement confirmed on the live Neon endpoint.`);
  console.log(`Window was ${windowStartFor(now)}; bucket rows removed afterwards.`);
}

main().catch((error: unknown) => {
  console.error('Neon rate-limit verification crashed:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
