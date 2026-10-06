import {
  bigint,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// App users. Column names follow Auth.js v5 adapter expectations
// (see @auth/drizzle-adapter), extended with app-specific fields.
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name'),
  email: text('email').notNull().unique(),
  emailVerified: timestamp('email_verified', { mode: 'date' }),
  image: text('image'),
  passwordHash: text('password_hash'),
  plan: text('plan').notNull().default('free'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const accounts = pgTable(
  'accounts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: text('type').notNull(),
    provider: text('provider').notNull(),
    providerAccountId: text('provider_account_id').notNull(),
    refresh_token: text('refresh_token'),
    refresh_token_expires_in: integer('refresh_token_expires_in'),
    access_token: text('access_token'),
    expires_at: integer('expires_at'),
    token_type: text('token_type'),
    scope: text('scope'),
    id_token: text('id_token'),
    session_state: text('session_state'),
  },
  (t) => [uniqueIndex('accounts_provider_provider_account_id_idx').on(t.provider, t.providerAccountId)],
);

export const sessions = pgTable(
  'sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    sessionToken: text('session_token').notNull().unique(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expires: timestamp('expires', { mode: 'date' }).notNull(),
  },
);

export const verificationTokens = pgTable(
  'verification_tokens',
  {
    identifier: text('identifier').notNull(),
    token: text('token').notNull(),
    expires: timestamp('expires', { mode: 'date' }).notNull(),
  },
  (t) => [uniqueIndex('verification_tokens_identifier_token_idx').on(t.identifier, t.token)],
);

export const usageEvents = pgTable(
  'usage_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    charsIn: integer('chars_in').notNull(),
    charsOut: integer('chars_out'),
    model: text('model').notNull(),
    mode: text('mode').notNull(),
    strength: text('strength').notNull(),
    status: text('status').notNull().$type<'streaming' | 'completed' | 'aborted'>(),
    correlationId: uuid('correlation_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Quota checks (10/day free tier) aggregate by (user, UTC day).
  (t) => [index('usage_events_user_id_created_at_idx').on(t.userId, t.createdAt)],
);

/**
 * Shared per-caller request counters, one row per (bucket, fixed window).
 *
 * This table exists because the process-local Map in lib/ratelimit.ts cannot
 * work where the app is deployed. Vercel runs the /api/* handlers as default
 * Node serverless functions with no pinning and no vercel.json, so every warm
 * Lambda holds its own copy of that Map and a cold start empties it: ten
 * instances mean a caller can spend ten times the documented limit. Putting
 * the count in Postgres makes it one number that every instance reads and
 * writes, which is the only shape of "10 requests per minute" that is true
 * across instances.
 *
 * window_start is the epoch-aligned start of the window
 * (floor(now / RATE_WINDOW_MS) * RATE_WINDOW_MS), stored as a bigint so the
 * primary key is the whole identity of a window and an expired window can
 * never be mistaken for a live one by a caller with a skewed clock. It is a
 * fixed rather than a sliding window: the quota refills all at once on the
 * minute boundary, and the cost of that is a caller who can double-burst
 * across two adjacent boundaries. Accepted — a sliding window needs either a
 * timestamped list per caller or sorted-set infrastructure, and this is an
 * abuse brake, not a wall.
 *
 * A denial writes nothing, so `count` always means "requests taken in this
 * window" and never exceeds the limit it was measured against.
 */
export const rateLimitBuckets = pgTable(
  'rate_limit_buckets',
  {
    bucketKey: text('bucket_key').notNull(),
    windowStart: bigint('window_start', { mode: 'number' }).notNull(),
    count: integer('count').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.bucketKey, t.windowStart] }),
    // Pruning sweeps by age across every bucket; the composite PK above is
    // useless for that query because window_start is not its leading column.
    index('rate_limit_buckets_window_start_idx').on(t.windowStart),
  ],
);
