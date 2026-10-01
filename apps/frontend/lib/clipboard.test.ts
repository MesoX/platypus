import { describe, it, expect, vi, afterEach } from "vitest";
import { copyToClipboard } from "./clipboard";

// jsdom does not define `isSecureContext` at all.
const stubSecureContext = (secure: boolean) =>
  Object.defineProperty(window, "isSecureContext", {
    value: secure,
    configurable: true,
  });

// jsdom implements neither the Clipboard API nor execCommand, so both are
// installed per test and removed after.
const setClipboard = (writeText: ((text: string) => Promise<void>) | null) =>
  Object.defineProperty(navigator, "clipboard", {
    value: writeText ? { writeText } : undefined,
    configurable: true,
  });

const setExecCommand = (impl: (command: string) => boolean) =>
  Object.defineProperty(document, "execCommand", {
    value: vi.fn(impl),
    configurable: true,
  });

afterEach(() => {
  vi.restoreAllMocks();
  setClipboard(null);
});

describe("copyToClipboard", () => {
  it("uses the Clipboard API in a secure context", async () => {
    stubSecureContext(true);
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard(writeText);
    setExecCommand(() => true);

    expect(await copyToClipboard("tok_123")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("tok_123");
    expect(document.execCommand).not.toHaveBeenCalled();
  });

  it("falls back to the copy command over plain HTTP, where the API is missing", async () => {
    stubSecureContext(false);
    let selected = "";
    setExecCommand((command) => {
      const active = document.activeElement as HTMLTextAreaElement;
      selected = active.value.slice(active.selectionStart, active.selectionEnd);
      return command === "copy";
    });
    const container = document.createElement("div");
    document.body.appendChild(container);

    expect(await copyToClipboard("tok_123", container)).toBe(true);
    expect(selected).toBe("tok_123");
    // The throwaway textarea is gone afterwards.
    expect(container.querySelector("textarea")).toBeNull();
    container.remove();
  });

  it("falls back when the Clipboard API refuses", async () => {
    stubSecureContext(true);
    setClipboard(vi.fn().mockRejectedValue(new Error("NotAllowedError")));
    setExecCommand(() => true);

    expect(await copyToClipboard("tok_123")).toBe(true);
    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });

  it("reports failure when neither way copies", async () => {
    stubSecureContext(false);
    setExecCommand(() => false);

    expect(await copyToClipboard("tok_123")).toBe(false);
  });
});
