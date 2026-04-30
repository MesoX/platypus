import { experimental_createMCPClient as createMCPClient } from "@ai-sdk/mcp";
import { openProvider } from "./provider.ts";
import { and, eq, or, inArray } from "drizzle-orm";
import { db } from "../index.ts";
import {
  agent as agentTable,
  context as contextTable,
  mcp as mcpTable,
  provider as providerTable,
  skill as skillTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import { getToolSet } from "../tools/index.ts";
import { createLoadSkillTool } from "../tools/skill.ts";
import { createSubAgentTools } from "../tools/sub-agent.ts";
import {
  renderSystemPrompt,
  type SystemPromptContext,
} from "../system-prompt.ts";
import {
  retrieveRecentSummaries,
  type MemorySummary,
} from "./memory-retrieval.ts";
import type {
  ChatSubmitData as ChatSubmitDataSchema,
  Provider,
  Skill,
} from "@platypus/schemas";
import type { Tool } from "ai";
import { logger } from "../logger.ts";
import { buildMcpTransportConfig } from "./mcp-oauth-provider.ts";
import { inlineFileUrls } from "../storage/utils.ts";
import type { PlatypusUIMessage } from "../types.ts";

// --- Errors ---

/**
 * Thrown when the caller's request is malformed or references resources in an
 * inconsistent way (e.g. a model id not enabled on the chosen provider).
 * The route maps this to a 400 response.
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

/**
 * Thrown when a referenced record does not exist (Agent, Provider, Workspace).
 * The route maps this to a 404 response.
 */
export class NotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotFoundError";
  }
}

// --- Types ---

export type ChatContext = {
  provider: Provider;
  agent?: typeof agentTable.$inferSelect;
  resolvedModelId: string;
  resolvedProviderId: string;
  resolvedAgentId?: string;
  resolvedMaxSteps: number;
};

export type GenerationConfig = {
  systemPrompt?: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  skills?: Array<Pick<Skill, "name" | "description">>;
};

export type ChatSubmitData = {
  agentId?: string;
  providerId?: string;
  modelId?: string;
  search?: boolean;
  systemPrompt?: string;
  temperature?: number;
  topP?: number;
  topK?: number;
  seed?: number;
  presencePenalty?: number;
  frequencyPenalty?: number;
};

export type ChatTurn = {
  stream: {
    model: any;
    tools: Record<string, Tool>;
    system: string;
    messages: PlatypusUIMessage[];
    maxSteps: number;
    temperature?: number;
    topP?: number;
    topK?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    seed?: number;
  };
  resolved: {
    agentId?: string;
    providerId: string;
    modelId: string;
    systemPrompt?: string;
    temperature?: number;
    topP?: number;
    topK?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    seed?: number;
  };
  dispose: () => Promise<void>;
};

export type PrepareChatTurnInput = {
  orgId: string;
  workspaceId: string;
  user: { id: string; name: string };
  request: ChatSubmitDataSchema;
  messages: PlatypusUIMessage[];
  origin: string;
  frontendUrl?: string;
};

// --- Public Module: prepare a Chat turn ---

/**
 * Prepares everything required to run a Chat turn: resolves the Agent and
 * Provider, builds the model, loads Tools / Skills / sub-Agents / Memories,
 * renders the system prompt, inlines file URLs, and returns a stream-ready
 * config plus a `dispose` to release MCP clients.
 *
 * Caller passes the result to `streamText` and calls `dispose` on abort and
 * on `onFinish`. Persistence reads from `resolved`.
 */
