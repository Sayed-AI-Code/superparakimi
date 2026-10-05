// Timezone probe for Review focus #4 — run by tests/unit/workspace-helpers.test.ts
// as a SUBPROCESS with TZ set, because process.env.TZ cannot be flipped inside
// an already-running V8 (Intl caches the zone on first use).
//
// Node v24 executes this file natively, so the import keeps its explicit `.ts`
// extension (required by the ESM loader) and lib/workspace/helpers.ts stays
// dependency-free — no `@/` alias, which bare node cannot resolve.
import { formatResetLocal } from '../../lib/workspace/helpers.ts';

// The instant comes from argv so one probe can pin several instants — including
// one that rolls the calendar DAY, the highest-value local-display bug (the
// hour alone can look right on the wrong date).
const instant = process.argv[2] ?? '2026-03-14T05:30:31.000Z';
process.stdout.write(formatResetLocal(instant));
