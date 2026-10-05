'use client';

import { useEffect, useState } from 'react';

import {
  formatResetLocal,
  publishUsage,
  subscribeUsage,
  USAGE_REFRESH_EVENT,
} from '@/lib/workspace/helpers';
import type { Usage } from '@/lib/workspace/helpers';

/**
 * Reads GET /api/usage exactly once per mount (spec §7 — no polling) and
 * listens for the terminal `done` frame that Workspace publishes, so the count
 * drops the moment a generation finishes instead of after a reload.
 *
 * Renders nothing while anonymous or still loading: the meter is meaningless
 * without a session, and a fake "10 of 10" would be a lie for a user who has
 * already used some of today's quota.
 */
export default function UsageMeter() {
  const [usage, setUsage] = useState<Usage | null>(null);

  useEffect(() => {
    let cancelled = false;

    // One fetch per mount, plus one per explicit refresh request. Nothing here
    // re-fetches on a timer — spec §7 says no polling.
    const refresh = () => {
      fetch('/api/usage', { cache: 'no-store' })
        .then((res) => (res.ok ? (res.json() as Promise<Usage>) : null))
        .then((data) => {
          // Publish rather than only set local state: Workspace lives in a
          // different React tree and needs the same numbers to gate its button.
          if (!cancelled && data) publishUsage(data);
        })
        .catch(() => {
          // A failed meter read must not break the page; the server still
          // enforces quota on POST /api/paraphrase.
        });
    };

    const unsubscribe = subscribeUsage(setUsage);
    window.addEventListener(USAGE_REFRESH_EVENT, refresh);
    refresh();

    return () => {
      cancelled = true;
      unsubscribe();
      window.removeEventListener(USAGE_REFRESH_EVENT, refresh);
    };
  }, []);

  if (!usage) return null;

  const exhausted = usage.remaining <= 0;

  return (
    <span
      id="usage-meter"
      role="status"
      aria-live="polite"
      className={`hidden font-mono text-xs tabular-nums sm:inline ${
        exhausted ? 'text-red-600 dark:text-red-400' : 'text-zinc-600 dark:text-zinc-400'
      }`}
      title={exhausted ? `Resets ${formatResetLocal(usage.resetsAt)}` : undefined}
    >
      {usage.remaining} of {usage.limit} left today
      {exhausted && (
        <span className="ml-1 hidden md:inline">
          — resets {formatResetLocal(usage.resetsAt)}
        </span>
      )}
    </span>
  );
}
