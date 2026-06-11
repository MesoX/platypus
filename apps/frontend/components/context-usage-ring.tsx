"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/**
 * Context-usage ring (context-compaction-plan §H).
 *
 * Renders a small SVG donut ring showing `inputTokens / contextWindow` fill.
 * Colours: green < 0.7, amber >= 0.7, red >= 0.9.
 * Shows neutral grey with no percentage when contextWindow is unknown/default
 * (drift T6) or when no run has completed yet.
 *
 * The denominator (`contextWindow`) must come from the currently-selected model
 * — NOT the last message's metadata — so the ring updates immediately on model
 * switch without waiting for a new run (drift U1).
 */
export function ContextUsageRing({
  usedTokens,
  contextWindow,
}: {
  /** Peak context fullness = last model call's input tokens (NOT run-wide sum). */
  usedTokens?: number;
  contextWindow?: number | null;
}) {
  const r = 7;
  const circumference = 2 * Math.PI * r;

  const isNeutral = !contextWindow || usedTokens === undefined;
  const fill = isNeutral
    ? 0
    : Math.min(1, Math.max(0, usedTokens / contextWindow));

  const color = isNeutral
    ? "var(--color-muted-foreground)"
    : fill >= 0.9
      ? "var(--color-destructive)"
      : fill >= 0.7
        ? "#f59e0b"
        : "var(--color-primary)";

  const tooltipLabel = isNeutral
    ? "Context usage unknown"
    : `Last response: ${usedTokens.toLocaleString()} / ${contextWindow.toLocaleString()} (${Math.round(fill * 100)}%) · current input not yet counted`;

  return (
    <Tooltip delayDuration={500}>
      <TooltipTrigger asChild>
        <div className="flex items-center justify-center w-8 h-8 cursor-default">
          <svg
            width="20"
            height="20"
            viewBox="0 0 20 20"
            aria-label={tooltipLabel}
          >
            {/* Track */}
            <circle
              cx="10"
              cy="10"
              r={r}
              fill="none"
              stroke="var(--color-border)"
              strokeWidth="3"
            />
            {/* Fill */}
            <circle
              cx="10"
              cy="10"
              r={r}
              fill="none"
              stroke={color}
              strokeWidth="3"
              strokeDasharray={`${circumference}`}
              strokeDashoffset={`${circumference * (1 - fill)}`}
              strokeLinecap="butt"
              transform="rotate(-90 10 10)"
              style={{ transition: "stroke-dashoffset 0.3s ease" }}
            />
          </svg>
        </div>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-xs text-center text-xs">
        {tooltipLabel}
      </TooltipContent>
    </Tooltip>
  );
}
