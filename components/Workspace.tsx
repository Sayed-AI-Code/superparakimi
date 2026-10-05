'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

import { MODES, STRENGTHS } from '@/lib/mode/prompts';
import type { Mode, Strength } from '@/lib/mode/prompts';
import { safeRedirectTarget } from '@/lib/auth/redirect';
import { MAX_INPUT_CHARS } from '@/lib/validation';
import {
  capChars,
  countChars,
  createSseLineBuffer,
  formatResetLocal,
  publishUsage,
  requestUsageRefresh,
  subscribeUsage,
  wellFormedText,
} from '@/lib/workspace/helpers';
import type { Frame, Usage } from '@/lib/workspace/helpers';

const DEFAULT_MODE: Mode = 'standard';
const DEFAULT_STRENGTH: Strength = 'medium';

/**
 * `error` is LIVE and DURABLE. It is set by every failure path and is cleared
 * only by starting a new generation or editing the input — never by the tail
 * of a finished stream. The previous shape had `setStreaming(false)` write
 * `'idle'` in a `finally`, which stomped `'error'` in the same batch that set
 * it, so the state was advertised but unreachable.
 *
 * INVARIANT: `beginStream` writes 'streaming'; each try/catch exit writes its
 * own terminal state ('idle' on success, 'error' on fault); `finally` touches
 * the refs and the streaming flag ONLY, never `status`.
 */
type Status = 'idle' | 'streaming' | 'error';

/**
 * The workspace. Talks to POST /api/paraphrase (Task 9) and renders its SSE
 * stream as it arrives.
 *
 * QUOTA IS ENFORCED ON THE SERVER, NOT HERE. Task 9 consumes a slot at the
 * first non-empty upstream delta and gates with check() before streaming; the
 * `disabled` props below are user experience, not protection. Two tabs, a
 * double-click that beats the state flush, or a hand-written curl all bill
 * exactly as the server decides — this component only avoids presenting actions
 * the server is likely to refuse.
 */
