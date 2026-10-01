/**
 * Copies text to the clipboard, also where the Clipboard API is missing.
 *
 * `navigator.clipboard` exists only in a secure context (HTTPS or localhost),
 * and a self-hosted deployment is often served over plain HTTP on a LAN name.
 * There the fallback selects the text in a throwaway textarea and runs the
 * legacy copy command, which still works from a click handler.
 *
 * `container` is where that textarea goes. Inside a modal it must be in the
 * modal: a focus trap pulls focus back from an element outside it, and the
 * copy then finds nothing selected.
 *
 * Resolves `true` when the text was copied, `false` when neither way worked.
 */
export async function copyToClipboard(
  text: string,
  container: HTMLElement = document.body,
): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission refused or document not focused: try the fallback.
    }
  }

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
