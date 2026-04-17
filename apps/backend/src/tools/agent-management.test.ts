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

vi.mock("../services/sub-agent-validation.ts", () => ({
  validateSubAgentAssignment: vi.fn().mockResolvedValue({ valid: true }),
}));

vi.mock("../storage/index.ts", () => ({
  getStorage: vi.fn(() => ({
    delete: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual("drizzle-orm");
  return {
    ...actual,
    eq: vi.fn(),
    and: vi.fn((...args) => args.filter(Boolean)),
    sql: Object.assign(
      vi.fn((strings: TemplateStringsArray, ...values: any[]) => ({
        getSQL: () => ({ query: strings.join("?") }),
      })),
      { raw: vi.fn() },
    ),
  };
});

import { createAgentManagementTools } from "./agent-management.ts";
import { validateSubAgentAssignment } from "../services/sub-agent-validation.ts";

const ctx = { toolCallId: "test", messages: [] };
const workspaceId = "ws-1";
const orgId = "org-1";
const frontendUrl = "http://localhost:3000";

function resetDb() {
  dbMethods.forEach((method) => {
    mockDb[method] = vi.fn().mockReturnValue(mockDb);
  });
}

describe("createAgentManagementTools", () => {
  let tools: ReturnType<typeof createAgentManagementTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetDb();
    tools = createAgentManagementTools(workspaceId, orgId, frontendUrl);
  });

  it("returns the expected tool names", () => {
    expect(Object.keys(tools)).toEqual([
      "listToolSets",
      "listModelProviders",
      "listSkills",
      "getSkill",
      "upsertSkill",
      "deleteSkill",
      "listAgents",
      "getAgent",
      "createAgent",
      "updateAgent",
      "deleteAgent",
    ]);
  });

  describe("listModelProviders", () => {
    it("returns providers for workspace and org", async () => {
      const providers = [
        { id: "p1", name: "Provider 1", modelIds: ["model-a", "model-b"] },
        { id: "p2", name: "Provider 2", modelIds: ["model-c"] },
      ];
      mockDb.where.mockResolvedValue(providers);

      const result = await tools.listModelProviders.execute({}, ctx);
      expect(result).toEqual(providers);
    });
  });

  describe("listAgents", () => {
    it("returns agents in workspace", async () => {
      const agents = [{ id: "a1", name: "Agent 1" }];
      mockDb.where.mockResolvedValue(agents);

      const result = await tools.listAgents.execute({}, ctx);
      expect(result).toEqual(agents);
    });
  });

  describe("getAgent", () => {
    it("returns error when agent not found", async () => {
      mockDb.limit.mockResolvedValue([]);

      const result = await tools.getAgent.execute(
        { agentId: "bad-id", label: "test" },
        ctx,
      );
      expect(result).toEqual({ error: "Agent not found" });
    });

    it("returns agent details when found", async () => {
      const agent = {
        id: "a1",
        name: "Agent 1",
        workspaceId,
        modelId: "m1",
        providerId: "p1",
      };
      mockDb.limit.mockResolvedValue([agent]);

      const result = await tools.getAgent.execute(
        { agentId: "a1", label: "Agent 1" },
        ctx,
      );
      expect(result).toMatchObject({ id: "a1", name: "Agent 1" });
      expect(result.url).toContain("agents/a1");
    });
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

  describe("updateAgent", () => {
    it("returns error when agent not found", async () => {
      mockDb.returning.mockResolvedValue([]);

      const result = await tools.updateAgent.execute(
        { agentId: "bad-id", label: "test", name: "New Name" },
        ctx,
      );
      expect(result).toEqual({ error: "Agent not found" });
    });

    it("validates sub-agent assignments", async () => {
      vi.mocked(validateSubAgentAssignment).mockResolvedValueOnce({
        valid: false,
        error: "Circular dependency detected",
      });

      const result = await tools.updateAgent.execute(
        { agentId: "a1", label: "test", subAgentIds: ["a1"] },
        ctx,
      );

      expect(result).toEqual({ error: "Circular dependency detected" });
    });
  });

  describe("deleteAgent", () => {
    it("returns error when agent not found", async () => {
      mockDb.limit.mockResolvedValue([]);

      const result = await tools.deleteAgent.execute(
        { agentId: "bad-id", label: "test" },
        ctx,
      );
      expect(result).toEqual({ error: "Agent not found" });
    });

    it("deletes agent and cleans up avatar", async () => {
      mockDb.limit.mockResolvedValue([{ avatarKey: "avatars/a1.png" }]);

      const result = await tools.deleteAgent.execute(
        { agentId: "a1", label: "Agent 1" },
        ctx,
      );
      expect(result).toEqual({ success: true });
    });

    it("deletes agent without avatar", async () => {
      mockDb.limit.mockResolvedValue([{ avatarKey: null }]);

      const result = await tools.deleteAgent.execute(
        { agentId: "a1", label: "Agent 1" },
        ctx,
      );
      expect(result).toEqual({ success: true });
    });
  });
});
