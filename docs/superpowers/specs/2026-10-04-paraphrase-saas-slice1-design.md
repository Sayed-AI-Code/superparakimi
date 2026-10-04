# SuperParaKimi — Paraphrasing SaaS, Slice 1: Auth + Paraphrase Engine + Usage Limits

**Date:** 2026-10-04
**Status:** Approved for implementation planning
**Product owner:** Sayed
**Repository:** `superparakimi`

## 1. Summary

A public SaaS paraphrasing web app. Slice 1 ships sign-in (Google OAuth + email/password), a paraphrase workspace powered by OpenRouter with selectable tone modes and rewrite strengths, streaming output, and an enforced free-tier quota of 10 paraphrases per user per day at 5,000 characters max per request. Billing, history, admin, and marketing are later slices with seams defined here.

## 2. Product context

- **Audience:** general public; anyone needing text rewritten (students, writers, marketers).
- **Success criteria (slice 1):** a stranger can sign up, paraphrase text that arrives token-by-token, is reliably capped at 10 requests/day, and the operator's only spend control gap is none known at launch volumes.
- **Roadmap (separate spec → plan → implementation cycle each):**
  1. **Slice 1 (this spec):** auth, paraphrase engine, per-user limits.
  2. Stripe billing + plans (free/pro tiers, model access by plan).
  3. History, favorites, export (txt/docx).
  4. Admin dashboard, analytics, cost tracking, abuse controls.
  5. SEO/marketing surface (landing pages, blog, referrals).

## 3. Approach

**Chosen: Approach A — lean serverless monolith.** Single Next.js repo on Vercel, managed Postgres (Neon), Auth.js, all provider calls inside route handlers. Quota checks in Postgres behind a single `quotaService` interface; upgrading metering to Redis later touches one module. Rejected alternatives: B (monolith + Upstash Redis for quotas/caching — second managed service before traffic justifies it) and C (separate FastAPI backend — two deploy pipelines and cross-origin session sharing for benefits not needed until future slices).

## 4. Architecture

- **Framework:** Next.js 15, App Router, TypeScript throughout.
- **Hosting:** Vercel (Hobby acceptable at launch; functions allow up to 300s duration, sufficient for streaming 5k-char rewrites).
- **Database:** Neon Postgres, accessed via Drizzle ORM with the Neon serverless HTTP driver.
- **Auth:** Auth.js (NextAuth v5); providers Google OAuth and Credentials (bcrypt-hashed passwords); JWT session strategy (serverless-appropriate); Drizzle adapter persisting `users`, `accounts`, `sessions`.
- **LLM provider:** OpenRouter's OpenAI-compatible `/chat/completions` endpoint via the `openai` SDK with custom `baseURL`. `OPENROUTER_API_KEY` lives only in server environment variables; never sent to the client.
- **Styling/UI:** Tailwind CSS. Server components for static pages; one client component for the workspace (streaming requires client-side rendering).
- **Middleware:** protects `/app` and `/account`; redirects anonymous visitors to `/signin`.

```
Browser (React UI)
   │  fetch + SSE stream
   ▼
Next.js route handlers  ──►  quotaService  ──►  Postgres (users, usage_events)
   │
   └──►  paraphraseProvider  ──►  OpenRouter API  ──►  tokens streamed back
```

### Internal seams (future slices attach here, not everywhere)

| Module | Contract | Future use |
|---|---|---|
| `lib/paraphrase/openrouter.ts` | `stream(text, mode, strength, signal): AsyncIterable<string>` | swap models, multi-provider |
| `lib/quota/quotaService.ts` | `check(userId)`, `record(userId, charsIn, charsOut, status)` | billing plans, Redis counters |
| `lib/mode/prompts.ts` | `getSystemPrompt(mode, strength): string` | new modes, i18n |

## 5. Components

### Pages

- `/` — static landing page: value proposition, mode showcase, free-tier note ("10 free paraphrases/day"), sign-in/up CTAs.
- `/signin`, `/signup` — email/password forms + "Continue with Google" (Auth.js).
- `/app` — workspace (client component): textarea with live character counter hard-capped at 5,000; mode selector (Standard, Fluent, Simple, Formal, Creative, Academic); strength slider (Light, Medium, Strong); Paraphrase button; streaming output pane with copy-to-clipboard and Stop button; usage meter "X of 10 left today".
- `/account` — email, connected sign-in methods, add/change password. Minimal in slice 1.

### Route handlers

- `POST /api/paraphrase` — auth required. Body `{text, mode, strength}`. Pre-stream errors return JSON (401/422/429/502). On success returns SSE text-delta stream ending with a terminal `{remaining}` event.
- `GET /api/usage` — auth required. Returns `{used, limit, remaining, resetsAt}`; `used` counts events with status `streaming`, `completed`, or `aborted` for the current UTC day.
- `/api/auth/*` — Auth.js.

### Data model (Drizzle schema)

- `users`: `id` (uuid pk), `email` (unique), `name`, `password_hash` (nullable — Google-only accounts), `plan` (text, default `'free'`), `created_at`.
- `accounts`, `sessions` — standard Auth.js adapter tables.
- `usage_events`: `id` (uuid pk), `user_id` (fk users), `chars_in` (int), `chars_out` (int, nullable until terminal), `model` (text), `mode` (text), `strength` (text), `status` (`streaming` | `completed` | `aborted`), `correlation_id` (uuid), `created_at`. Composite index on `(user_id, created_at)`.

## 6. Data flow (one paraphrase request)

