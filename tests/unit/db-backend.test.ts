import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub every db backend module so this file never touches WASM or TCP —
// it asserts WHICH backend getDb() selects and how it is wired.
const mocks = vi.hoisted(() => ({
  db: { __backendStub: true } as Record<string, unknown>,
  poolConfigs: [] as { connectionString?: string }[],
  nodeDrizzleCalls: 0,
  nodeMigrateCalls: [] as { migrationsFolder?: string }[],
  pgliteBoots: 0,
  pgliteDrizzleCalls: 0,
  pgliteMigrateCalls: [] as { migrationsFolder?: string }[],
  failNextNodeMigrate: false,
}));

vi.mock('pg', () => ({
  Pool: class FakePool {
    constructor(config: { connectionString?: string }) {
      mocks.poolConfigs.push(config);
    }
  },
}));

vi.mock('drizzle-orm/node-postgres', () => ({
  drizzle: () => {
    mocks.nodeDrizzleCalls += 1;
    return mocks.db;
  },
}));

vi.mock('drizzle-orm/node-postgres/migrator', () => ({
  migrate: async (_db: unknown, config: { migrationsFolder?: string }) => {
    mocks.nodeMigrateCalls.push(config);
    if (mocks.failNextNodeMigrate) {
      mocks.failNextNodeMigrate = false;
      throw new Error('simulated boot failure');
    }
  },
}));

vi.mock('@electric-sql/pglite', () => ({
  PGlite: class FakePGlite {
    constructor() {
      mocks.pgliteBoots += 1;
    }
  },
}));

vi.mock('drizzle-orm/pglite', () => ({
  drizzle: () => {
    mocks.pgliteDrizzleCalls += 1;
    return mocks.db;
  },
}));

vi.mock('drizzle-orm/pglite/migrator', () => ({
  migrate: async (_db: unknown, config: { migrationsFolder?: string }) => {
    mocks.pgliteMigrateCalls.push(config);
  },
}));

const ORIGINAL_URL_TEST = process.env.DATABASE_URL_TEST;

beforeEach(() => {
  vi.resetModules();
  mocks.poolConfigs.length = 0;
  mocks.nodeDrizzleCalls = 0;
  mocks.nodeMigrateCalls.length = 0;
  mocks.pgliteBoots = 0;
  mocks.pgliteDrizzleCalls = 0;
  mocks.pgliteMigrateCalls.length = 0;
  mocks.failNextNodeMigrate = false;
  delete process.env.DATABASE_URL_TEST;
});

afterEach(() => {
  if (ORIGINAL_URL_TEST === undefined) {
    delete process.env.DATABASE_URL_TEST;
  } else {
    process.env.DATABASE_URL_TEST = ORIGINAL_URL_TEST;
  }
});

describe('selectTestBackend (branch-selection seam)', () => {
  it('picks node-postgres when DATABASE_URL_TEST is set (CI: postgres:16 service)', async () => {
    const { selectTestBackend } = await import('@/db');
    expect(selectTestBackend('postgresql://postgres:postgres@localhost:5432/superparakimi_test')).toBe(
      'node-postgres',
    );
  });

  it('falls back to pglite when DATABASE_URL_TEST is unset or empty (local)', async () => {
    const { selectTestBackend } = await import('@/db');
    expect(selectTestBackend(undefined)).toBe('pglite');
    expect(selectTestBackend('')).toBe('pglite');
  });
});

