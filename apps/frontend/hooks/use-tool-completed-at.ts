import { useEffect, useState } from "react";
import { formatDurationMs, formatToolDuration } from "@/lib/utils";

const isTerminalState = (state: string): boolean => state.startsWith("output-");

const toMs = (iso?: string): number | undefined => {
  if (!iso) return undefined;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? undefined : t;
};

/**
 * Resolves a tool call's run duration string for the tool header.
 *
 * Sources, in priority order:
 * 1. Exact server span — `startedAt`+`completedAt` persisted by the backend
 *    (present after a chat reload of a completed run).
 * 2. Live / pre-persist span — the server timestamps aren't carried on the
 *    streamed message, so we observe the tool client-side: capture the clock
 *    when it's first seen running and again when it first turns terminal. The
 *    duration then appears the instant the status flips to Completed/Error.
 *    A client end time is only used when we also saw the tool running this
 *    session, so reloading a chat (tool already terminal at mount) never
 *    fabricates a bogus span — it just waits for the server value.
 *
 * Returns undefined while a tool is still running, and on historical messages
 * that predate duration tracking, so the header renders nothing.
 */
export function useToolDuration(
  state: string,
  startedAt?: string,
  completedAt?: string,
): string | undefined {
  const terminal = isTerminalState(state);
  const [clientStart, setClientStart] = useState<number>();
  const [clientEnd, setClientEnd] = useState<number>();

  useEffect(() => {
    if (!terminal && clientStart === undefined) setClientStart(Date.now());
  }, [terminal, clientStart]);

  useEffect(() => {
    if (terminal && clientEnd === undefined) setClientEnd(Date.now());
  }, [terminal, clientEnd]);

  // 1) Authoritative, exact server-measured span.
  const serverDuration = formatToolDuration(startedAt, completedAt);
  if (serverDuration) return serverDuration;

  if (!terminal) return undefined;

  // 2) Best-effort span: prefer server timestamps, fall back to client-observed
  //    ones. Only trust a client end when we also captured a client start
  //    (i.e. we witnessed the run live), so a reload can't yield a huge value.
  const startMs = toMs(startedAt) ?? clientStart;
  const endMs =
    toMs(completedAt) ?? (clientStart !== undefined ? clientEnd : undefined);
  if (startMs !== undefined && endMs !== undefined && endMs >= startMs) {
    return formatDurationMs(endMs - startMs);
  }
  return undefined;
}
