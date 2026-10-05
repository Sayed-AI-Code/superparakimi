import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub every db backend module so this file never touches WASM or TCP —
// it asserts WHICH backend getDb() selects and how it is wired.
const mocks = vi.hoisted(() => ({
  db: { __backendStub: true } as Record<string, unknown>,
  poolConfigs: [] as { connectionString?: string }[],
  nodeDrizzleCalls: 0,
  nodeMigrateCalls: [] as { migrationsFolder?: string }[],
  pgliteBoots: 0,
  pgliteDataDirs: [] as (string | undefined)[],
  pgliteDrizzleCalls: 0,
  pgliteMigrateCalls: [] as { migrationsFolder?: string }[],
  neonUrls: [] as string[],
  neonDrizzleCalls: 0,
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
    constructor(dataDir?: string) {
      mocks.pgliteBoots += 1;
      mocks.pgliteDataDirs.push(dataDir);
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

vi.mock('@neondatabase/serverless', () => ({
  neon: (url: string) => {
    mocks.neonUrls.push(url);
    return { __neonStub: true };
  },
}));

vi.mock('drizzle-orm/neon-http', () => ({
  drizzle: () => {
    mocks.neonDrizzleCalls += 1;
    return mocks.db;
  },
}));

// The db singleton lives on globalThis (see DB_KEY in db/index.ts), so it
// survives vi.resetModules — a test that re-imports the module would otherwise
// inherit the previous test's connection and see zero boots. Reset both.
const DB_KEY = Symbol.for('superparakimi.db');

const ORIGINAL_URL_TEST = process.env.DATABASE_URL_TEST;
const ORIGINAL_URL = process.env.DATABASE_URL;
const ORIGINAL_POOL_MAX = process.env.PG_POOL_MAX;

beforeEach(() => {
  vi.resetModules();
  delete (globalThis as unknown as Record<symbol, unknown>)[DB_KEY];
  mocks.poolConfigs.length = 0;
  mocks.nodeDrizzleCalls = 0;
  mocks.nodeMigrateCalls.length = 0;
  mocks.pgliteBoots = 0;
  mocks.pgliteDataDirs.length = 0;
  mocks.pgliteDrizzleCalls = 0;
  mocks.pgliteMigrateCalls.length = 0;
  mocks.neonUrls.length = 0;
  mocks.neonDrizzleCalls = 0;
  mocks.failNextNodeMigrate = false;
  delete process.env.DATABASE_URL_TEST;
  delete process.env.DATABASE_URL;
  delete process.env.PG_POOL_MAX;
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (ORIGINAL_URL_TEST === undefined) {
    delete process.env.DATABASE_URL_TEST;
  } else {
    process.env.DATABASE_URL_TEST = ORIGINAL_URL_TEST;
  }
  if (ORIGINAL_URL === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = ORIGINAL_URL;
  }
  if (ORIGINAL_POOL_MAX === undefined) {
    delete process.env.PG_POOL_MAX;
  } else {
    process.env.PG_POOL_MAX = ORIGINAL_POOL_MAX;
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

  it('defaults to an in-memory dev database (no host path under Turbopack)', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    delete process.env.DATABASE_URL;
    delete process.env.DEV_PGLITE_DIR;
    const { devPgliteDataDir } = await import('@/db');
    expect(devPgliteDataDir()).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it('dev-pglite migrates and never opens a pg.Pool or a Neon connection', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    delete process.env.DATABASE_URL;
    process.env.DEV_PGLITE_DIR = '/tmp/parakimi-dev-db-test';
    const { getDb, devPgliteDataDir } = await import('@/db');
    const db = await getDb();
    expect(mocks.pgliteBoots).toBe(1);
    expect(mocks.pgliteDataDirs).toEqual(['/tmp/parakimi-dev-db-test']);
    expect(mocks.pgliteDrizzleCalls).toBe(1);
    expect(mocks.pgliteMigrateCalls).toHaveLength(1);
    // Migrations resolve from cwd in the dev branch: Turbopack's bundled
    // import.meta.dirname is not a real directory and breaks the migrator.
    expect(mocks.pgliteMigrateCalls[0]?.migrationsFolder).toBe(`${process.cwd()}/drizzle`);
    expect(mocks.nodeDrizzleCalls).toBe(0);
    expect(mocks.poolConfigs).toHaveLength(0);
    expect(db).toBe(mocks.db);
    expect(devPgliteDataDir()).toBe('/tmp/parakimi-dev-db-test');
    vi.unstubAllEnvs();
    delete process.env.DEV_PGLITE_DIR;
  });
});

describe('productionDriver (which driver a real DATABASE_URL uses)', () => {
  it('keeps Neon endpoints on the Neon HTTP driver', async () => {
    const { productionDriver } = await import('@/db');
    expect(productionDriver('postgresql://user:pw@ep-cool-123.neon.tech/db?sslmode=require')).toBe(
      'neon-http',
    );
    expect(productionDriver('postgres://ep-x.neon.tech/db')).toBe('neon-http');
  });

  it('routes every non-Neon host through the pg wire protocol', async () => {
    // Neon's driver speaks Neon's HTTP proxy, not Postgres, so it cannot serve
    // these. This is the branch the Playwright smoke depends on.
    const { productionDriver } = await import('@/db');
    expect(productionDriver('postgres://postgres@127.0.0.1:3112/postgres')).toBe('node-postgres');
    expect(productionDriver('postgresql://u:pw@db.internal:5432/app')).toBe('node-postgres');
    expect(productionDriver('postgresql://x@neon.example.com/db')).toBe('node-postgres');
  });

  it('refuses to guess when the URL is missing', async () => {
    const { productionDriver } = await import('@/db');
    expect(() => productionDriver(undefined)).toThrow(/requires a DATABASE_URL/);
    expect(() => productionDriver('')).toThrow(/requires a DATABASE_URL/);
  });
});

describe('pgPoolMax', () => {
  it('honours a sane explicit pool size', async () => {
    const { pgPoolMax } = await import('@/db');
    expect(pgPoolMax('1')).toBe(1);
    expect(pgPoolMax('20')).toBe(20);
  });

  it('falls back to the production default for unset or nonsense values', async () => {
    // A zero or negative pool would hang every request; the default must be
    // the production pool, never the smoke's serialized 1.
    const { pgPoolMax } = await import('@/db');
    expect(pgPoolMax(undefined)).toBe(10);
    expect(pgPoolMax('')).toBe(10);
    expect(pgPoolMax('0')).toBe(10);
    expect(pgPoolMax('-3')).toBe(10);
    expect(pgPoolMax('1.5')).toBe(10);
    expect(pgPoolMax('ten')).toBe(10);
  });
});

describe('production backend wiring', () => {
  it('opens a pg.Pool and does NOT migrate on boot', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.DATABASE_URL = 'postgres://postgres@127.0.0.1:3112/postgres';
    const { getDb } = await import('@/db');
    const db = await getDb();
    expect(mocks.poolConfigs).toEqual([{ connectionString: process.env.DATABASE_URL, max: 10 }]);
    expect(mocks.nodeDrizzleCalls).toBe(1);
    // Schema ownership stays with the deployment, not with a request path.
    expect(mocks.nodeMigrateCalls).toHaveLength(0);
    expect(mocks.pgliteBoots).toBe(0);
    expect(mocks.neonDrizzleCalls).toBe(0);
    expect(db).toBe(mocks.db);
  });

  it('honours PG_POOL_MAX for the smoke, whose backend is single-connection', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.DATABASE_URL = 'postgres://postgres@127.0.0.1:3112/postgres';
    process.env.PG_POOL_MAX = '1';
    const { getDb } = await import('@/db');
    await getDb();
    expect(mocks.poolConfigs).toEqual([
      { connectionString: 'postgres://postgres@127.0.0.1:3112/postgres', max: 1 },
    ]);
  });

  it('uses the Neon HTTP driver for a Neon URL and never opens a pool', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.DATABASE_URL = 'postgresql://u:pw@ep-1.neon.tech/db';
    const { getDb } = await import('@/db');
    await getDb();
    expect(mocks.neonUrls).toEqual(['postgresql://u:pw@ep-1.neon.tech/db']);
    expect(mocks.neonDrizzleCalls).toBe(1);
    expect(mocks.poolConfigs).toHaveLength(0);
    expect(mocks.nodeDrizzleCalls).toBe(0);
  });

  it('shares ONE pool across repeat calls — two pools meant two sockets and a dead smoke', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    process.env.DATABASE_URL = 'postgres://postgres@127.0.0.1:3112/postgres';
    const { getDb } = await import('@/db');
    const first = await getDb();
    const second = await getDb();
    expect(second).toBe(first);
    expect(mocks.poolConfigs).toHaveLength(1);
    expect(mocks.nodeDrizzleCalls).toBe(1);
  });

  it('shares the pool through a fresh module instance, which is the real bug', async () => {
    // The production server evaluates db/index.ts separately per bundle
    // runtime, so a module-scoped memo hands out a second pool. Forcing a
    // reload and clearing only the module registry (not globalThis) proves the
    // singleton is genuinely global and not just cached per copy.
    vi.stubEnv('NODE_ENV', 'production');
    process.env.DATABASE_URL = 'postgres://postgres@127.0.0.1:3112/postgres';
    const first = await (await import('@/db')).getDb();
    vi.resetModules();
    const second = await (await import('@/db')).getDb();
    expect(second).toBe(first);
    expect(mocks.poolConfigs).toHaveLength(1);
  });
});
