import { describe, it, expect } from "vitest";
import { SECURITY_GUARD_CATALOG } from "@platypus/schemas";
import { renderGuardrails, guardPromptIds } from "./security-guards.ts";

describe("renderGuardrails", () => {
  it("returns null for empty or undefined input", () => {
    expect(renderGuardrails([])).toBeNull();
    expect(renderGuardrails(undefined as unknown as string[])).toBeNull();
  });

  it("returns null when only unknown ids are given", () => {
    expect(renderGuardrails(["nope", "also-nope"])).toBeNull();
  });

  it("renders the prompt for a known guard under a heading", () => {
    const out = renderGuardrails(["untrusted-data"]);
    expect(out).toContain("## Security and trust");
    expect(out).toContain("UNTRUSTED DATA");
  });

  it("skips unknown ids but keeps known ones", () => {
    const out = renderGuardrails(["bogus", "exfiltration"]);
    expect(out).not.toBeNull();
    expect(out).toContain("BCC");
  });

  it("emits guards in catalog order regardless of selection order", () => {
    // untrusted-data precedes authority-spoofing in the catalog.
    const out = renderGuardrails(["authority-spoofing", "untrusted-data"])!;
    expect(out.indexOf("UNTRUSTED DATA")).toBeLessThan(
      out.indexOf("carry authority"),
    );
  });
});

describe("guard registry integrity", () => {
  it("has a prompt for every catalog id and vice versa", () => {
    const catalogIds = [...SECURITY_GUARD_CATALOG.map((g) => g.id)].sort();
    const promptIds = [...guardPromptIds()].sort();
    expect(promptIds).toEqual(catalogIds);
  });

  it("catalog ids are unique", () => {
    const ids = SECURITY_GUARD_CATALOG.map((g) => g.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
