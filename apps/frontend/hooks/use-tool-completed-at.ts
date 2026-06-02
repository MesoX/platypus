import { useEffect, useState } from "react";
import { formatDurationMs, formatToolDuration } from "@/lib/utils";

const isTerminalState = (state: string): boolean => state.startsWith("output-");

const toMs = (iso?: string): number | undefined => {
  if (!iso) return undefined;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? undefined : t;
};

/**
 * Resolves a tool call's run-duration string for the tool header.
 *
 * - While the tool is running it shows a live elapsed timer, ticking once a
 *   second from when the tool was first observed (the server start time isn't
 *   carried on the streamed message, so we measure on the client).
 * - When it turns terminal it freezes: the exact server-measured span if both
 *   `startedAt`/`completedAt` are persisted (after a chat reload), otherwise
 *   the client-observed span.
 *
 * A client clock is only used when the tool was actually seen running this
 * session, so reloading a chat (tool already terminal at mount) never shows a
 * bogus value — it relies on the server timestamps or shows nothing.
 *
 * Returns undefined when there's nothing meaningful to show (e.g. a historical
 * message that predates duration tracking).
 */
export function useToolDuration(
  state: string,
  startedAt?: string,
  completedAt?: string,
): string | undefined {
  const running = !isTerminalState(state);
  const [clientStart, setClientStart] = useState<number>();
  const [clientEnd, setClientEnd] = useState<number>();
  const [, tick] = useState(0);

  // While running: capture the start once and tick every second so the
  // elapsed time updates on screen.
  useEffect(() => {
    if (!running) return;
    if (clientStart === undefined) setClientStart(Date.now());
    const id = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [running, clientStart]);

  // On the first terminal render (only if we saw it running): freeze the end.
  useEffect(() => {
    if (!running && clientStart !== undefined && clientEnd === undefined) {
      setClientEnd(Date.now());
    }
  }, [running, clientStart, clientEnd]);

  // Live elapsed timer while running.
  if (running) {
    if (clientStart === undefined) return undefined;
    return formatDurationMs(Date.now() - clientStart);
  }

  // Terminal: exact server span if available, else the client-observed span.
  const serverDuration = formatToolDuration(startedAt, completedAt);
  if (serverDuration) return serverDuration;

  const startMs = toMs(startedAt) ?? clientStart;
  const endMs =
    toMs(completedAt) ?? (clientStart !== undefined ? clientEnd : undefined);
  if (startMs !== undefined && endMs !== undefined && endMs >= startMs) {
    return formatDurationMs(endMs - startMs);
  }
  return undefined;
}
