import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, dbMethods } = vi.hoisted(() => {
  const mock: any = {};
  const methods = [
    "select",
    "from",
    "where",
    "limit",
    "orderBy",
    "insert",
    "values",
    "update",
    "set",
    "delete",
    "returning",
    "onConflictDoUpdate",
  ];
  methods.forEach((method) => {
    mock[method] = vi.fn().mockReturnValue(mock);
  });
  return { mockDb: mock, dbMethods: methods };
});

vi.mock("../index.ts", () => ({
  db: mockDb,
}));

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual("drizzle-orm");
  return {
    ...actual,
    eq: vi.fn(),
    and: vi.fn((...args) => args.filter(Boolean)),
    sql: Object.assign(
      vi.fn((strings: TemplateStringsArray, ..._values: any[]) => ({
        getSQL: () => ({ query: strings.join("?") }),
      })),
      { raw: vi.fn() },
    ),
  };
});

import { createSkillManagementTools } from "./skill-management.ts";

const ctx = { toolCallId: "test", messages: [] };
const workspaceId = "ws-1";
const orgId = "org-1";
const frontendUrl = "http://localhost:3000";

function resetDb() {
  dbMethods.forEach((method) => {
    mockDb[method] = vi.fn().mockReturnValue(mockDb);
  });
}

describe("createSkillManagementTools", () => {
  let tools: ReturnType<typeof createSkillManagementTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetDb();
    tools = createSkillManagementTools(workspaceId, orgId, frontendUrl);
  });

  it("returns the expected tool names", () => {
    expect(Object.keys(tools)).toEqual([
      "listSkills",
      "getSkill",
      "upsertSkill",
      "deleteSkill",
    ]);
  });

  describe("listSkills", () => {
    it("returns skills in workspace", async () => {
      const skills = [{ id: "s1", name: "my-skill" }];
      mockDb.where.mockResolvedValue(skills);

      const result = await tools.listSkills.execute({}, ctx);
      expect(result).toEqual(skills);
    });
  });

  describe("getSkill", () => {
    it("returns error when skill not found", async () => {
      mockDb.limit.mockResolvedValue([]);

      const result = await tools.getSkill.execute({ name: "nonexistent" }, ctx);
      expect(result).toEqual({ error: "Skill not found" });
    });

    it("returns skill details when found", async () => {
      const skill = { id: "s1", name: "my-skill", body: "content" };
      mockDb.limit.mockResolvedValue([skill]);

      const result = await tools.getSkill.execute({ name: "my-skill" }, ctx);
      expect(result).toMatchObject({ name: "my-skill" });
      expect(result.url).toContain("skills/s1");
    });
  });

  describe("upsertSkill", () => {
    it("creates or updates a skill via upsert", async () => {
      const skill = { id: "s1", name: "my-skill", body: "content" };
      mockDb.returning.mockResolvedValue([skill]);

      const result = await tools.upsertSkill.execute(
        {
          name: "my-skill",
          description: "A skill for testing purposes",
          body: "This is the skill body content that should be long enough to pass validation",
        },
        ctx,
      );

      expect(result).toMatchObject({ name: "my-skill" });
    });
  });

  describe("deleteSkill", () => {
    it("returns error when skill not found", async () => {
      mockDb.limit.mockResolvedValue([]);

      const result = await tools.deleteSkill.execute(
        { name: "nonexistent" },
        ctx,
      );
      expect(result).toEqual({ error: "Skill not found" });
    });

    it("returns error when skill is referenced by agents", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: "s1" }]);
      mockDb.limit.mockResolvedValueOnce([{ id: "a1" }]);

      const result = await tools.deleteSkill.execute(
        { name: "referenced-skill" },
        ctx,
      );
      expect(result.error).toContain("referenced by one or more agents");
    });

    it("deletes skill when no agents reference it", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: "s1" }]);
      mockDb.limit.mockResolvedValueOnce([]);

      const result = await tools.deleteSkill.execute(
        { name: "unused-skill" },
        ctx,
      );
      expect(result).toEqual({ success: true });
    });
  });
});
