import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, resetMockDb } from "../test-utils.ts";

const {
  mockGenerateText,
  mockOpenProvider,
  mockSearchTools,
  mockLoadTools,
  mockLoadSkills,
  mockLoadSubAgents,
  mockFetchUserContexts,
  mockFetchMemories,
  mockResolveGenerationConfig,
  mockPrepareAgentTools,
  mockValidateCronExpression,
} = vi.hoisted(() => ({
  mockGenerateText: vi.fn(),
  mockOpenProvider: vi.fn(),
  mockSearchTools: vi.fn(),
  mockLoadTools: vi.fn(),
  mockLoadSkills: vi.fn(),
  mockLoadSubAgents: vi.fn(),
  mockFetchUserContexts: vi.fn(),
  mockFetchMemories: vi.fn(),
  mockResolveGenerationConfig: vi.fn(),
  mockPrepareAgentTools: vi.fn(),
  mockValidateCronExpression: vi.fn(),
}));

vi.mock("ai", () => ({
  generateText: mockGenerateText,
  stepCountIs: vi.fn((n: number) => ({ type: "stepCount", value: n })),
}));

vi.mock("./chat-execution.ts", () => ({
  loadTools: mockLoadTools,
  loadSkills: mockLoadSkills,
  loadSubAgents: mockLoadSubAgents,
  fetchUserContexts: mockFetchUserContexts,
  fetchMemories: mockFetchMemories,
  resolveGenerationConfig: mockResolveGenerationConfig,
  prepareAgentTools: mockPrepareAgentTools,
}));

vi.mock("./provider.ts", () => ({
  openProvider: mockOpenProvider,
}));

vi.mock("../utils/cron.ts", () => ({
  validateCronExpression: mockValidateCronExpression,
}));

