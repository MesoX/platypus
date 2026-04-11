import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";
import {
  retrieveUserLevelMemories,
  retrieveWorkspaceLevelMemories,
  retrieveMemories,
  formatMemoriesForSystemPrompt,
  formatMemoriesForExtractionPrompt,
} from "./memory-retrieval.ts";

const makeMemory = (overrides: Partial<any> = {}) => ({
  id: "mem-1",
  userId: "user-1",
  workspaceId: null,
  entityType: "preference",
  entityName: "theme",
  observation: "Prefers dark mode",
  createdAt: new Date(),
  updatedAt: new Date(),
  ...overrides,
});

beforeEach(() => {
  resetMockDb();
});

describe("retrieveUserLevelMemories", () => {
  it("returns memories from DB", async () => {
    const memories = [makeMemory(), makeMemory({ id: "mem-2" })];
    mockDb.orderBy.mockResolvedValueOnce(memories);

    const result = await retrieveUserLevelMemories("user-1");

    expect(result).toEqual(memories);
  });

  it("returns empty array when none exist", async () => {
    mockDb.orderBy.mockResolvedValueOnce([]);

    const result = await retrieveUserLevelMemories("user-1");

    expect(result).toEqual([]);
  });
});

describe("retrieveWorkspaceLevelMemories", () => {
  it("returns workspace memories", async () => {
    const memories = [makeMemory({ workspaceId: "ws-1" })];
    mockDb.orderBy.mockResolvedValueOnce(memories);

    const result = await retrieveWorkspaceLevelMemories("user-1", "ws-1");

    expect(result).toEqual(memories);
  });

  it("returns empty array when none exist", async () => {
    mockDb.orderBy.mockResolvedValueOnce([]);

    const result = await retrieveWorkspaceLevelMemories("user-1", "ws-1");

    expect(result).toEqual([]);
  });
});

describe("retrieveMemories", () => {
  it("returns combined memories", async () => {
    const memories = [
      makeMemory(),
      makeMemory({ id: "mem-2", workspaceId: "ws-1" }),
    ];
    mockDb.orderBy.mockResolvedValueOnce(memories);

    const result = await retrieveMemories("user-1", "ws-1");

    expect(result).toEqual(memories);
  });

  it("returns empty array when none exist", async () => {
    mockDb.orderBy.mockResolvedValueOnce([]);

    const result = await retrieveMemories("user-1", "ws-1");

    expect(result).toEqual([]);
  });
});

describe("formatMemoriesForSystemPrompt", () => {
  it("returns empty string for empty array", () => {
    expect(formatMemoriesForSystemPrompt([])).toBe("");
  });

  it("returns header + TSV rows for non-empty", () => {
    const memories = [makeMemory()];
    const result = formatMemoriesForSystemPrompt(memories);

    expect(result).toMatch(/^The following memories/);
    expect(result).toContain("id\ttype\tentity\tobservation");
  });

  it("excludes scope column", () => {
    const memory = makeMemory({ workspaceId: "ws-1" });
    const result = formatMemoriesForSystemPrompt([memory]);
    const lines = result.split("\n");
    const headerLine = lines[2];
    const dataLine = lines[lines.length - 1];

    expect(headerLine).toBe("id\ttype\tentity\tobservation");
    expect(dataLine.split("\t")).toHaveLength(4);
  });

  it("maps entityType to type and entityName to entity", () => {
    const memory = makeMemory({
      entityType: "preference",
      entityName: "theme",
      observation: "Prefers dark mode",
    });
    const result = formatMemoriesForSystemPrompt([memory]);
    const lines = result.split("\n");
    const dataLine = lines[lines.length - 1];
    const fields = dataLine.split("\t");

    expect(fields[1]).toBe("preference");
    expect(fields[2]).toBe("theme");
  });
});

describe("formatMemoriesForExtractionPrompt", () => {
  it("returns 'No existing memories.' for empty array", () => {
    expect(formatMemoriesForExtractionPrompt([])).toBe("No existing memories.");
  });

  it("returns TSV header + data rows for non-empty", () => {
    const memories = [makeMemory(), makeMemory({ id: "mem-2" })];
    const result = formatMemoriesForExtractionPrompt(memories);
    const lines = result.split("\n");

    expect(lines).toHaveLength(3); // header + 2 data rows
    expect(lines[0]).toBe("id\ttype\tentity\tobservation\tscope");
    expect(lines[1].split("\t")).toHaveLength(5);
    expect(lines[2].split("\t")).toHaveLength(5);
    expect(result).not.toMatch(/^The following memories/);
  });
});
