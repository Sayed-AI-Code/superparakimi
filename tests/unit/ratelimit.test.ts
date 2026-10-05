import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANON_LIMIT_60S,
  AUTHED_LIMIT_60S,
  RATE_LIMIT_MESSAGE,
  apiRateLimit,
  checkRate,
  clientIp,
  rateLimitDecision,
} from '@/lib/ratelimit';

const WINDOW_60S = 60_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('rate limit constants', () => {
  it('ANON_LIMIT_60S is 10 and AUTHED_LIMIT_60S is 30', () => {
    expect(ANON_LIMIT_60S).toBe(10);
    expect(AUTHED_LIMIT_60S).toBe(30);
  });
});

describe('checkRate: anonymous 10 req/min', () => {
  it('allows 10 then denies the 11th with 0 < retryAfterSec <= 60', () => {
    const key = `anon-${crypto.randomUUID()}`;
    for (let i = 0; i < ANON_LIMIT_60S; i++) {
      const res = checkRate(key, ANON_LIMIT_60S, WINDOW_60S);
      expect(res.allowed).toBe(true);
      expect(res.retryAfterSec).toBe(0);
    }
    const denied = checkRate(key, ANON_LIMIT_60S, WINDOW_60S);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThan(0);
    expect(denied.retryAfterSec).toBeLessThanOrEqual(60);
  });

  it('denial does not slide the window — retryAfterSec only shrinks with time', () => {
    const key = `fixed-${crypto.randomUUID()}`;
    for (let i = 0; i < ANON_LIMIT_60S; i++) {
      checkRate(key, ANON_LIMIT_60S, WINDOW_60S);
    }
    const first = checkRate(key, ANON_LIMIT_60S, WINDOW_60S);
    expect(first.allowed).toBe(false);
    expect(first.retryAfterSec).toBe(60); // window opened 0ms ago
    vi.advanceTimersByTime(45_000);
    const later = checkRate(key, ANON_LIMIT_60S, WINDOW_60S);
    expect(later.allowed).toBe(false);
    expect(later.retryAfterSec).toBe(15); // same resetAt, 45s closer
  });

  it('window rolls over after the full 60s and the quota is fresh', () => {
    const key = `rollover-${crypto.randomUUID()}`;
    for (let i = 0; i < ANON_LIMIT_60S; i++) {
      checkRate(key, ANON_LIMIT_60S, WINDOW_60S);
    }
    expect(checkRate(key, ANON_LIMIT_60S, WINDOW_60S).allowed).toBe(false);
    vi.advanceTimersByTime(WINDOW_60S);
    const after = checkRate(key, ANON_LIMIT_60S, WINDOW_60S);
    expect(after.allowed).toBe(true);
    expect(after.retryAfterSec).toBe(0);
    // The new window starts at count 1: exactly limit-1 more allowed, then denied.
    for (let i = 0; i < ANON_LIMIT_60S - 1; i++) {
      expect(checkRate(key, ANON_LIMIT_60S, WINDOW_60S).allowed).toBe(true);
    }
    expect(checkRate(key, ANON_LIMIT_60S, WINDOW_60S).allowed).toBe(false);
  });
});

describe('checkRate: authenticated 30 req/min', () => {
  it('allows 30 then denies the 31st', () => {
    const key = `authed-${crypto.randomUUID()}`;
    for (let i = 0; i < AUTHED_LIMIT_60S; i++) {
      expect(checkRate(key, AUTHED_LIMIT_60S, WINDOW_60S).allowed).toBe(true);
    }
    const denied = checkRate(key, AUTHED_LIMIT_60S, WINDOW_60S);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBeGreaterThan(0);
    expect(denied.retryAfterSec).toBeLessThanOrEqual(60);
  });
});

describe('checkRate: key isolation', () => {
  it('exhausting one key leaves other keys untouched', () => {
    const exhausted = `ip-a-${crypto.randomUUID()}`;
    const untouched = `ip-b-${crypto.randomUUID()}`;
    for (let i = 0; i < ANON_LIMIT_60S; i++) {
      checkRate(exhausted, ANON_LIMIT_60S, WINDOW_60S);
    }
    expect(checkRate(exhausted, ANON_LIMIT_60S, WINDOW_60S).allowed).toBe(false);
    const res = checkRate(untouched, ANON_LIMIT_60S, WINDOW_60S);
    expect(res.allowed).toBe(true);
    expect(res.retryAfterSec).toBe(0);
  });
});

