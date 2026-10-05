// Non-credential diagnostics for server-side logs.
//
// Drizzle wraps every driver failure in DrizzleQueryError, whose message is
// built as `Failed query: ${query}\nparams: ${params}` with query/params as
// own enumerable props (drizzle-orm/errors.js) — for signup INSERT failures
// that embeds the email and the bcrypt hash, which the spec treats as a
// credential. So never pass the raw error (or its message/query/params) to
// the log; take only fields verified credential-free:
// - name
// - postgres SQLSTATE code (from the error, else its cause)
// - stack: the cause's stack (first line is the clean driver message,
//   e.g. `error: division by zero`). DrizzleQueryError's own stack starts
//   with its credential-bearing message, so a drizzle-shaped error without
//   a cause stack logs no stack at all rather than leaking one.
export interface ErrorLogInfo {
  name?: string;
  postgresCode?: string;
  stack?: string;
}

export function describeErrorForLog(error: unknown): ErrorLogInfo {
  const err = error as
    | {
        name?: unknown;
        code?: unknown;
        query?: unknown;
        params?: unknown;
        stack?: unknown;
        cause?: { code?: unknown; stack?: unknown } | null;
      }
    | null
    | undefined;

  const info: ErrorLogInfo = {};

  if (typeof err?.name === 'string') info.name = err.name;
  // DrizzleQueryError does NOT set `.name` (unlike DrizzleError), so it
  // reads as the generic 'Error'. Prefer the JS class name — non-credential,
  // and only for real Error instances so primitives don't inherit a
  // misleading 'String'/'Number'.
  if (
    (info.name === undefined || info.name === 'Error') &&
    error instanceof Error &&
    typeof err?.constructor?.name === 'string'
  ) {
    info.name = err.constructor.name;
  }

  const code =
    typeof err?.code === 'string'
      ? err.code
      : typeof err?.cause?.code === 'string'
        ? err.cause.code
        : undefined;
  if (code !== undefined) info.postgresCode = code;

  if (typeof err?.cause?.stack === 'string') {
    info.stack = err.cause.stack;
  } else {
    const isQueryWrapper = err?.query !== undefined || err?.params !== undefined;
    if (!isQueryWrapper && typeof err?.stack === 'string') info.stack = err.stack;
  }

  return info;
}