1. **Compose:** user pastes text; client rejects >5,000 chars at input. Mode + strength selected; Paraphrase pressed.
2. **Validate & gate:** handler validates shape via shared zod schemas; `quotaService.check(userId)` counts current-UTC-day events; at/over limit → `429 {limit, used, resetsAt}`; else proceed.
3. **Generate:** `paraphraseProvider.stream()` POSTs to OpenRouter with `stream: true`, system prompt from `getSystemPrompt(mode, strength)`, user text as the user message, and a 120-second `AbortSignal`.
4. **Stream:** OpenRouter SSE chunks are parsed to text deltas and re-emitted as the app's own SSE stream; UI renders progressively. Key, model id, and prompt details never cross to the client.
5. **Record:** the moment the **first text delta** arrives from OpenRouter, the handler inserts the `usage_events` row with status `streaming`; on clean finish it updates to `completed` (writing `chars_out`) and emits terminal `{remaining}`.

**Quota counting rule (single trigger: first text delta received):** the event row is created — and therefore quota is consumed — exactly when the first text delta arrives. Status transitions: `streaming → completed` or `streaming → aborted`. Anything that fails **before** the first delta (validation, upstream auth failure, connection refused, upstream 200 that dies with zero deltas) creates no event and consumes no quota. This closes repeated-abort-for-free-generations while keeping honest pre-generation failures free.

Reads: `/app` calls `GET /api/usage` once on load; no polling.

## 7. Error handling

Pre-stream, JSON responses, zero quota consumed:

- `401` missing/expired session → UI redirects to `/signin`, returns to `/app` after sign-in.
- `422` empty text, >5,000 chars, unknown mode/strength → inline field errors.
- `429` quota exhausted → `{limit, used, resetsAt}`; UI renders reset time in the user's local timezone.
- `502` upstream unreachable/5xx before first token → generic "Service hiccup — didn't count against your limit" message; server logs full detail under a `correlation_id` returned in the error body.

During streaming (event row already exists, quota consumed):

- Upstream dies mid-stream or 120s timeout fires → SSE `error` event; partial text stays in the pane; UI notes the request counts because generation started.
- User presses Stop or navigates away → abort propagates to the upstream request (halts further token spend); row status → `aborted`; counted.

Principles: never silently retry against OpenRouter; never swallow errors into empty output; never leak provider internals to the client. Route-level catch converts unexpected throws to `500 + correlation_id`. Sentry is a slice-2 upgrade; correlation ids are the seam.

Abuse pre-stream: lightweight process-local per-IP limiter on `/api/*` — 30 req/min authenticated, 10 req/min anonymous. Deliberately not shared/Redis at this scale.

Validation: zod schemas exported from one module, consumed by both client form and route handler so they cannot drift.

## 8. Limits & configuration

| Knob | Value | Where |
|---|---|---|
| Max input per request | 5,000 chars | zod schema + client counter |
| Free quota | 10 requests/day/user, UTC day | `quotaService` constants (slice 2: per-plan) |
| Upstream timeout | 120s | provider module |
| Model | `openai/gpt-4o-mini` default | `PARAPHRASE_MODEL` env |
| Anonymous/IP rate limits | 10/min anonymous, 30/min authed | middleware limiter |

## 9. Security

- `OPENROUTER_API_KEY`, `AUTH_SECRET`, `DATABASE_URL`, Google OAuth secrets: Vercel environment variables only.
- Passwords hashed with bcrypt (cost 12); credentials never logged.
- Session cookies set by Auth.js with `__Host-` prefix semantics; JWT sessions, 30-day max age.
- All paraphrase/usage endpoints require a valid session; no anonymous generation in slice 1.
- User text is treated strictly as message content — no evaluation, no `dangerouslySetInnerHTML`; output rendered as plain text.
- Input length capped both client-side and server-side (server is authoritative).

## 10. Testing

- **Unit (Vitest):** `quotaService` against a real Postgres test schema (Neon branch): UTC-day boundaries, 9/10/11th request, status transitions, zero-cost pre-generation failures; `modePrompts`: all 18 mode×strength combinations non-empty, unknown mode throws; zod schemas: empty, 5,001 chars, hostile payloads remain inert data.
- **Integration (Vitest, mocked OpenRouter):** `POST /api/paraphrase` contract — 401/422/429 paths; happy-path SSE framing and terminal `{remaining}`; exactly one usage row per request with correct terminal status on success, user abort, and mid-stream upstream failure; **zero** usage rows for any failure before the first text delta. Provider against a fake OpenRouter server: deterministic chunk replay, mid-stream death, zero-delta connection drop, 120s abort.
- **Smoke (Playwright, one spec):** email/password sign-up → `/app` → paraphrase canned text against mocked upstream → meter decrements.
- **CI (GitHub Actions):** typecheck + lint + Vitest on every push; Playwright on `main`.
- **Out of scope:** visual regression, load testing, tests of Auth.js internals.

Implementation follows test-driven development, in seam order: prompts → quota → provider → routes → UI.

## 11. Environment & deployment

- **Env vars:** `DATABASE_URL`, `AUTH_SECRET`, `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `OPENROUTER_API_KEY`, `PARAPHRASE_MODEL` (optional, has default).
- **Environments:** Vercel production from `main`; preview deploys from PRs pointed at a Neon dev branch database; local dev against the same dev branch.
- **Migrations:** Drizzle Kit-generated SQL committed to the repo; applied via CI step on production deploys.
- **Launch checklist:** Vercel project, Neon project (dev + prod branches), Google OAuth consent screen (production mode), OpenRouter key with usage alerting configured at the provider level.

## 12. Explicit non-goals (slice 1)

No billing, no usage history UI, no admin panel, no multilingual UI (English-only interface; user text in any language passes through), no document upload/chunking, no Redis, no mobile app, no email newsletters, no A/B testing. Each stays out until its own spec.
