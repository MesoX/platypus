import { generateText, stepCountIs, tool, type Tool } from "ai";
import { z } from "zod";
import { logger } from "../logger.ts";

/**
 * Options for creating a sub-agent tool.
 */
interface SubAgentToolOptions {
  id: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  model: any; // LanguageModel from AI SDK
  tools: Record<string, Tool>;
  maxSteps?: number;
}

/**
 * Creates a server-side tool that executes a sub-agent using generateText.
 * The sub-agent runs within the parent's tool execution and returns results directly.
 *
 * @param options Sub-agent configuration including model, tools, and prompts
 * @returns A tool that can be used by the parent agent to delegate tasks
 */
export const createSubAgentTool = (options: SubAgentToolOptions) => {
  const {
    id,
    name,
    description,
    systemPrompt,
    model,
    tools,
    maxSteps = 50,
  } = options;

  // Generate a slugified tool name (e.g., "delegateToResearchAgent")
  const toolName = `delegateTo${name
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, c) => c.toUpperCase())
    .replace(/[^a-zA-Z0-9]/g, "")
    .replace(/^./, (c) => c.toUpperCase())}`;

  return {
    toolName,
    tool: tool({
      description: description
        ? `Delegate a task to the "${name}" sub-agent: ${description}`
        : `Delegate a task to the "${name}" sub-agent.`,
      inputSchema: z.object({
        task: z
          .string()
          .describe(
            "A fully self-contained task description. Include ALL necessary context, constraints, and requirements directly. The task must be understandable without any prior conversation context.",
          ),
      }),
      execute: async ({ task }, { abortSignal }) => {
        // Use generateText with maxSteps to run the sub-agent's tool-calling loop.
        // This avoids the O(n²) memory pressure caused by streaming intermediate
        // message states (readUIMessageStream yields the full accumulated message
        // on every delta, creating thousands of large objects under GC pressure).
        const { text } = await generateText({
          model,
          system:
            systemPrompt ||
            `You are a specialized sub-agent named "${name}". Complete the task you are given thoroughly and accurately.`,
          prompt: task,
          tools,
          stopWhen: stepCountIs(maxSteps),
          abortSignal,
        });
        return text;
      },
    }),
  };
};

/**
 * Creates sub-agent tools for all sub-agents assigned to a parent agent.
 * Each sub-agent becomes its own tool that the parent can call.
 *
 * @param subAgents List of sub-agent configurations from the database
 * @param createModelFn Factory function to create a model instance for a sub-agent
 * @param loadToolsFn Async function to load tools for a sub-agent
 * @returns Array of {toolName, tool} objects to add to the parent's tools
 */
export const createSubAgentTools = async (
  subAgents: Array<{
    id: string;
    name: string;
    description?: string | null;
    systemPrompt?: string | null;
    providerId: string;
    modelId: string;
    toolSetIds?: string[] | null;
    maxSteps?: number | null;
  }>,
  createModelFn: (providerId: string, modelId: string) => Promise<any>,
  loadToolsFn: (
    subAgentId: string,
    toolSetIds: string[],
  ) => Promise<Record<string, Tool>>,
): Promise<Record<string, Tool>> => {
  const tools: Record<string, Tool> = {};

  for (const subAgent of subAgents) {
    try {
      // Get the sub-agent's model
      const model = await createModelFn(subAgent.providerId, subAgent.modelId);

      // Load the sub-agent's tools
      const subAgentTools = await loadToolsFn(
        subAgent.id,
        subAgent.toolSetIds || [],
      );

      // Create the tool
      const { toolName, tool } = createSubAgentTool({
        id: subAgent.id,
        name: subAgent.name,
        description: subAgent.description || undefined,
        systemPrompt: subAgent.systemPrompt || undefined,
        model,
        tools: subAgentTools,
        maxSteps: subAgent.maxSteps || 50,
      });

      tools[toolName] = tool;
    } catch (error) {
      logger.error(
        { error, subAgentName: subAgent.name, subAgentId: subAgent.id },
        `Failed to create sub-agent tool for "${subAgent.name}"`,
      );
      // Continue with other sub-agents even if one fails
    }
  }

  return tools;
};
