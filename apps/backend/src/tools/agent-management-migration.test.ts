import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Logic mirror of migration 0029_split_agent_management_toolset.sql.
 *
 * The repo doesn't have real-Postgres test infra, so we mirror the SQL's
 * transformation in JS to verify the algorithm: additive, deduplicating,
 * idempotent, and only touches agents that previously had "agent-management".
 *
 * If you change the SQL, change this function to match.
 */
function applyMigration(toolSetIds: string[]): string[] {
  if (!toolSetIds.includes("agent-management")) {
    return toolSetIds;
  }
  if (
    toolSetIds.includes("agent-discovery") &&
    toolSetIds.includes("skill-management")
  ) {
    return toolSetIds;
  }
  return Array.from(
    new Set([...toolSetIds, "agent-discovery", "skill-management"]),
  );
}

describe("0029 split agent-management migration logic", () => {
  it("adds discovery + skill-management when agent-management is present alone", () => {
    expect(applyMigration(["agent-management"])).toEqual([
      "agent-management",
      "agent-discovery",
      "skill-management",
    ]);
  });

  it("preserves other toolset ids when expanding", () => {
    const result = applyMigration(["kanban", "agent-management", "time"]);
    expect(result).toEqual([
      "kanban",
      "agent-management",
      "time",
      "agent-discovery",
      "skill-management",
    ]);
  });

  it("does not touch agents without agent-management", () => {
    const input = ["kanban", "time"];
    expect(applyMigration(input)).toEqual(input);
  });

  it("is idempotent when both new ids are already present", () => {
    const input = ["agent-management", "agent-discovery", "skill-management"];
    expect(applyMigration(input)).toEqual(input);
  });

  it("does not duplicate when only one of the new ids is already present", () => {
    const result = applyMigration(["agent-management", "agent-discovery"]);
    expect(result).toEqual([
      "agent-management",
      "agent-discovery",
      "skill-management",
    ]);
    expect(new Set(result).size).toBe(result.length);
  });

  it("leaves an empty array untouched", () => {
    expect(applyMigration([])).toEqual([]);
  });
});

describe("0029 split agent-management migration SQL", () => {
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const sqlPath = join(
    __dirname,
    "../../drizzle/0029_split_agent_management_toolset.sql",
  );
  const sql = readFileSync(sqlPath, "utf8");

  it("targets the agent table tool_set_ids column", () => {
    expect(sql).toMatch(/UPDATE\s+"agent"/i);
    expect(sql).toMatch(/SET\s+"tool_set_ids"/i);
  });

  it("guards against non-matching rows via @> agent-management", () => {
    expect(sql).toMatch(
      /"tool_set_ids"\s*@>\s*'\["agent-management"\]'::jsonb/,
    );
  });

  it("appends agent-discovery and skill-management", () => {
    expect(sql).toContain("agent-discovery");
    expect(sql).toContain("skill-management");
  });

  it("uses DISTINCT to dedupe", () => {
    expect(sql).toMatch(/jsonb_agg\(\s*DISTINCT/i);
  });

  it("skips rows that already have both new ids (idempotency guard)", () => {
    expect(sql).toMatch(/agent-discovery/);
    expect(sql).toMatch(/skill-management/);
    expect(sql).toMatch(/NOT\s*\(/i);
  });
});