function headers(init: Record<string, string> = {}) {
  return new Headers(init);
}

describe('rateLimitDecision (route-level classification)', () => {
  it('classifies by session cookie, not by path', () => {
    expect(rateLimitDecision(headers({ cookie: 'authjs.session-token=abc' })).limit).toBe(
      AUTHED_LIMIT_60S,
    );
    expect(
      rateLimitDecision(headers({ cookie: '__Host-authjs.session-token=abc' })).limit,
    ).toBe(AUTHED_LIMIT_60S);
    expect(rateLimitDecision(headers()).limit).toBe(ANON_LIMIT_60S);
    expect(rateLimitDecision(headers({ cookie: 'other=1' })).limit).toBe(
      ANON_LIMIT_60S,
    );
  });

  it('blocks an anonymous caller at the 11th hit of the window', () => {
    const ip = `198.51.100.${crypto.randomUUID().slice(0, 2)}`;
    const h = headers({ 'x-forwarded-for': ip });
    for (let i = 0; i < ANON_LIMIT_60S; i++) {
      expect(rateLimitDecision(h).allowed).toBe(true);
    }
    const blocked = rateLimitDecision(h);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSec).toBeGreaterThan(0);
    expect(blocked.limit).toBe(ANON_LIMIT_60S);
  });

  it('anonymous exhaustion does not throttle an authenticated caller on the same IP', () => {
    const ip = `203.0.113.${crypto.randomUUID().slice(0, 2)}`;
    for (let i = 0; i < ANON_LIMIT_60S + 5; i++) {
      rateLimitDecision(headers({ 'x-forwarded-for': ip }));
    }
    const authed = rateLimitDecision(
      headers({ 'x-forwarded-for': ip, cookie: 'authjs.session-token=abc' }),
    );
    expect(authed.allowed).toBe(true);
  });

  it('clientIp takes the first forwarded hop', () => {
    expect(clientIp({ headers: headers({ 'x-forwarded-for': '203.0.113.7, 70.41.3.18' }) })).toBe(
      '203.0.113.7',
    );
    expect(clientIp({ headers: headers({ 'x-forwarded-for': ' 203.0.113.8 ,10.0.0.1' }) })).toBe(
      '203.0.113.8',
    );
    expect(clientIp({ headers: headers() })).toBe('unknown');
  });
});

describe('apiRateLimit (the 429 the routes hand back)', () => {
  it('returns null while the caller is inside the budget', () => {
    const ip = `203.0.113.${crypto.randomUUID().slice(0, 2)}`;
    const request = { headers: headers({ 'x-forwarded-for': ip }) };
    expect(apiRateLimit(request)).toBeNull();
  });

  it('answers 429 with JSON, the pinned copy, and retry-after once exhausted', async () => {
    const ip = `198.51.100.${crypto.randomUUID().slice(0, 2)}`;
    const request = { headers: headers({ 'x-forwarded-for': ip }) };
    for (let i = 0; i < ANON_LIMIT_60S; i++) {
      expect(apiRateLimit(request)).toBeNull();
    }
    const blocked = apiRateLimit(request);
    expect(blocked).not.toBeNull();
    expect(blocked!.status).toBe(429);
    expect(blocked!.headers.get('content-type')).toBe('application/json');
    expect(Number(blocked!.headers.get('retry-after'))).toBeGreaterThan(0);
    await expect(blocked!.json()).resolves.toEqual({
      error: RATE_LIMIT_MESSAGE,
      retryAfterSec: expect.any(Number),
    });
  });

  it('lets an authenticated caller through an exhausted anonymous bucket', () => {
    const ip = `203.0.113.${crypto.randomUUID().slice(0, 2)}`;
    for (let i = 0; i < ANON_LIMIT_60S + 3; i++) {
      apiRateLimit({ headers: headers({ 'x-forwarded-for': ip }) });
    }
    const authed = apiRateLimit(
      { headers: headers({ 'x-forwarded-for': ip, cookie: 'authjs.session-token=abc' }) },
    );
    expect(authed).toBeNull();
  });
});
