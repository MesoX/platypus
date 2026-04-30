import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";

const {
  mockCreateOpenAI,
  mockCreateOpenRouter,
  mockCreateAmazonBedrock,
  mockCreateGoogleGenerativeAI,
  mockCreateAnthropic,
} = vi.hoisted(() => {
  const makeMock = () => {
    const instance = vi.fn((modelId: string) => ({ modelId, _sentinel: true }));
    const creator = vi.fn(() => instance);
    return { creator, instance };
  };
  const openai = makeMock();
  const openrouter = makeMock();
  const bedrock = makeMock();
  const google = makeMock();
  const anthropic = makeMock();
  return {
    mockCreateOpenAI: openai,
    mockCreateOpenRouter: openrouter,
    mockCreateAmazonBedrock: bedrock,
    mockCreateGoogleGenerativeAI: google,
    mockCreateAnthropic: anthropic,
  };
});

vi.mock("@ai-sdk/openai", () => ({ createOpenAI: mockCreateOpenAI.creator }));
vi.mock("@openrouter/ai-sdk-provider", () => ({
  createOpenRouter: mockCreateOpenRouter.creator,
}));
vi.mock("@ai-sdk/amazon-bedrock", () => ({
  createAmazonBedrock: mockCreateAmazonBedrock.creator,
}));
vi.mock("@ai-sdk/google", () => ({
  createGoogleGenerativeAI: mockCreateGoogleGenerativeAI.creator,
}));
vi.mock("@ai-sdk/anthropic", () => ({
  createAnthropic: mockCreateAnthropic.creator,
}));

import {
  prepareChatTurn,
  NotFoundError,
  ValidationError,
} from "./chat-execution.ts";

