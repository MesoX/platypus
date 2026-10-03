import { useSyncExternalStore } from "react";
import type { ControlsConfig } from "streamdown";
import { toast } from "sonner";

/**
 * Copies text to the clipboard, also where the Clipboard API is missing.
 *
 * `navigator.clipboard` exists only in a secure context (HTTPS or localhost),
 * and a self-hosted deployment is often served over plain HTTP on a LAN name.
 * There the fallback selects the text in a throwaway textarea and runs the
 * legacy copy command, which still works from a click handler.
 *
 * The textarea goes into the open dialog that holds focus, if any: a modal's
 * focus trap pulls focus back from an element outside it, and the copy then
 * finds nothing selected.
 *
 * Resolves `true` when the text was copied, `false` when neither way worked.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission refused or document not focused: try the fallback.
    }
  }

  const container =
    document.activeElement?.closest<HTMLElement>(
      '[role="dialog"], [role="alertdialog"]',
    ) ?? document.body;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "0";
  textarea.style.opacity = "0";
  container.appendChild(textarea);
  const previousFocus = document.activeElement as HTMLElement | null;
  try {
    textarea.focus();
    textarea.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    container.removeChild(textarea);
    previousFocus?.focus();
  }
}

/** {@link copyToClipboard} with the usual success or failure toast. */
export async function copyWithToast(
  text: string,
  copied = "Copied to clipboard",
): Promise<boolean> {
  const ok = await copyToClipboard(text);
  if (ok) toast.success(copied);
  else toast.error("Failed to copy to clipboard");
  return ok;
}

/**
 * Over plain HTTP the browser leaves `navigator.clipboard` out, and
 * Streamdown's code-block and diagram copy buttons call
 * `navigator.clipboard.writeText` themselves. Standing in for that one method
 * sends them through {@link copyToClipboard}'s fallback.
 */
export function installClipboardFallback() {
  if (window.isSecureContext !== false || navigator.clipboard) return;
  Object.defineProperty(navigator, "clipboard", {
    value: {
      writeText: async (text: string) => {
        if (!(await copyToClipboard(text))) throw new Error("Copy failed");
      },
    },
    configurable: true,
  });
}

if (typeof window !== "undefined") installClipboardFallback();

// Streamdown's table copy calls `navigator.clipboard.write` with a
// `ClipboardItem`, which the stand-in above does not cover, so over plain
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
