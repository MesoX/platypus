import { useEffect, useState } from "react";

/**
 * Resolves the completion timestamp used to compute a tool call's run duration.
 *
 * - Prefers the server-persisted `completedAt` (authoritative; present after a
 *   chat reload — see `applyToolCompletions` in the backend).
 * - During a live run the server end time isn't in the stream, so the first
 *   time the tool is observed in a terminal state we capture the client clock
 *   once and freeze it. That makes the duration appear the moment the status
 *   flips to Completed/Error, then reconcile to the exact server value on
 *   reload.
 *
 * Returns undefined while the tool is still running and no server time exists,
 * so the header simply renders no duration yet.
 */
const isTerminalState = (state: string): boolean => state.startsWith("output-");

export function useToolCompletedAt(
  state: string,
  completedAt?: string,
): string | undefined {
  const [clientCompletedAt, setClientCompletedAt] = useState<string>();
  const terminal = isTerminalState(state);

  useEffect(() => {
    if (completedAt || !terminal) return;
    // Capture once — keep the first observed completion time stable across
    // re-renders so the displayed duration doesn't drift.
    setClientCompletedAt((prev) => prev ?? new Date().toISOString());
  }, [completedAt, terminal]);

  return completedAt ?? clientCompletedAt;
}
