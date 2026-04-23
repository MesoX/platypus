import { describe, it, expect, vi, beforeEach } from "vitest";
import { createSubAgentTool, createSubAgentTools } from "./sub-agent.ts";

vi.mock("ai", async () => {
  const actual = await vi.importActual("ai");
  return {
    ...actual,
    generateText: vi.fn().mockResolvedValue({ text: "Sub-agent result" }),
  };
});

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

describe("createSubAgentTool", () => {
  const baseOptions = {
    id: "agent-1",
    name: "Research Agent",
    model: {},
    tools: {},
  };

  describe("toolName generation", () => {
    it("generates PascalCase delegateTo prefix", () => {
      const { toolName } = createSubAgentTool(baseOptions);
      expect(toolName).toBe("delegateToResearchAgent");
    });

    it("handles single-word names", () => {
      const { toolName } = createSubAgentTool({
        ...baseOptions,
        name: "Helper",
      });
      expect(toolName).toBe("delegateToHelper");
    });

    it("strips non-alphanumeric characters", () => {
      const { toolName } = createSubAgentTool({
        ...baseOptions,
        name: "My (Special) Agent!",
      });
      expect(toolName).toMatch(/^delegateTo[A-Za-z0-9]+$/);
    });

    it("handles hyphenated names", () => {
      const { toolName } = createSubAgentTool({
        ...baseOptions,
        name: "code-review",
      });
      expect(toolName).toBe("delegateToCodeReview");
    });
  });

  describe("tool description", () => {
    it("uses custom description when provided", () => {
      const { tool } = createSubAgentTool({
        ...baseOptions,
        description: "Does research tasks",
      });
      expect(tool.description).toContain("Does research tasks");
      expect(tool.description).toContain("Research Agent");
    });

    it("uses default description when none provided", () => {
      const { tool } = createSubAgentTool(baseOptions);
      expect(tool.description).toContain("Research Agent");
    });
  });

  describe("execute", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("returns text from generateText", async () => {
      const { generateText } = await import("ai");
      const { tool } = createSubAgentTool(baseOptions);
      const result = await tool.execute({ task: "Do something" }, {} as any);
      expect(result).toBe("Sub-agent result");
      expect(generateText).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: "Do something" }),
      );
    });

    it("uses custom system prompt when provided", async () => {
      const { generateText } = await import("ai");
      const { tool } = createSubAgentTool({
        ...baseOptions,
        systemPrompt: "Custom instructions",
      });
      await tool.execute({ task: "Do something" }, {} as any);
      expect(generateText).toHaveBeenCalledWith(
        expect.objectContaining({ system: "Custom instructions" }),
      );
    });

    it("uses default system prompt when none provided", async () => {
      const { generateText } = await import("ai");
      const { tool } = createSubAgentTool(baseOptions);
      await tool.execute({ task: "Do something" }, {} as any);
      expect(generateText).toHaveBeenCalledWith(
        expect.objectContaining({
          system: expect.stringContaining("Research Agent"),
        }),
      );
    });
  });
});

describe("createSubAgentTools", () => {
  it("returns empty object when given no sub-agents", async () => {
    const result = await createSubAgentTools([], vi.fn(), vi.fn());
    expect(result).toEqual({});
  });

  it("creates tools for each sub-agent", async () => {
    const subAgents = [
      {
        id: "sa-1",
        name: "Research",
        providerId: "p1",
        modelId: "m1",
        toolSetIds: ["ts1"],
      },
      {
        id: "sa-2",
        name: "Coder",
        providerId: "p1",
        modelId: "m1",
        toolSetIds: [],
      },
    ];

    const createModelFn = vi.fn().mockResolvedValue({});
    const loadToolsFn = vi.fn().mockResolvedValue({});

    const result = await createSubAgentTools(
      subAgents,
      createModelFn,
      loadToolsFn,
    );

    expect(Object.keys(result)).toHaveLength(2);
    expect(result).toHaveProperty("delegateToResearch");
    expect(result).toHaveProperty("delegateToCoder");
    expect(createModelFn).toHaveBeenCalledTimes(2);
    expect(loadToolsFn).toHaveBeenCalledTimes(2);
  });

  it("continues when a sub-agent fails to initialize", async () => {
    const subAgents = [
      {
        id: "sa-1",
        name: "Failing",
        providerId: "p1",
        modelId: "m1",
      },
      {
        id: "sa-2",
        name: "Working",
        providerId: "p1",
        modelId: "m1",
      },
    ];

    const createModelFn = vi
      .fn()
      .mockRejectedValueOnce(new Error("Model not found"))
      .mockResolvedValueOnce({});
    const loadToolsFn = vi.fn().mockResolvedValue({});

    const result = await createSubAgentTools(
      subAgents,
      createModelFn,
      loadToolsFn,
    );

    expect(Object.keys(result)).toHaveLength(1);
    expect(result).toHaveProperty("delegateToWorking");
  });

  it("uses default maxSteps when not provided", async () => {
    const subAgents = [
      {
        id: "sa-1",
        name: "Agent",
        providerId: "p1",
        modelId: "m1",
        maxSteps: null,
      },
    ];

    const createModelFn = vi.fn().mockResolvedValue({});
    const loadToolsFn = vi.fn().mockResolvedValue({});

    const result = await createSubAgentTools(
      subAgents,
      createModelFn,
      loadToolsFn,
    );

    expect(Object.keys(result)).toHaveLength(1);
  });
});
