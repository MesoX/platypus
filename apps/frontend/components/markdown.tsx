"use client";

import { useSyncExternalStore, type ComponentProps } from "react";
import { Streamdown, type ControlsConfig } from "streamdown";
import { linkSafety } from "@/components/link-safety";

/**
 * Markdown that is already whole when it renders: card bodies and comments,
 * text widgets, notification bodies, editor previews. The same renderer the
 * Chat draws messages with, minus the two things only a live stream wants —
 * the repair pass for half-written syntax, and the copy/download controls on
 * code blocks and tables.
 */
export const Markdown = (props: ComponentProps<typeof Streamdown>) => (
  <Streamdown
    controls={false}
    mode="static"
    linkSafety={linkSafety}
    {...props}
  />
);

// Streamdown's table copy calls `navigator.clipboard.write` with a
// `ClipboardItem`, which the clipboard fallback does not cover, so over plain
// HTTP it is hidden. The table can still be downloaded or selected by hand.
const insecureControls: ControlsConfig = { table: { copy: false } };

const noSubscribe = () => () => {};

/** The `controls` to give a Streamdown that keeps its copy buttons. */
export function useStreamdownControls(): ControlsConfig | undefined {
  const isInsecure = useSyncExternalStore(
    noSubscribe,
    () => window.isSecureContext === false,
    () => false,
  );
  return isInsecure ? insecureControls : undefined;
}
