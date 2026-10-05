/**
 * The Free plan's daily generation allowance — the single source of truth.
 *
 * This lives in its own dependency-free module on purpose. `FREE_DAILY_LIMIT`
 * used to be declared in `lib/quota/quotaService.ts`, which imports `@/db`
 * (and through it `pg`, `PGlite` and `node:path`). A `'use client'` component
 * importing the constant from there drags the entire Postgres driver into the
 * browser bundle, which `next build` rejects outright with module-not-found on
 * `node:crypto`/`node:fs` from `pg/lib/utils.js`.
 *
 * So: server code may import this from either place (quotaService re-exports
 * it, so existing call sites are unchanged); client code MUST import from here.
 * Adding an import to this file can break the build — keep it constants only.
 */
export const FREE_DAILY_LIMIT = 10;