vi.mock("../logger.ts", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("nanoid", () => ({
  nanoid: vi.fn(() => "test-id"),
}));

import { executeTrigger, updateTriggerAfterRun } from "./trigger-execution.ts";

const baseTrigger = {
  id: "trigger-1",
  workspaceId: "ws-1",
  agentId: "agent-1",
  type: "cron" as const,
  name: "Test Trigger",
  description: null,
  instruction: "Do something",
  enabled: true,
  maxRunsToKeep: 10,
  search: false,
  config: { cronExpression: "0 * * * *", timezone: "UTC", isOneOff: false },
  lastRunAt: null,
  nextRunAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockAgent = {
  id: "agent-1",
  name: "Test Agent",
  workspaceId: "ws-1",
  providerId: "provider-1",
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

const mockWorkspace = {
  id: "ws-1",
  organizationId: "org-1",
  ownerId: "user-1",
  name: "Test Workspace",
  context: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockProvider = {
  id: "provider-1",
  name: "Test Provider",
  providerType: "OpenAI",
  apiKey: "sk-test",
  baseUrl: null,
  modelIds: ["gpt-4"],
  organizationId: "org-1",
  workspaceId: "ws-1",
  headers: null,
  organization: null,
  project: null,
  region: null,
  extraBody: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const mockMcpClient = { close: vi.fn() };

function setupDefaultMocks() {
  // DB queries: agent, workspace (parallel), then provider
  mockDb.limit
    .mockResolvedValueOnce([mockAgent]) // agent query
    .mockResolvedValueOnce([mockWorkspace]) // workspace query
    .mockResolvedValueOnce([mockProvider]); // provider query

  mockOpenProvider.mockReturnValue({
    languageModel: vi.fn(() => ({ modelId: "gpt-4" })),
    searchTools: mockSearchTools,
  });
  mockSearchTools.mockReturnValue({});
  mockLoadTools.mockResolvedValue({
    tools: { tool1: {} },
    mcpClients: [mockMcpClient],
  });
  mockLoadSubAgents.mockResolvedValue({
    subAgents: [],
    subAgentTools: {},
    subAgentMcpClients: [],
  });
  mockLoadSkills.mockResolvedValue([]);
  mockFetchUserContexts.mockResolvedValue({
    userGlobalContext: "global",
    userWorkspaceContext: "workspace",
  });
  mockFetchMemories.mockResolvedValue([]);
  mockResolveGenerationConfig.mockReturnValue({
    systemPrompt: "You are helpful",
    temperature: 0.7,
  });
  mockGenerateText.mockResolvedValue({
    text: "Agent response",
    steps: [
      {
        toolCalls: [
          { toolName: "tool1", args: {} },
          { toolName: "tool1", args: {} },
        ],
      },
      { toolCalls: [{ toolName: "tool2", args: {} }] },
    ],
    totalUsage: { inputTokens: 100, outputTokens: 50 },
  });
  mockDb.returning.mockResolvedValue([{ id: "test-id" }]);
}

describe("trigger-execution", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    process.env.FRONTEND_URL = "http://localhost:3000";
  });

  describe("executeTrigger", () => {
    it("should execute a trigger and return a run ID", async () => {
      setupDefaultMocks();

      const runId = await executeTrigger(baseTrigger as any);

      expect(runId).toBe("test-id");
      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "Do something",
          system: "You are helpful",
        }),
      );
    });

    it("should prepend event context to instruction for event triggers", async () => {
      setupDefaultMocks();

      await executeTrigger(baseTrigger as any, {
        eventType: "card.created",
        eventData: { cardId: "c1" },
      });

      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining("Event: card.created"),
        }),
      );
      expect(mockGenerateText).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.stringContaining("Do something"),
        }),
      );
    });

    it("should throw and mark run as failed when agent not found", async () => {
      mockDb.limit
        .mockResolvedValueOnce([]) // agent not found
        .mockResolvedValueOnce([mockWorkspace]);

      await expect(executeTrigger(baseTrigger as any)).rejects.toThrow(
        "Agent 'agent-1' not found",
      );
      // Should have updated run status to failed
      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "failed" }),
      );
    });

    it("should throw and mark run as failed when workspace not found", async () => {
      mockDb.limit.mockResolvedValueOnce([mockAgent]).mockResolvedValueOnce([]); // workspace not found

      await expect(executeTrigger(baseTrigger as any)).rejects.toThrow(
        "Workspace 'ws-1' not found",
      );
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "failed" }),
      );
    });

    it("should throw and mark run as failed when provider not found", async () => {
      mockDb.limit
        .mockResolvedValueOnce([mockAgent])
        .mockResolvedValueOnce([mockWorkspace])
        .mockResolvedValueOnce([]); // provider not found

      await expect(executeTrigger(baseTrigger as any)).rejects.toThrow(
        "Provider 'provider-1' not found",
      );
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({ status: "failed" }),
      );
    });

    it("should close MCP clients after execution", async () => {
      setupDefaultMocks();

      await executeTrigger(baseTrigger as any);

      expect(mockMcpClient.close).toHaveBeenCalled();
    });

    it("should close MCP clients even when execution fails", async () => {
      setupDefaultMocks();
      mockGenerateText.mockRejectedValue(new Error("AI error"));

      await expect(executeTrigger(baseTrigger as any)).rejects.toThrow(
        "AI error",
      );
      expect(mockMcpClient.close).toHaveBeenCalled();
    });

    it("should enable search tools when trigger.search is true", async () => {
      setupDefaultMocks();
      mockSearchTools.mockReturnValue({ searchTool: {} });

      const trigger = { ...baseTrigger, search: true } as any;
      await executeTrigger(trigger);

      expect(mockSearchTools).toHaveBeenCalled();
    });

    it("should mark run as success with stats on completion", async () => {
      setupDefaultMocks();

      await executeTrigger(baseTrigger as any);

      // The success update should have been called with stats
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "success",
          stats: {
            steps: 2,
            toolCalls: [
              { name: "tool1", count: 2 },
              { name: "tool2", count: 1 },
            ],
            inputTokens: 100,
            outputTokens: 50,
          },
        }),
      );
    });

    it("should mark run as failed when generateText throws", async () => {
      setupDefaultMocks();
      mockGenerateText.mockRejectedValue(new Error("Model error"));

      await expect(executeTrigger(baseTrigger as any)).rejects.toThrow(
        "Model error",
      );
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          status: "failed",
          errorMessage: "Model error",
        }),
      );
    });
  });

  describe("updateTriggerAfterRun", () => {
    it("should update lastRunAt and compute nextRunAt for cron triggers", async () => {
      const nextRun = new Date("2026-01-01T01:00:00Z");
      mockValidateCronExpression.mockReturnValue(nextRun);
      // Retention queries return fewer items than limit, so no deletes
      mockDb.limit.mockResolvedValue([]);

      await updateTriggerAfterRun("trigger-1", baseTrigger as any);

      expect(mockDb.update).toHaveBeenCalled();
      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          nextRunAt: nextRun,
          enabled: true,
        }),
      );
    });

    it("should disable one-off cron triggers after execution", async () => {
      mockDb.limit.mockResolvedValue([]);
      const trigger = {
        ...baseTrigger,
        config: {
          cronExpression: "0 * * * *",
          timezone: "UTC",
          isOneOff: true,
        },
      } as any;

      await updateTriggerAfterRun("trigger-1", trigger);

      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          enabled: false,
          nextRunAt: null,
        }),
      );
    });

    it("should set nextRunAt to null for event triggers", async () => {
      mockDb.limit.mockResolvedValue([]);
      const trigger = {
        ...baseTrigger,
        type: "event",
        config: { events: ["card.created"] },
      } as any;

      await updateTriggerAfterRun("trigger-1", trigger);

      expect(mockDb.set).toHaveBeenCalledWith(
        expect.objectContaining({
          nextRunAt: null,
          enabled: true,
        }),
      );
    });

    it("should perform retention cleanup when maxRunsToKeep > 0", async () => {
      mockValidateCronExpression.mockReturnValue(new Date());
      // Retention queries return enough items to trigger deletion
      mockDb.limit.mockResolvedValue(
        Array.from({ length: 10 }, (_, i) => ({ id: `item-${i}` })),
      );
      mockDb.returning.mockResolvedValue([]);

      await updateTriggerAfterRun("trigger-1", baseTrigger as any);

      // retainNewest should query runs
      expect(mockDb.select).toHaveBeenCalled();
    });

    it("should skip retention cleanup when maxRunsToKeep is 0", async () => {
      mockValidateCronExpression.mockReturnValue(new Date());
      const trigger = { ...baseTrigger, maxRunsToKeep: 0 } as any;

      // Reset to track calls after update
      resetMockDb();
      await updateTriggerAfterRun("trigger-1", trigger);

      // Only the update call, no select for retention
      expect(mockDb.update).toHaveBeenCalled();
    });
  });
});
