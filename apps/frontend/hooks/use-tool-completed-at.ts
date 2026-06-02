import { useEffect, useState } from "react";
import { formatDurationMs, formatToolDuration } from "@/lib/utils";

const isTerminalState = (state: string): boolean => state.startsWith("output-");

/**
 * Resolves a tool call's run duration string for display in the tool header.
 *
 * - On a chat reload the server-persisted `startedAt`/`completedAt` are
 *   present (see `withToolTimestamps` / `applyToolCompletions` in the
 *   backend) and are used as the authoritative, exact value.
 * - During a live run those server timestamps aren't carried on the streamed
 *   message, so the duration is measured on the client: capture the clock when
 *   the tool is first observed running, and again when it first enters a
 *   terminal state. This makes the duration appear the instant the status
 *   flips to Completed/Error, then reconcile to the exact server value on
 *   reload.
 *
 * Returns undefined while a tool is still running (and on historical messages
 * that predate duration tracking), so the header renders nothing.
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
    // First time we see the tool running, mark the client-side start.
    if (!terminal && clientStart === undefined) setClientStart(Date.now());
  }, [terminal, clientStart]);

  useEffect(() => {
    // First time we see it terminal, freeze the client-side end.
    if (terminal && clientEnd === undefined) setClientEnd(Date.now());
  }, [terminal, clientEnd]);

  // Authoritative server-measured span (present after a reload).
  const serverDuration = formatToolDuration(startedAt, completedAt);
  if (serverDuration) return serverDuration;

  // Live client-measured span across the running -> terminal transition.
  if (clientStart !== undefined && clientEnd !== undefined) {
    return formatDurationMs(clientEnd - clientStart);
  }
  return undefined;
}