describe('getDb backend wiring', () => {
  it('uses pg.Pool + node-postgres migrator over TCP when DATABASE_URL_TEST is set', async () => {
    const url = 'postgresql://postgres:postgres@localhost:5432/superparakimi_test';
    process.env.DATABASE_URL_TEST = url;
    const { getDb } = await import('@/db');
    const db = await getDb();
    expect(mocks.poolConfigs).toEqual([{ connectionString: url }]);
    expect(mocks.nodeDrizzleCalls).toBe(1);
    expect(mocks.nodeMigrateCalls).toHaveLength(1);
    expect(mocks.nodeMigrateCalls[0]?.migrationsFolder).toContain('drizzle');
    expect(mocks.pgliteBoots).toBe(0);
    expect(db).toBe(mocks.db);
  });

  it('boots in-process PGlite with pglite migrator when DATABASE_URL_TEST is unset', async () => {
    const { getDb } = await import('@/db');
    const db = await getDb();
    expect(mocks.pgliteBoots).toBe(1);
    expect(mocks.pgliteDrizzleCalls).toBe(1);
    expect(mocks.pgliteMigrateCalls).toHaveLength(1);
    expect(mocks.pgliteMigrateCalls[0]?.migrationsFolder).toContain('drizzle');
    expect(mocks.nodeDrizzleCalls).toBe(0);
    expect(mocks.poolConfigs).toHaveLength(0);
    expect(db).toBe(mocks.db);
  });

  it('does not poison the singleton on boot failure — next getDb retries', async () => {
    process.env.DATABASE_URL_TEST = 'postgresql://postgres:postgres@localhost:5432/superparakimi_test';
    const { getDb } = await import('@/db');
    mocks.failNextNodeMigrate = true;
    await expect(getDb()).rejects.toThrow('simulated boot failure');
    // Rejection must not be cached: the next call retries and succeeds.
    const db = await getDb();
    expect(db).toBe(mocks.db);
    expect(mocks.nodeDrizzleCalls).toBe(2);
    expect(mocks.nodeMigrateCalls).toHaveLength(2);
  });
});

describe('selectRuntimeBackend (app backend + production guard)', () => {
  it('uses Neon whenever DATABASE_URL is present, in any environment', async () => {
    const { selectRuntimeBackend } = await import('@/db');
    expect(selectRuntimeBackend('production', 'postgresql://x')).toBe('neon');
    expect(selectRuntimeBackend('development', 'postgresql://x')).toBe('neon');
    expect(selectRuntimeBackend(undefined, 'postgresql://x')).toBe('neon');
  });

  it('allows the ephemeral PGlite backend in development only', async () => {
    const { selectRuntimeBackend } = await import('@/db');
    expect(selectRuntimeBackend('development', undefined)).toBe('dev-pglite');
    expect(selectRuntimeBackend('development', '')).toBe('dev-pglite');
  });

  // The whole point of the guard: an ephemeral database that boots "successfully"
  // in production and loses every row on the next cold start is worse than a
  // crash at startup.
  it('refuses to start without DATABASE_URL in production', async () => {
    const { selectRuntimeBackend } = await import('@/db');
    expect(() => selectRuntimeBackend('production', undefined)).toThrow(/DATABASE_URL is required/);
    expect(() => selectRuntimeBackend('production', '')).toThrow(/ephemeral/);
  });

  it('refuses when NODE_ENV is unset, not just when it says production', async () => {
    // An unconfigured NODE_ENV must not be treated as development.
    const { selectRuntimeBackend } = await import('@/db');
    expect(() => selectRuntimeBackend(undefined, undefined)).toThrow(/DATABASE_URL is required/);
    expect(() => selectRuntimeBackend('test', undefined)).toThrow(/DATABASE_URL is required/);
  });

  it('dev-pglite migrates and never opens a pg.Pool or a Neon connection', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    delete process.env.DATABASE_URL;
    process.env.DEV_PGLITE_DIR = '/tmp/parakimi-dev-db-test';
    const { getDb, devPgliteDir } = await import('@/db');
    const db = await getDb();
    expect(mocks.pgliteBoots).toBe(1);
    expect(mocks.pgliteDrizzleCalls).toBe(1);
    expect(mocks.pgliteMigrateCalls).toHaveLength(1);
    expect(mocks.pgliteMigrateCalls[0]?.migrationsFolder).toContain('drizzle');
    expect(mocks.nodeDrizzleCalls).toBe(0);
    expect(mocks.poolConfigs).toHaveLength(0);
    expect(db).toBe(mocks.db);
    expect(devPgliteDir()).toBe('/tmp/parakimi-dev-db-test');
    vi.unstubAllEnvs();
    delete process.env.DEV_PGLITE_DIR;
  });
});
