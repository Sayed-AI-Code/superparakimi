import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANON_LIMIT_60S,
  AUTHED_LIMIT_60S,
  checkRate,
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