export default function Workspace() {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<Mode>(DEFAULT_MODE);
  const [strength, setStrength] = useState<Strength>(DEFAULT_STRENGTH);
  const [status, setStatus] = useState<Status>('idle');
  const [output, setOutput] = useState('');
  const [note, setNote] = useState<string | null>(null);
  const [noteResetsAt, setNoteResetsAt] = useState<string | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [overLimit, setOverLimit] = useState(false);

  const controllerRef = useRef<AbortController | null>(null);
  // Streaming is held in a ref too, so the paste handler and the send handler
  // never read a stale value out of a closure.
  const streamingRef = useRef(false);
  // The read loop outlives the render whose closure built it, so it reads the
  // usage snapshot from a ref rather than captured state.
  const usageRef = useRef<Usage | null>(null);

  // Set when a terminal frame arrives, so the tail of readStream() can tell
  // 'idle' (clean end) from 'error' (the error frame already set the state)
  // without guessing. Writing 'idle' unconditionally here is what used to
  // erase the error state in the same tick it was set.
  const terminalRef = useRef<'done' | 'error' | null>(null);

  const beginStream = useCallback(() => {
    streamingRef.current = true;
    terminalRef.current = null;
    setStatus('streaming');
  }, []);

  // Clears the streaming flag WITHOUT touching `status` — see the invariant.
  const clearStreamRef = useCallback(() => {
    streamingRef.current = false;
    controllerRef.current = null;
  }, []);

  // One /api/usage read per mount, owned by UsageMeter (spec §7: no polling).
  // Its first broadcast lands here; if that read fails, remaining stays
  // unknown and the button stays live — the server still gates the request.
  const applyUsage = useCallback((next: Usage) => {
    usageRef.current = next;
    setUsage(next);
  }, []);

  useEffect(() => subscribeUsage(applyUsage), [applyUsage]);

  // Spec §7: leaving mid-stream — Stop OR navigating away — must propagate the
  // abort upstream so token spend halts and the row terminalizes to `aborted`.
  // The Stop button is not enough: a soft client-side navigation unmounts this
  // component without ever calling it, and the reader loop would keep draining
  // tokens against a dead component while the usage_events row stayed
  // 'streaming' forever.
  //
  // Empty dependency array = unmount-only. It cannot double-abort with Stop:
  // `abort()` on an already-aborted controller is a no-op, and the read loop's
  // finally clears the ref before any navigation completes anyway.
  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
    };
  }, []);

  // Live counter, hard-stopped at MAX_INPUT_CHARS — counted in CODE POINTS,
  // the unit the server's zod schema uses. `value.length` would count UTF-16
  // units and cut astral text the server would have accepted.
  const onTextChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = event.target.value;
    const capped = capChars(value, MAX_INPUT_CHARS);
    setText(capped.text);
    setOverLimit(capped.truncated);
    // Editing the input dismisses a previous fault: this is the only place
    // 'error' is cleared besides starting a new generation.
    if (status === 'error') {
      setStatus('idle');
      setNote(null);
      setNoteResetsAt(null);
    }
  };

  const applyFrames = (frames: Frame[]) => {
    for (const frame of frames) {
      switch (frame.type) {
        case 'delta':
          // Text appears as plain text via {output} below — never
          // dangerouslySetInnerHTML, so model output cannot inject markup.
          setOutput((prev) => prev + frame.text);
          break;
        case 'done': {
          terminalRef.current = 'done';
          // The frame carries only `remaining`. Patch that onto the snapshot we
          // already have rather than inventing `used`/`limit`/`resetsAt`; with
          // no snapshot at all (the mount read failed) ask the meter for real
          // numbers instead of publishing a half-known state.
          const snapshot = usageRef.current;
          if (snapshot) {
            publishUsage({
              ...snapshot,
              remaining: frame.remaining,
              used: snapshot.limit - frame.remaining,
            });
          } else {
            requestUsageRefresh();
          }
          break;
        }
        case 'error':
          // DURABLE error state. Partial output stays visible: text that
          // streamed was billed at the first delta, and hiding it would hide
          // what the user paid for. The route's own copy already states the
          // request counted, because generation started.
          terminalRef.current = 'error';
          setStatus('error');
          setNote(frame.message);
          requestUsageRefresh();
          break;
      }
    }
  };

  const paraphrase = async () => {
    if (streamingRef.current) return;
    const source = wellFormedText(text);
    if (countChars(source) === 0) return;

    const controller = new AbortController();
    controllerRef.current = controller;
    beginStream();
    setOutput('');
    setNote(null);
    setNoteResetsAt(null);

    try {
      const res = await fetch('/api/paraphrase', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: source, mode, strength }),
        signal: controller.signal,
      });

      // Pre-stream failures are JSON, not SSE (401/422/429/499/502/500).
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as {
          error?: string;
          resetsAt?: string;
        } | null;
        setStatus('error');
        setNote(payload?.error ?? `Request failed (${res.status}).`);
        if (payload?.resetsAt) setNoteResetsAt(payload.resetsAt);

        if (res.status === 401) {
          // Spec §7: an expired session sends the user back to sign-in and
          // returns them here. UsageMeter stays silent on 401 by design — the
          // redirect is owned HERE, in the one place that has a user action
          // behind it, so the two components do not fight over navigation.
          // safeRedirectTarget is the only sanctioned guard.
          const target = safeRedirectTarget(
            `/signin?callbackUrl=${encodeURIComponent(window.location.pathname)}`,
          );
          // A frame tick lets the note paint before the page goes away.
          setTimeout(() => {
            window.location.href = target;
          }, 0);
        }
        if (res.status === 429) requestUsageRefresh();
        return;
      }
      if (!res.body) throw new Error('Streaming is unavailable in this browser.');

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const buffer = createSseLineBuffer();

      // Chunks split anywhere — mid-frame, mid-token, mid-UTF-8-sequence.
      // TextDecoder({stream:true}) holds back an incomplete multi-byte
      // sequence; createSseLineBuffer holds back the incomplete line.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        applyFrames(buffer.push(decoder.decode(value, { stream: true })));
      }
      applyFrames(buffer.push(decoder.decode()));
      applyFrames(buffer.flush());

      // Only a CLEAN end writes 'idle'. If the stream's terminal frame was an
      // error, applyFrames already set 'error' — overwriting it here is what
      // made the error state unreachable. Abort likewise leaves it alone.
      if (!controller.signal.aborted && terminalRef.current !== 'error') {
        setStatus('idle');
      }
    } catch (error) {
      const aborted =
        controller.signal.aborted ||
        (error instanceof Error && error.name === 'AbortError');
      // DURABLE: nothing below writes 'idle' on this path.
      setStatus('error');
      if (aborted) {
        // Stop or navigation after the first delta: the slot is already spent.
        setNote('Stopped — text so far is kept, and this request counted.');
        requestUsageRefresh();
      } else {
        setNote('Could not reach the service. Nothing was changed.');
      }
    } finally {
      // Refs only. Writing status here is exactly what used to erase 'error'.
      clearStreamRef();
    }
  };

  const stop = () => {
    controllerRef.current?.abort();
  };

  const copy = async () => {
    if (!output) return;
    await navigator.clipboard.writeText(output).catch(() => {
      setNote('Copy failed — select the text and copy it manually.');
    });
  };

  const streaming = status === 'streaming';
  const failed = status === 'error';
  const exhausted = usage !== null && usage.remaining <= 0;
  const canSend = !streaming && !exhausted && countChars(text.trim()) > 0;

  return (
    <main className="mx-auto w-full max-w-3xl flex-1 px-6 py-10">
      <h1 className="text-2xl font-semibold tracking-tight text-black dark:text-zinc-50">
        Paraphrase
      </h1>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        {usage
          ? `${usage.remaining} of ${usage.limit} left today.`
          : 'Your remaining count for today is loading.'}
      </p>

      <div className="mt-6">
        <label htmlFor="source" className="sr-only">
          Text to paraphrase
        </label>
        <textarea
          id="source"
          value={text}
          onChange={onTextChange}
          rows={8}
          // Deliberately NOT maxLength: the browser would silently truncate a
          // long paste and the user would never be told. The cap is enforced in
          // onTextChange, which trims AND flags it. The server re-validates via
          // the zod schema, so a hand-crafted request cannot exceed the cap.
          placeholder="Paste the text you want rewritten."
          className="w-full resize-y rounded-lg border border-black/10 bg-white px-3 py-2 font-mono text-sm text-black outline-none focus:border-black/30 dark:border-white/10 dark:bg-zinc-900 dark:text-zinc-50 dark:focus:border-white/25"
        />
        <div className="mt-1 flex items-baseline justify-between gap-3 text-xs">
          <span
            role={overLimit ? 'alert' : undefined}
            className={overLimit ? 'text-red-600 dark:text-red-400' : 'text-zinc-500'}
          >
            {overLimit
              ? `Trimmed to ${MAX_INPUT_CHARS.toLocaleString()} characters — that is the limit.`
              : `${MAX_INPUT_CHARS.toLocaleString()} characters maximum.`}
          </span>
          <span
            className={`font-mono tabular-nums ${
              countChars(text) >= MAX_INPUT_CHARS
                ? 'text-red-600 dark:text-red-400'
                : 'text-zinc-500'
            }`}
            aria-live="polite"
          >
            {countChars(text).toLocaleString()} / {MAX_INPUT_CHARS.toLocaleString()}
          </span>
        </div>
      </div>

      <fieldset className="mt-6">
        <legend className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          Mode
        </legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {MODES.map((option) => {
            const selected = option.id === mode;
            return (
              <button
                key={option.id}
                type="button"
                aria-pressed={selected}
                disabled={streaming}
                onClick={() => setMode(option.id)}
                className={`rounded-full border px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
                  selected
                    ? 'border-black bg-black text-white dark:border-white dark:bg-white dark:text-black'
                    : 'border-black/10 text-zinc-700 hover:bg-black/[.04] dark:border-white/15 dark:text-zinc-300 dark:hover:bg-white/[.06]'
                }`}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </fieldset>

      <fieldset className="mt-6">
        <legend className="text-xs font-medium uppercase tracking-wide text-zinc-500">
          Strength: {STRENGTHS.find((option) => option.id === strength)?.label}
        </legend>
        {/* 3-stop slider: the index maps onto STRENGTHS, so the DOM cannot
            drift from the table the prompt layer exposes. */}
        <input
          type="range"
          min={0}
          max={STRENGTHS.length - 1}
          step={1}
          value={Math.max(0, STRENGTHS.findIndex((option) => option.id === strength))}
          disabled={streaming}
          onChange={(event) => setStrength(STRENGTHS[Number(event.target.value)].id)}
          className="mt-2 w-full accent-black dark:accent-white"
          aria-label="Rewrite strength"
          list="strength-stops"
        />
        <datalist id="strength-stops">
          {STRENGTHS.map((option, index) => (
            <option key={option.id} value={index} label={option.label} />
          ))}
        </datalist>
      </fieldset>

      <div className="mt-6 flex items-center gap-3">
        <button
          type="button"
          onClick={paraphrase}
          // GATE: !streaming (double-submit guard) && !exhausted (remaining 0)
          // && non-empty input. NOT enforcement — the server bills at the first
          // non-empty delta and is the only authority on quota.
          disabled={!canSend}
          className="rounded-full bg-black px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-40 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
        >
          {streaming ? 'Paraphrasing…' : 'Paraphrase'}
        </button>
        {streaming && (
          <button
            type="button"
            onClick={stop}
            className="rounded-full border border-black/10 px-5 py-2.5 text-sm font-medium text-black transition-colors hover:bg-black/[.04] dark:border-white/15 dark:text-zinc-50 dark:hover:bg-white/[.06]"
          >
            Stop
          </button>
        )}
        {streaming && <span className="sr-only">Generating, please wait.</span>}
        {exhausted && !streaming && (
          <span role="status" className="text-xs text-red-600 dark:text-red-400">
            Daily limit reached
            {usage ? `, resets ${formatResetLocal(usage.resetsAt)}` : '.'}.
          </span>
        )}
      </div>

      <div className="mt-8">
        <div className="flex items-center justify-between">
          <h2 className="text-xs font-medium uppercase tracking-wide text-zinc-500">Result</h2>
          {output && (
            <button
              type="button"
              onClick={copy}
              className="text-xs text-zinc-500 underline hover:text-black dark:hover:text-zinc-50"
            >
              Copy
            </button>
          )}
        </div>
        {note && (
          <p
            role="alert"
            className="mt-2 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950 dark:text-red-300"
          >
            {note}
            {noteResetsAt ? ` Resets ${formatResetLocal(noteResetsAt)}.` : ''}
          </p>
        )}
        <pre
          data-status={status}
          className={`mt-2 min-h-32 whitespace-pre-wrap break-words rounded-lg border p-4 font-mono text-sm dark:bg-zinc-900 dark:text-zinc-50 ${
            failed
              ? 'border-red-300 bg-red-50/40 text-black dark:border-red-900 dark:bg-red-950/20 dark:text-zinc-50'
              : 'border-black/10 bg-zinc-50 text-black dark:border-white/10'
          }`}
        >
          {output}
          {streaming && <span aria-hidden="true">▌</span>}
        </pre>
        {failed && output && (
          <p className="mt-2 text-xs text-zinc-500">
            Partial text above is kept — this request counted against your limit.
          </p>
        )}
        {!output && !streaming && !failed && (
          <p className="mt-2 text-xs text-zinc-500">Your rewritten text streams here.</p>
        )}
      </div>
    </main>
  );
}