export const prepareChatTurn = async (
  input: PrepareChatTurnInput,
): Promise<ChatTurn> => {
  const { orgId, workspaceId, user, request, messages, origin, frontendUrl } =
    input;

  const workspace = await fetchWorkspace(workspaceId);
  const context = await resolveChatContext(
    request as ChatSubmitData,
    orgId,
    workspaceId,
  );
  const { provider, agent, resolvedModelId, resolvedMaxSteps } = context;

  const opened = openProvider(provider);
  const model = opened.languageModel(resolvedModelId);

  const [
    { tools, mcpClients },
    skills,
    { subAgents, subAgentTools, subAgentMcpClients },
    { userGlobalContext, userWorkspaceContext },
    memories,
  ] = await Promise.all([
    loadTools(agent, workspaceId, orgId, frontendUrl, user.id),
    loadSkills(agent, workspaceId),
    loadSubAgents(agent, orgId, workspaceId, frontendUrl),
    fetchUserContexts(user.id, workspaceId),
    fetchMemories(user.id, workspaceId),
  ]);

  const allMcpClients = [...mcpClients, ...subAgentMcpClients];

  if (request.search) {
    Object.assign(tools, opened.searchTools?.() ?? {});
  }

  Object.assign(tools, subAgentTools);

  const promptCtx: SystemPromptContext = {
    workspace: { id: workspaceId, context: workspace.context ?? undefined },
    agent: agent ?? null,
    user: {
      id: user.id,
      name: user.name,
      globalContext: userGlobalContext,
      workspaceContext: userWorkspaceContext,
    },
    memories,
    skills,
    subAgents,
    fallbackSystemPrompt: request.systemPrompt,
  };

  const generation = resolveGenerationConfig(
    request as ChatSubmitData,
    agent,
    promptCtx,
  );

  prepareAgentTools(tools, skills, workspaceId);

  const inlinedMessages = await inlineFileUrls(messages, origin);

  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    for (const client of allMcpClients) {
      try {
        await client.close();
      } catch (e) {
        logger.error({ error: e }, "Error closing MCP client");
      }
    }
  };

  const systemPrompt = generation.systemPrompt!;

  return {
    stream: {
      model,
      tools,
      system: systemPrompt,
      messages: inlinedMessages,
      maxSteps: resolvedMaxSteps,
      temperature: generation.temperature,
      topP: generation.topP,
      topK: generation.topK,
      frequencyPenalty: generation.frequencyPenalty,
      presencePenalty: generation.presencePenalty,
      seed: request.seed,
    },
    resolved: {
      agentId: context.resolvedAgentId,
      providerId: context.resolvedProviderId,
      modelId: context.resolvedModelId,
      // Only Direct (no-Agent) turns persist generation params on the row;
      // Agent-driven turns read them back from the Agent record.
      systemPrompt: agent ? undefined : systemPrompt,
      temperature: agent ? undefined : generation.temperature,
      topP: agent ? undefined : generation.topP,
      topK: agent ? undefined : generation.topK,
      frequencyPenalty: agent ? undefined : generation.frequencyPenalty,
      presencePenalty: agent ? undefined : generation.presencePenalty,
      seed: agent ? undefined : request.seed,
    },
    dispose,
  };
};

// --- Helper Functions ---

const fetchWorkspace = async (
  workspaceId: string,
): Promise<typeof workspaceTable.$inferSelect> => {
  const rows = await db
    .select()
    .from(workspaceTable)
    .where(eq(workspaceTable.id, workspaceId))
    .limit(1);
  if (rows.length === 0) {
    throw new NotFoundError(`Workspace '${workspaceId}' not found`);
  }
  return rows[0];
};

/**
 * Resolves the chat context: determines the agent (if any), provider, and model to use.
 */
export const resolveChatContext = async (
  data: ChatSubmitData,
  orgId: string,
  workspaceId: string,
): Promise<ChatContext> => {
  const { agentId, providerId, modelId } = data;

  let resolvedProviderId: string;
  let resolvedModelId: string;
  let resolvedAgentId: string | undefined;
  let resolvedMaxSteps = 1;
  let agent: typeof agentTable.$inferSelect | undefined;

  if (agentId) {
    // Agent selected - fetch agent and use its configuration
    resolvedAgentId = agentId;
    const agentRecord = await db
      .select()
      .from(agentTable)
      .where(
        and(
          eq(agentTable.id, agentId),
          eq(agentTable.workspaceId, workspaceId),
        ),
      )
      .limit(1);

    if (agentRecord.length === 0) {
      throw new NotFoundError(`Agent '${agentId}' not found`);
    }
    agent = agentRecord[0];
    resolvedProviderId = agent.providerId;
    resolvedModelId = agent.modelId;
    resolvedMaxSteps = agent.maxSteps ?? 1;
  } else if (providerId && modelId) {
    // Direct provider/model selection
    resolvedProviderId = providerId;
    resolvedModelId = modelId;
    resolvedAgentId = undefined;
  } else {
    throw new ValidationError(
      "Must provide either agentId or (providerId and modelId)",
    );
  }

  // Get the provider record from the database
  const providerRecord = await db
    .select()
    .from(providerTable)
    .where(
      and(
        eq(providerTable.id, resolvedProviderId),
        or(
          eq(providerTable.workspaceId, workspaceId),
          eq(providerTable.organizationId, orgId),
        ),
      ),
    )
    .limit(1);

  if (providerRecord.length === 0) {
    throw new NotFoundError(
      `Provider with id '${resolvedProviderId}' not found`,
    );
  }
  const provider = providerRecord[0] as Provider;

  // Check the received modelId is enabled/defined on the provider
  if (!provider.modelIds.includes(resolvedModelId)) {
    throw new ValidationError(
      `Model id '${resolvedModelId}' not enabled for provider '${resolvedProviderId}'`,
    );
  }

  return {
    provider,
    agent,
    resolvedModelId,
    resolvedProviderId,
    resolvedAgentId,
    resolvedMaxSteps,
  };
};

