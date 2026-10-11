import { describe, it, expect } from "vitest";
import { servedFileHeaders } from "./response-headers.ts";

describe("servedFileHeaders", () => {
  it("serves an SVG as a sandboxed download", () => {
    expect(servedFileHeaders("image/svg+xml")).toEqual({
      "Content-Disposition": "attachment",
      "Content-Security-Policy": "sandbox; default-src 'none'",
    });
  });

  it("matches the SVG rule regardless of case and parameters", () => {
    expect(servedFileHeaders("Image/SVG+XML; charset=utf-8")).toEqual(
      servedFileHeaders("image/svg+xml"),
    );
  });

  it("sandboxes other types without forcing a download", () => {
    for (const type of [
      "image/png",
      "video/mp4",
      "text/plain",
      "application/json",
    ]) {
      expect(servedFileHeaders(type)).toEqual({
        "Content-Security-Policy": "sandbox",
      });
    }
  });

  it("leaves a PDF alone so the browser's viewer can show it", () => {
    expect(servedFileHeaders("application/pdf")).toEqual({});
  });
});
