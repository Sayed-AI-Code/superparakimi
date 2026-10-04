# Paraphrasing SaaS Slice 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a public paraphrasing web app with Auth.js sign-in, OpenRouter-streamed rewrites in 6 tones × 3 strengths, and a hard free tier of 10 requests/day/user.

**Architecture:** Lean Next.js 15 (App Router) monolith on Vercel; Neon Postgres via Drizzle; all OpenRouter calls inside route handlers behind a `paraphraseProvider` seam; quota enforced by a `quotaService` seam whose single consumption trigger is the first upstream text delta.

**Tech Stack:** Next.js 15 + React 19 + TypeScript, Tailwind CSS v4, Auth.js v5 (Google + credentials), Drizzle ORM + `@neondatabase/serverless`, `openai` SDK (OpenRouter baseURL), Vitest, Playwright, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-10-04-paraphrase-saas-slice1-design.md`

## Global Constraints

- Max input per request: **5,000 characters** (zod + client counter; server authoritative).
- Free quota: **10 requests/day/user**, day boundary **UTC**.
- Upstream timeout: **120 seconds** (`AbortSignal` composed inside provider).
- Default model: `openai/gpt-4o-mini`, overridable via `PARAPHRASE_MODEL` env.
- IP rate limits: **10 req/min anonymous, 30 req/min authenticated** on `/api/*`.
- Passwords: **bcrypt cost 12** via `bcryptjs` (no native builds on Vercel).
- `OPENROUTER_API_KEY`, `AUTH_SECRET`, `DATABASE_URL`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`: env vars only, never in client bundles, never logged.
- Modes (verbatim): Standard, Fluent, Simple, Formal, Creative, Academic — ids `standard|fluent|simple|formal|creative|academic`. Strengths: `light|medium|strong`.
- SSE frames (one JSON object per `data:` line): `{"type":"delta","text":"…"}`, terminal `{"type":"done","remaining":N}`, failure `{"type":"error","message":"…"}`.
- Quota row created on **first text delta**; pre-delta failures write **no row**.
- Output rendered as plain text; no `dangerouslySetInnerHTML` anywhere.

## File Structure

```
app/layout.tsx · globals.css            app/page.tsx (landing)
app/signin/page.tsx · app/signup/page.tsx · app/account/page.tsx
app/app/page.tsx → components/Workspace.tsx (client)
app/api/auth/[...nextauth]/route.ts · app/api/usage/route.ts · app/api/paraphrase/route.ts
middleware.ts
lib/auth.config.ts (edge-safe) · lib/auth.ts (full) · lib/auth/passwords.ts
lib/validation.ts · lib/mode/prompts.ts
lib/quota/quotaService.ts · lib/paraphrase/types.ts · lib/paraphrase/openrouter.ts
lib/ratelimit.ts
db/schema.ts · db/index.ts · drizzle.config.ts · drizzle/ (migrations)
tests/unit/*.test.ts · tests/integration/*.test.ts · tests/e2e/*.spec.ts
.github/workflows/ci.yml · .env.example
```

## Review Focus

Spec implies these but no task's happy-path tests cover them by default; each line gets a pinning test in the owning task.

1. Upstream returns 200 then dies with **zero deltas** → error frame, no usage row, quota untouched (Task 9).
2. User **navigates away mid-stream** (not Stop button) → abort propagates upstream, row `aborted` (Task 9).
3. Google-only account (NULL `password_hash`) submits the password sign-in form → clean "use Google" error, no crash (Task 8).
4. **UTC day vs local display**: `resetsAt` is UTC-truth; UI must render it in the viewer's timezone and never imply the wrong boundary (Task 10).
5. **Double-click Paraphrase** with 1 credit left → button disabled during stream; server accepts 2 concurrent requests only if quota allows both honestly (Task 10).

---

### Task 1: Scaffold & toolchain

**Files:**
- Create: Next.js app via `create-next-app` (TypeScript, Tailwind, ESLint, App Router, `src/` off) at repo root
- Create: `vitest.config.ts`, `tests/unit/toolchain.test.ts`, `.env.example`, `.github/workflows/ci.yml`
- Modify: `package.json` (scripts), `.gitignore` (append `.next/ coverage/ playwright-report/ test-results/ .env.test`)

**Interfaces:**
- Produces: working `npm run dev|build|lint|test`, `DATABASE_URL_TEST` available to Vitest; later tasks add modules under `lib/`, `db/`, `tests/` only.

- [ ] **Step 1: Scaffold**

```bash
cd /Users/sayed/Desktop/superpower/superparakimi
npx --yes create-next-app@latest . --ts --tailwind --eslint --app --no-src-dir --no-turbopack --import-alias "@/*" --use-npm
```

Keep `.gitignore`/`docs/` content already committed (`create-next-app` refuses a dirty dir only if conflicting files exist; if it refuses, scaffold in a temp dir and move contents up, preserving `docs/`).

- [ ] **Step 2: Install deps**

`npm i openai drizzle-orm @neondatabase/serverless next-auth@beta bcryptjs zod`; `npm i -D vitest @vitejs/plugin-react drizzle-kit @testing-library/react @testing-library/jest-dom jsdom @playwright/test @types/bcryptjs`.

- [ ] **Step 3: Wire Vitest + failing placeholder-free sanity test**

Create `vitest.config.ts` (environment `node`, include `tests/unit/**/*.test.ts`, alias `@` → repo root) and `tests/unit/toolchain.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
describe('toolchain', () => {
  it('runs vitest', () => { expect(1 + 1).toBe(2); });
});
```

Add scripts: `"test": "vitest run"`, `"test:watch": "vitest"`, `"db:generate": "drizzle-kit generate"`, `"db:migrate": "drizzle-kit migrate"`, `"test:e2e": "playwright test"`.

- [ ] **Step 4: Run `npm test && npm run build`** — both must pass.

- [ ] **Step 5: `.env.example`** with the 6 spec env vars + `DATABASE_URL_TEST`, commented one-liner each. **CI workflow**: job1 `typecheck+lint+vitest` with `postgres:16` service and `DATABASE_URL_TEST`; job2 Playwright on `main` only (real jobs wired in Task 12; here: `npm run test` + `npm run build`).

- [ ] **Step 6: Commit** `chore: scaffold Next.js 15 + vitest + CI skeleton`

### Task 2: Mode prompts

**Files:**
- Create: `lib/mode/prompts.ts`, `tests/unit/prompts.test.ts`

**Interfaces:**
- Produces: `type Mode = 'standard'|'fluent'|'simple'|'formal'|'creative'|'academic'`; `type Strength = 'light'|'medium'|'strong'`; `MODES: readonly {id: Mode; label: string}[]`; `STRENGTHS: readonly {id: Strength; label: string}[]`; `getSystemPrompt(mode: Mode, strength: Strength): string` (throws on unknown ids).

- [ ] **Step 1: Write failing test** `tests/unit/prompts.test.ts`

```ts
it('all 18 combinations return non-empty prompts', () => {
  for (const m of MODES) for (const s of STRENGTHS)
    expect(getSystemPrompt(m.id, s.id).length).toBeGreaterThan(40);
});
it('unknown mode throws', () => {
  expect(() => getSystemPrompt('pirate' as Mode, 'light')).toThrow();
});
```

- [ ] **Step 2: Run — FAIL** (`vitest run tests/unit/prompts.test.ts`)
- [ ] **Step 3: Implement** — pure map keyed `${mode}:${strength}`; base instruction ("You are a paraphrasing engine. Rewrite the user's text, preserving meaning. Output only the rewritten text.") + tone sentence per mode + depth sentence per strength. Throw `RangeError` on unknown key.
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5: Commit** `feat: mode x strength prompt table`

### Task 3: Validation schemas

**Files:**
- Create: `lib/validation.ts`, `tests/unit/validation.test.ts`

**Interfaces:**
- Consumes: `Mode`, `Strength` from `lib/mode/prompts.ts`.
- Produces: `MAX_INPUT_CHARS = 5000`; `paraphraseRequestSchema` (zod object `{text, mode, strength}`); `type ParaphraseRequest = z.infer<typeof paraphraseRequestSchema>`.

- [ ] **Step 1: Write failing test** — asserts: valid payload parses; `''`/whitespace-only fails; 5,001 chars fails, 5,000 passes; mode `'pirate'` fails; strength `''` fails; hostile payload `{"text":"<script>x</script>","mode":"standard","strength":"light"}` parses as **data** (no transform, no execution).

```ts
it('rejects 5001 chars, accepts 5000', () => {
  const ok = { text: 'a'.repeat(5000), mode: 'standard', strength: 'light' } as const;
  expect(paraphraseRequestSchema.safeParse(ok).success).toBe(true);
  expect(paraphraseRequestSchema.safeParse({ ...ok, text: 'a'.repeat(5001) }).success).toBe(false);
});
```

- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement** — `z.object({ text: z.string().trim().min(1).max(MAX_INPUT_CHARS), mode: z.enum([…6 ids…]), strength: z.enum(['light','medium','strong']) })`.
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5: Commit** `feat: shared zod validation`

### Task 4: Database schema, client, migration

**Files:**
- Create: `db/schema.ts`, `db/index.ts`, `drizzle.config.ts`, `drizzle/0000_*.sql` (generated), `tests/unit/schema.test.ts`

**Interfaces:**
- Produces: drizzle tables `users` (`id: uuid pk default random`, `email: text unique notNull`, `name: text`, `passwordHash: text` nullable, `plan: text default 'free'`, `createdAt: timestamptz default now`); `accounts`, `sessions` (Auth.js v5 adapter shapes: account/user/session relations per next-auth/drizzle-adapter); `usageEvents` (`id: uuid pk`, `userId: uuid fk→users`, `charsIn: integer`, `charsOut: integer` nullable, `model/text`, `mode/text`, `strength/text`, `status: text ∈ streaming|completed|aborted`, `correlationId: uuid`, `createdAt: timestamptz`, index `(userId, createdAt)`); `db` client (lazy singleton: `drizzle(neon(process.env.DATABASE_URL ?? process.env.DATABASE_URL_TEST!))` — chooses `DATABASE_URL_TEST` when `NODE_ENV==='test'`).

- [ ] **Step 1: Write failing round-trip test** `tests/unit/schema.test.ts` (needs `DATABASE_URL_TEST`; skip with message if unset):

```ts
it('round-trips a usage event with terminal status', async () => {
  const uid = crypto.randomUUID();
  await db.insert(users).values({ id: uid, email: `${uid}@t.dev` });
  const id = crypto.randomUUID();
  await db.insert(usageEvents).values({ id, userId: uid, charsIn: 100, model: 'm', mode: 'standard', strength: 'light', status: 'streaming', correlationId: crypto.randomUUID() });
  await db.update(usageEvents).set({ status: 'completed', charsOut: 90 }).where(eq(usageEvents.id, id));
  const [row] = await db.select().from(usageEvents).where(eq(usageEvents.id, id));
  expect(row.status).toBe('completed'); expect(row.charsOut).toBe(90);
});
```

- [ ] **Step 2: Run — FAIL** (no schema module)
- [ ] **Step 3: Implement** schema/client/config per Interfaces; run `npm run db:generate` to emit SQL into `drizzle/`. Auth.js tables: copy the canonical `drizzle-adapter` schema verbatim from next-auth docs, adapting only the `userId` FK to reference `users.id`.
- [ ] **Step 4: `npm run db:migrate` against `DATABASE_URL_TEST`, run test — PASS**
- [ ] **Step 5: Commit** `feat: drizzle schema (users, auth tables, usage_events) + migration`

### Task 5: Quota service

**Files:**
- Create: `lib/quota/quotaService.ts`, `tests/unit/quota.test.ts`

**Interfaces:**
- Consumes: `db`, `users`, `usageEvents` (Task 4); `Mode`, `Strength` (Task 2).
- Produces: `FREE_DAILY_LIMIT = 10`; `type QuotaStatus = { allowed: boolean; used: number; limit: number; resetsAt: string }` (ISO UTC, next midnight); `check(userId: string): Promise<QuotaStatus>`; `beginUsage(userId: string, charsIn: number, model: string, mode: Mode, strength: Strength): Promise<string>` — inserts `streaming` row, returns event id; `completeUsage(eventId: string, charsOut: number): Promise<void>`; `abortUsage(eventId: string): Promise<void>`.

- [ ] **Step 1: Write failing tests** `tests/unit/quota.test.ts` (real test DB):

```ts
it('allows the 10th request, blocks the 11th', async () => {
  const u = await mkUser();
  for (let i = 0; i < 9; i++) { const id = await beginUsage(u.id, 10, 'm', 'standard', 'light'); await completeUsage(id, 9); }
  expect((await check(u.id)).allowed).toBe(true);
  const tenth = await beginUsage(u.id, 10, 'm', 'standard', 'light'); await completeUsage(tenth, 9);
  const st = await check(u.id);
  expect(st.used).toBe(10); expect(st.allowed).toBe(false); expect(st.limit).toBe(10);
});
it('aborted rows still count', async () => { /* beginUsage then abortUsage → used includes it */ });
it('counts only current UTC day', async () => { /* raw-insert yesterday row → check.used excludes it; resetsAt is next UTC midnight */ });
it('aborted and completed transition status only, quota unchanged', async () => { /* row status after abortUsage === 'aborted' */ });
```

- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement** — `check` = `count(*)` of today's rows (`createdAt >= utcMidnight`), never filters by status (any row that exists consumed quota — this is the first-delta rule). `resetsAt` = `new Date(utcMidnight + 86400_000).toISOString()`.
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5: Commit** `feat: quotaService (UTC-day counting, first-delta rule)`

### Task 6: OpenRouter provider

**Files:**
- Create: `lib/paraphrase/types.ts`, `lib/paraphrase/openrouter.ts`, `tests/integration/provider.test.ts`

**Interfaces:**
- Consumes: `getSystemPrompt`, `Mode`, `Strength` (Task 2).
- Produces: `interface ParaphraseProvider { stream(text: string, mode: Mode, strength: Strength, signal: AbortSignal): AsyncIterable<string> }`; `UPSTREAM_TIMEOUT_MS = 120_000`; `createOpenRouterProvider(): ParaphraseProvider` (reads `OPENROUTER_API_KEY`, `PARAPHRASE_MODEL ?? 'openai/gpt-4o-mini'` at call time). `stream` throws `UpstreamUnavailableError` on any failure before the first delta; yields deltas then returns after `data: [DONE]`.

- [ ] **Step 1: Write failing tests** `tests/integration/provider.test.ts` against a local fake OpenRouter (`http.createServer` on an ephemeral port, base URL overridable via `OPENROUTER_BASE_URL` env):

```ts
it('replays canned SSE chunks in order', async () => {
  fake.replyWith(['The', ' quick', ' fox'], [200]);
  const out = []; for await (const d of provider.stream('input text', 'standard', 'light', new AbortController().signal)) out.push(d);
  expect(out.join('')).toBe('The quick fox');
});
it('throws UpstreamUnavailableError on 401 before any delta', …);
it('mid-stream death: already-yielded deltas stand, iterator throws UpstreamUnavailableError', …);
it('zero-delta 200 then close → UpstreamUnavailableError, zero deltas yielded', …);
it('aborts at UPSTREAM_TIMEOUT_MS (vi.useFakeTimers)', …);
```

- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement** — `openai` SDK `client.chat.completions.create({ model, messages: [{role:'system',content:getSystemPrompt(mode,strength)},{role:'user',content:text}], stream:true, signal })`; compose caller signal with `AbortSignal.timeout(UPSTREAM_TIMEOUT_MS)` via `AbortSignal.any`. Wrap the async iteration: first-delta flag decides whether an error means "pre-delta" (throw `UpstreamUnavailableError`) — same error type either side keeps the route's handling simple; the route knows quota was consumed because it already called `beginUsage` on the first yielded delta.
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5: Commit** `feat: OpenRouter streaming provider + fake-server tests`

### Task 7: Per-IP rate limiter

**Files:**
- Create: `lib/ratelimit.ts`, `tests/unit/ratelimit.test.ts`

**Interfaces:**
- Produces: `checkRate(key: string, limit: number, windowMs: number): { allowed: boolean; retryAfterSec: number }` — process-local fixed-window counter; `ANON_LIMIT_60S = 10`, `AUTHED_LIMIT_60S = 30`.

- [ ] **Step 1: Write failing tests** — 10 pass then 11th denied with `retryAfterSec ≤ 60`; window rolls over after fake-timer advance; keys independent.
- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement** — `Map<string, {count:number; resetAt:number}>`; prune expired entries on every call (cap map at 10k keys, evict oldest).
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5: Commit** `feat: in-memory per-IP rate limiter`

### Task 8: Auth (Auth.js, password helpers, middleware, auth pages)

**Files:**
- Create: `lib/auth/passwords.ts`, `lib/auth.config.ts`, `lib/auth.ts`, `app/api/auth/[...nextauth]/route.ts`, `middleware.ts`, `app/signin/page.tsx`, `app/signup/page.tsx`, `tests/unit/passwords.test.ts`, `tests/integration/signup.test.ts`
- Modify: `app/layout.tsx` (nav shell: logo, sign-in/out, usage placeholder slot)

**Interfaces:**
- Consumes: `db`, `users` (Task 4).
- Produces: `hashPassword(pw: string): Promise<string>` / `verifyPassword(pw, hash): Promise<boolean>` (bcryptjs, cost 12); `auth()` server helper (from `lib/auth.ts`, full config: Drizzle adapter + Google + Credentials, JWT session, 30-day maxAge); middleware redirect rule: unauthenticated `/app/**` and `/account/**` → `/signin?callbackUrl=…`; signup server action `signUpWithEmail(input: {email, password}): Promise<{ok} | {error: string}>`.

- [ ] **Step 1: Write failing unit tests** `passwords.test.ts`: hash≠plain, verify true/false, NULL-hash guard `verifyPassword('x', null)` → `false` (no throw).
- [ ] **Step 2: FAIL → Step 3: implement passwords.ts** (bcryptjs wrappers; signin path rejects NULL `passwordHash` with message `"This account uses Google sign-in"`).
- [ ] **Step 4: Write failing integration test** `signup.test.ts` (test DB): `signUpWithEmail` creates user with bcrypt hash, duplicate email → `{error:'Email already registered'}`, short password (<8) → `{error}`.
- [ ] **Step 5: FAIL → implement `auth.config.ts`** (edge-safe: session strategy + authorized-callback for middleware), **`auth.ts`** (adapter, Google, Credentials mapping email→users table, `authorize()` verifying bcrypt hash; reject NULL hash with the Google message — Review Focus #3), **route handler**, **middleware** (import only `auth.config`), **pages** (forms posting to `signIn`/`signUpWithEmail`; "Continue with Google" button).
- [ ] **Step 6: All tests PASS; `npm run build` clean**
- [ ] **Step 7: Commit** `feat: Auth.js google+credentials, middleware, signup`

### Task 9: POST /api/paraphrase

**Files:**
- Create: `app/api/paraphrase/route.ts`, `tests/integration/paraphrase-route.test.ts`

**Interfaces:**
- Consumes: `auth()` (Task 8), `paraphraseRequestSchema` (Task 3), `checkRate` (Task 7), `check/beginUsage/completeUsage/abortUsage` + `FREE_DAILY_LIMIT` (Task 5), `ParaphraseProvider` + `UpstreamUnavailableError` (Task 6; DI via factory arg `makeRouteHandler({ provider })` so tests inject fakes).
- Produces: `POST /api/paraphrase` — SSE per Global Constraints frames; pre-stream errors JSON `{error, correlationId?}` with codes 401/422/429/429(rate)/502; `GET`-less. Emits terminal `{"type":"done","remaining":N}`.

- [ ] **Step 1: Write failing integration tests** (fake provider + test DB + fake auth session):

```ts
it('401 without session; 422 unknown mode; 429 at 10 used with {limit,used,resetsAt}', …);
it('happy path: SSE deltas then done{remaining:9}; exactly one row status=completed', async () => {
  const res = await POST(fakeReq({ text: 'hello', mode: 'standard', strength: 'light' }));
  expect(sseFrames(res)).toEqual([{type:'delta',text:'Hello'},{type:'delta',text:' there'},{type:'done',remaining:9}]);
  expect(await rowsFor(user.id)).toMatchObject([{ status:'completed', charsOut: 12 }]);
});
it('zero-delta upstream failure: error frame, NO usage row, quota unchanged', …); // Review Focus #1
it('mid-stream failure after beginUsage: row aborted, quota consumed, error frame last', …);
it('client abort mid-stream: provider iterator interrupted via request signal; row aborted', …); // Review Focus #2
```

- [ ] **Step 2: Run — FAIL**
- [ ] **Step 3: Implement** — order of operations: session → zod → rate → `check` → `provider.stream`; on **first** yielded delta call `beginUsage` and hold its id; write each delta as `data: {JSON}\n\n`; clean end → `completeUsage(id, totalChars)` + `done` frame with `remaining` from re-check; `UpstreamUnavailableError` pre-delta → `502 JSON` (no row); post-delta error or `request.signal` abort → `abortUsage` + `error` frame. Never retry upstream.
- [ ] **Step 4: Run — PASS**
- [ ] **Step 5: Commit** `feat: paraphrase route with SSE + first-delta quota`

### Task 10: GET /api/usage + workspace UI

**Files:**
- Create: `app/api/usage/route.ts`, `app/app/page.tsx`, `components/Workspace.tsx`, `components/UsageMeter.tsx`, `tests/integration/usage-route.test.ts`, `tests/unit/workspace-helpers.test.ts`
- Modify: none (`layout.tsx` from Task 8 already slots the meter)

**Interfaces:**
- Consumes: `check` (Task 5), `auth` (Task 8), `MODES`/`STRENGTHS` (Task 2), SSE frame shapes (Task 9).
- Produces: `GET /api/usage` → `{used, limit, remaining, resetsAt}` (auth required, 401 JSON otherwise); client helpers `parseSseLine(line: string): Frame | null`, `formatResetLocal(resetsAtIso: string): string` (user-local via `toLocaleString`).

- [ ] **Step 1: Write failing tests** — usage route: 401 anonymous; authed shape `{used:0, limit:10, remaining:10}` on fresh user. `parseSseLine`: parses all three frame types, ignores `event:`/comment lines, returns `null` on malformed JSON (never throws). `formatResetLocal`: fixed UTC instant renders correct hour in `TZ=Asia/Karachi` and `TZ=America/New_York` subprocesses (Review Focus #4).
- [ ] **Step 2: FAIL → Step 3: implement** route (trivial: `check(userId)` → JSON).
- [ ] **Step 4: Implement UI** — `Workspace.tsx` (client): textarea + counter (hard-stop at `MAX_INPUT_CHARS` — a paste beyond the cap shows an inline error and trims to 5,000), mode chips from `MODES`, 3-stop strength slider, Paraphrase button **disabled while streaming or at remaining=0**, Stop button aborting the `fetch` via `AbortController`; reads response body with `res.body.getReader()` + `TextDecoder`, feeds `parseSseLine`, appends deltas to output `<pre>` (plain text); `done` updates `UsageMeter`; `error` keeps partial output + counts note. Fetch `/api/usage` once on mount.
- [ ] **Step 5: All tests PASS; `npm run build` clean; manual `npm run dev` smoke against fake upstream env**
- [ ] **Step 6: Commit** `feat: usage endpoint + streaming workspace UI`

### Task 11: Landing + account pages

**Files:**
- Create: `app/page.tsx` (replace scaffold), `app/account/page.tsx`, `lib/account/actions.ts`, `tests/integration/account.test.ts`

**Interfaces:**
- Consumes: `auth`, `signOut`, `hashPassword/verifyPassword`, `db/users` (Tasks 4/8).
- Produces: server action `setPassword(userId, {current, next}): Promise<{ok}|{error}>` (requires existing hash or NULL-hash first-set); static landing with mode showcase + "10 free paraphrases/day" copy.

- [ ] **Step 1: Write failing tests** — `setPassword`: wrong current → `{error}`, weak next (<8) → `{error}`, success updates hash (verify via `verifyPassword`); NULL-hash user setting first password succeeds with empty `current`.
- [ ] **Step 2: FAIL → Step 3: implement actions + pages** (account page lists email, connected providers from `accounts` table, password form only when relevant; landing = server component, zero client JS beyond links).
- [ ] **Step 4: PASS + build clean**
- [ ] **Step 5: Commit** `feat: landing + account pages`

### Task 12: E2E smoke + CI finalize + launch config

**Files:**
- Create: `playwright.config.ts`, `tests/e2e/signup-paraphrase.spec.ts`, `.github/workflows/e2e.yml`
- Modify: `.github/workflows/ci.yml` (finalize), `.env.example` (final values)

**Interfaces:**
- Consumes: everything.
- Produces: green default-branch CI including E2E; operator launch checklist lives in the spec (§11) — no README added.

- [ ] **Step 1: `playwright.config.ts`** — webServer `npm run dev` with env pointing `OPENROUTER_BASE_URL` at a mock server started in the spec (reuse Task 6 fake), `DATABASE_URL_TEST` migrated in `globalSetup`.
- [ ] **Step 2: Write the one spec** — sign-up (email/pass) → redirected to `/app` → type canned text → click Paraphrase → assert streamed text appears and meter shows "9 of 10 left today".
- [ ] **Step 3: Run `npm run test:e2e` — PASS locally.**
- [ ] **Step 4: Finalize CI** — ci.yml: postgres service + typecheck+lint+vitest every push; e2e.yml: Playwright on `main` (and `workflow_dispatch`).
- [ ] **Step 5: Full gate: `npm run lint && npm test && npm run build && npm run test:e2e` all green.**
- [ ] **Step 6: Commit** `test: e2e smoke + finalized CI` and tag `v0.1.0-slice1`

---

## Spec coverage map (self-review artifact)

| Spec section | Task(s) |
|---|---|
| §4 architecture, seams | 1–12 (structure), seams in 2/5/6 |
| §5 pages/handlers/schema | 4, 8, 9, 10, 11 |
| §6 data flow + counting rule | 9 (+5 service tests) |
| §7 error handling, rate limit | 9, 7, Review Focus 1–2 |
| §8 limits/config | Global Constraints, 3/5/6/7 |
| §9 security | 8 (bcrypt/JWT/NULL-hash), 10 (plain text), 1 (.env hygiene) |
| §10 testing + CI | every task + 12 |
| §11 env & deploy | 1 `.env.example`, 12 launch |
| §12 non-goals | nothing scheduled beyond §10 |