const baseProvider = {
  id: "p1",
  name: "Test",
  organizationId: "org-1",
  workspaceId: "ws-1",
  providerType: "OpenAI" as const,
  modelIds: ["gpt-4"],
  apiKey: "sk-test",
  baseUrl: null,
  headers: null,
  organization: null,
  project: null,
  region: null,
  extraBody: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const baseAgent = {
  id: "agent-1",
  name: "Test Agent",
  workspaceId: "ws-1",
  providerId: "p1",
  modelId: "gpt-4",
  maxSteps: 3,
  systemPrompt: null,
  temperature: null,
  topP: null,
  topK: null,
  frequencyPenalty: null,
  presencePenalty: null,
  seed: null,
  toolSetIds: [],
  skillIds: [],
  subAgentIds: [],
  description: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const baseWorkspace = {
  id: "ws-1",
  organizationId: "org-1",
  ownerId: "user-1",
  name: "Test Workspace",
  context: null,
  taskModelProviderId: null,
  memoryExtractionProviderId: null,
  memoryEmbeddingProviderId: null,
  maxDailySummaries: 30,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const baseInput = {
  orgId: "org-1",
  workspaceId: "ws-1",
  user: { id: "user-1", name: "Test User" },
  messages: [],
  origin: "http://localhost:4000",
};

describe("chat-execution", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
  });

  describe("prepareChatTurn", () => {
    it("Agent selection produces resolved IDs and a system prompt that surfaces the Agent's Skills", async () => {
      const agentWithSkill = {
        ...baseAgent,
        skillIds: ["skill-1"],
      };

      // .limit() is the awaited terminal for fetchWorkspace + the two
      // resolveChatContext queries (workspace, agent, provider).
      mockDb.limit
        .mockResolvedValueOnce([baseWorkspace])
        .mockResolvedValueOnce([agentWithSkill])
        .mockResolvedValueOnce([baseProvider]);

      // .where() is mid-chain for those three queries (returns mockDb so
      // .limit() can be called on it) and then terminal for loadSkills and
      // fetchUserContexts in the parallel block.
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([
          { name: "kanban-flow", description: "Manage kanban boards" },
        ])
        .mockResolvedValueOnce([]);
      mockDb.orderBy.mockResolvedValueOnce([]); // retrieveRecentSummaries

      const turn = await prepareChatTurn({
        ...baseInput,
        request: { id: "chat-1", agentId: agentWithSkill.id },
      });

      // resolved is what persistence will write
      expect(turn.resolved.agentId).toBe(agentWithSkill.id);
      expect(turn.resolved.providerId).toBe(baseProvider.id);
      expect(turn.resolved.modelId).toBe("gpt-4");
      // Agent-driven turn → row stores no copy of generation params
      expect(turn.resolved.systemPrompt).toBeUndefined();
      expect(turn.resolved.temperature).toBeUndefined();

      // stream is what streamText will consume
      expect(turn.stream.maxSteps).toBe(3);
      expect(turn.stream.system).toContain("kanban-flow");
      expect(turn.stream.system).toContain("Manage kanban boards");
      expect(turn.stream.tools).toHaveProperty("loadSkill");
      expect(turn.stream.messages).toEqual([]);

      // dispose is idempotent and does nothing without MCP clients
      await expect(turn.dispose()).resolves.toBeUndefined();
      await expect(turn.dispose()).resolves.toBeUndefined();
    });

    it("Direct Provider+Model selection populates resolved.systemPrompt and merges request overrides", async () => {
      mockDb.limit
        .mockResolvedValueOnce([baseWorkspace]) // fetchWorkspace
        .mockResolvedValueOnce([baseProvider]); // resolveChatContext: provider (no agent fetch)

      // .where() mid-chain twice (workspace, provider lookups), then terminal
      // for fetchUserContexts. No agent → loadTools/loadSkills/loadSubAgents
      // all short-circuit before hitting the DB.
      mockDb.where
        .mockReturnValueOnce(mockDb)
        .mockReturnValueOnce(mockDb)
        .mockResolvedValueOnce([]);
      mockDb.orderBy.mockResolvedValueOnce([]); // retrieveRecentSummaries

      const turn = await prepareChatTurn({
        ...baseInput,
        request: {
          id: "chat-2",
          providerId: baseProvider.id,
          modelId: "gpt-4",
          systemPrompt: "Be terse.",
          temperature: 0.7,
        },
      });

      expect(turn.resolved.agentId).toBeUndefined();
      expect(turn.resolved.providerId).toBe(baseProvider.id);
      expect(turn.resolved.modelId).toBe("gpt-4");
      // Direct turn → resolved carries the params that will be written to the row
      expect(turn.resolved.systemPrompt).toBeDefined();
      expect(turn.resolved.systemPrompt).toContain("Be terse.");
      expect(turn.resolved.temperature).toBe(0.7);

      // stream config matches resolved on a Direct turn
      expect(turn.stream.system).toContain("Be terse.");
      expect(turn.stream.temperature).toBe(0.7);
      // Direct turns default maxSteps to 1
      expect(turn.stream.maxSteps).toBe(1);
    });

    it("throws ValidationError when neither agentId nor providerId+modelId is supplied", async () => {
      mockDb.limit.mockResolvedValueOnce([baseWorkspace]); // fetchWorkspace succeeds

      await expect(
        prepareChatTurn({
          ...baseInput,
          request: { id: "chat-3" } as any,
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("throws NotFoundError when the Agent does not exist", async () => {
      mockDb.limit
        .mockResolvedValueOnce([baseWorkspace]) // fetchWorkspace
        .mockResolvedValueOnce([]); // resolveChatContext: agent missing

      await expect(
        prepareChatTurn({
          ...baseInput,
          request: { id: "chat-4", agentId: "agent-missing" },
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("throws NotFoundError when the Provider does not exist", async () => {
      mockDb.limit
        .mockResolvedValueOnce([baseWorkspace]) // fetchWorkspace
        .mockResolvedValueOnce([]); // resolveChatContext: provider missing

      await expect(
        prepareChatTurn({
          ...baseInput,
          request: {
            id: "chat-5",
            providerId: "p-missing",
            modelId: "gpt-4",
          },
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });

    it("throws ValidationError when the model id is not enabled on the Provider", async () => {
      mockDb.limit
        .mockResolvedValueOnce([baseWorkspace]) // fetchWorkspace
        .mockResolvedValueOnce([{ ...baseProvider, modelIds: ["gpt-3.5"] }]);

      await expect(
        prepareChatTurn({
          ...baseInput,
          request: {
            id: "chat-6",
            providerId: baseProvider.id,
            modelId: "gpt-4",
          },
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });

    it("throws NotFoundError when the Workspace does not exist", async () => {
      mockDb.limit.mockResolvedValueOnce([]); // fetchWorkspace miss

      await expect(
        prepareChatTurn({
          ...baseInput,
          request: {
            id: "chat-7",
            providerId: baseProvider.id,
            modelId: "gpt-4",
          },
        }),
      ).rejects.toBeInstanceOf(NotFoundError);
    });
  });
});