/**
 * Loads tools for the chat session, including static tools and MCP clients.
 */
export const loadTools = async (
  agent: typeof agentTable.$inferSelect | undefined,
  workspaceId: string,
  orgId: string,
  frontendUrl: string | undefined,
  userId?: string,
): Promise<{ tools: Record<string, Tool>; mcpClients: any[] }> => {
  const tools: Record<string, Tool> = {};
  const mcpClients: any[] = [];

  if (!agent || !agent.toolSetIds || agent.toolSetIds.length === 0) {
    return { tools, mcpClients };
  }

  for (const toolSetId of agent.toolSetIds) {
    try {
      const toolSet = getToolSet(toolSetId);
      const resolvedTools =
        typeof toolSet.tools === "function"
          ? toolSet.tools({
              workspaceId,
              agentId: agent.id,
              orgId,
              frontendUrl,
              userId: userId || "",
            })
          : toolSet.tools;
      Object.assign(tools, resolvedTools);
    } catch (error) {
      // If static tool set not found, try to load as MCP
      const mcpRecord = await db
        .select()
        .from(mcpTable)
        .where(
          and(
            eq(mcpTable.id, toolSetId),
            eq(mcpTable.workspaceId, workspaceId),
          ),
        )
        .limit(1);

      if (mcpRecord.length > 0) {
        const mcp = mcpRecord[0];
        if (mcp.url) {
          const mcpClient = await createMCPClient({
            transport: buildMcpTransportConfig(mcp),
          });
          const mcpTools = await mcpClient.tools();
          Object.assign(tools, mcpTools);
          mcpClients.push(mcpClient);
        } else {
          logger.warn(`MCP '${toolSetId}' has no URL configured`);
        }
      } else {
        logger.warn(
          `Tool set with id '${toolSetId}' not found as static tool set or MCP`,
        );
      }
    }
  }

  return { tools, mcpClients };
};

/**
 * Resolves the generation configuration (system prompt, temperature, etc.)
 * by merging agent settings with request overrides and rendering the prompt
 * from the supplied SystemPromptContext.
 */
export const resolveGenerationConfig = (
  data: ChatSubmitData,
  agent: typeof agentTable.$inferSelect | undefined,
  promptCtx: SystemPromptContext,
): GenerationConfig => {
  const config: GenerationConfig = {};
  const source = agent || data;

  Object.assign(
    config,
    source.temperature != null && { temperature: source.temperature },
    source.topP != null && { topP: source.topP },
    source.topK != null && { topK: source.topK },
    source.frequencyPenalty != null && {
      frequencyPenalty: source.frequencyPenalty,
    },
    source.presencePenalty != null && {
      presencePenalty: source.presencePenalty,
    },
  );

  config.systemPrompt = renderSystemPrompt(promptCtx);
  return config;
};

/**
 * Loads skills for an agent.
 */
export const loadSkills = async (
  agent: typeof agentTable.$inferSelect | undefined,
  workspaceId: string,
): Promise<Array<Pick<Skill, "name" | "description">>> => {
  if (!agent?.skillIds || agent.skillIds.length === 0) {
    return [];
  }

  const skillRecords = await db
    .select({ name: skillTable.name, description: skillTable.description })
    .from(skillTable)
    .where(
      and(
        eq(skillTable.workspaceId, workspaceId),
        inArray(skillTable.id, agent.skillIds),
      ),
    );

  return skillRecords;
};

