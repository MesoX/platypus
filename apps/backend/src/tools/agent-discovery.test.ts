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
    or: vi.fn((...args) => args.filter(Boolean)),
    and: vi.fn((...args) => args.filter(Boolean)),
  };
});

import { createAgentDiscoveryTools } from "./agent-discovery.ts";

const ctx = { toolCallId: "test", messages: [] };
const workspaceId = "ws-1";
const orgId = "org-1";
const frontendUrl = "http://localhost:3000";

function resetDb() {
  dbMethods.forEach((method) => {
    mockDb[method] = vi.fn().mockReturnValue(mockDb);
  });
}

describe("createAgentDiscoveryTools", () => {
  let tools: ReturnType<typeof createAgentDiscoveryTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetDb();
    tools = createAgentDiscoveryTools(workspaceId, orgId, frontendUrl);
  });

  it("returns the expected tool names", () => {
    expect(Object.keys(tools)).toEqual([
      "listToolSets",
      "listModelProviders",
      "listAgents",
      "getAgent",
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
});
