// Timezone probe for Review focus #4 — run by tests/unit/workspace-helpers.test.ts
// as a SUBPROCESS with TZ set, because process.env.TZ cannot be flipped inside
// an already-running V8 (Intl caches the zone on first use).
//
// Node v24 executes this file natively, so the import keeps its explicit `.ts`
// extension (required by the ESM loader) and lib/workspace/helpers.ts stays
// dependency-free — no `@/` alias, which bare node cannot resolve.
import { formatResetLocal } from '../../lib/workspace/helpers.ts';

// Pinned UTC instant: 2026-03-14T05:30:31.000Z
//   Asia/Karachi    (+05:00) → 10:30:31
//   America/New_York(-04:00) → 01:30:31
process.stdout.write(formatResetLocal('2026-03-14T05:30:31.000Z'));