/**
 * Loads sub-agent details and creates delegate tools.
 */
export const loadSubAgents = async (
  agent: typeof agentTable.$inferSelect | undefined,
  orgId: string,
  workspaceId: string,
  frontendUrl: string | undefined,
): Promise<{
  subAgents: Array<{ id: string; name: string; description?: string | null }>;
  subAgentTools: Record<string, Tool>;
  subAgentMcpClients: any[];
}> => {
  if (!agent?.subAgentIds || agent.subAgentIds.length === 0) {
    return { subAgents: [], subAgentTools: {}, subAgentMcpClients: [] };
  }

  // Fetch full sub-agent configs including provider/model/tool info
  const subAgentRecords = await db
    .select()
    .from(agentTable)
    .where(inArray(agentTable.id, agent.subAgentIds));

  const subAgents = subAgentRecords.map((sa) => ({
    id: sa.id,
    name: sa.name,
    description: sa.description,
  }));

  // Collect MCP clients created for sub-agents so they can be closed on completion
  const subAgentMcpClients: any[] = [];

  // Create sub-agent tools with their own models and tools
  const subAgentTools = await createSubAgentTools(
    subAgentRecords,
    async (providerId: string, modelId: string) => {
      // Resolve provider for the sub-agent
      const subProviderRecord = await db
        .select()
        .from(providerTable)
        .where(
          and(
            eq(providerTable.id, providerId),
            or(
              eq(providerTable.workspaceId, workspaceId),
              eq(providerTable.organizationId, orgId),
            ),
          ),
        )
        .limit(1);

      if (subProviderRecord.length === 0) {
        throw new Error(`Provider '${providerId}' not found for sub-agent`);
      }

      return openProvider(subProviderRecord[0] as Provider).languageModel(
        modelId,
      );
    },
    async (subAgentId: string, toolSetIds: string[]) => {
      // Load tools for the sub-agent, passing the full record so dynamic
      // tool sets (e.g. kanban) can resolve the correct agent ID.
      const subAgentRecord = subAgentRecords.find((sa) => sa.id === subAgentId);
      const { tools: subTools, mcpClients } = await loadTools(
        subAgentRecord ?? ({ id: subAgentId, toolSetIds } as any),
        workspaceId,
        orgId,
        frontendUrl,
      );
      subAgentMcpClients.push(...mcpClients);
      return subTools;
    },
  );

  return { subAgents, subAgentTools, subAgentMcpClients };
};

/**
 * Fetches user contexts (global and workspace-specific).
 */
export const fetchUserContexts = async (
  userId: string,
  workspaceId: string,
): Promise<{ userGlobalContext?: string; userWorkspaceContext?: string }> => {
  let userGlobalContext: string | undefined;
  let userWorkspaceContext: string | undefined;

  const userContexts = await db
    .select({
      content: contextTable.content,
      workspaceId: contextTable.workspaceId,
    })
    .from(contextTable)
    .where(eq(contextTable.userId, userId));

  for (const ctx of userContexts) {
    if (ctx.workspaceId === null) {
      userGlobalContext = ctx.content;
    } else if (ctx.workspaceId === workspaceId) {
      userWorkspaceContext = ctx.content;
    }
  }

  return { userGlobalContext, userWorkspaceContext };
};

/**
 * Fetches recent daily summary rows for the user. Formatting happens inside
 * the system-prompt memories fragment.
 */
export const fetchMemories = async (
  userId: string,
  workspaceId: string,
): Promise<MemorySummary[]> => {
  return retrieveRecentSummaries(userId, workspaceId);
};

/**
 * Prepares tools for an agent execution.
 */
export const prepareAgentTools = (
  tools: Record<string, Tool>,
  skills: Array<Pick<Skill, "name" | "description">>,
  workspaceId: string,
): void => {
  // Inject loadSkill tool if skills exist
  if (skills.length > 0) {
    tools.loadSkill = createLoadSkillTool(workspaceId);
  }
};
