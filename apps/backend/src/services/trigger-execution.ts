import { nanoid } from "nanoid";
import { and, desc, eq, notInArray, type Column } from "drizzle-orm";
import type { PgTable, PgColumn } from "drizzle-orm/pg-core";
import { generateText, stepCountIs, type LanguageModel } from "ai";
import { db } from "../index.ts";
import {
  trigger as triggerTable,
  triggerRun as triggerRunTable,
  agent as agentTable,
  workspace as workspaceTable,
  provider as providerTable,
} from "../db/schema.ts";
import {
  createModel,
  loadTools,
  resolveGenerationConfig,
  loadSkills,
  loadSubAgents,
  fetchUserContexts,
  fetchFormattedMemories,
  prepareAgentTools,
  createSearchTools,
} from "./chat-execution.ts";
import { logger } from "../logger.ts";
import { validateCronExpression } from "../utils/cron.ts";
import type {
  Provider,
  CronTriggerConfig,
  TriggerRunStats,
  WebhookEvent,
} from "@platypus/schemas";

/**
 * Retains the newest N rows for a given foreign key and deletes the rest.
 */
async function retainNewest(
  table: PgTable,
  fkColumn: PgColumn,
  idColumn: PgColumn,
  orderColumn: Column,
  fkValue: string,
  limit: number,
  label: string,
): Promise<void> {
  const toKeep = await db
    .select({ id: idColumn })
    .from(table)
    .where(eq(fkColumn, fkValue))
    .orderBy(desc(orderColumn))
    .limit(limit);

  if (toKeep.length < limit) return;

  const idsToKeep = toKeep.map((r) => r.id as string);
  const deleted = await db
    .delete(table)
    .where(and(eq(fkColumn, fkValue), notInArray(idColumn, idsToKeep)))
    .returning({ id: idColumn });

  if (deleted.length > 0) {
    logger.info(
      {
        triggerId: fkValue,
        deletedCount: deleted.length,
        maxRunsToKeep: limit,
      },
      `Cleaned up old ${label}`,
    );
  }
}

export type EventContext = {
  eventType: WebhookEvent;
  eventData: unknown;
};

/**
 * Executes a trigger by running the agent with the configured instruction.
 * For event triggers, event context is prepended to the instruction.
 * Returns the trigger run ID.
 */
export const executeTrigger = async (
  trigger: typeof triggerTable.$inferSelect,
  eventContext?: EventContext,
): Promise<string> => {
  const { id, workspaceId, agentId, instruction } = trigger;

  // Create a trigger run record (starts as "running" since execution begins immediately)
  const runId = nanoid();
  await db.insert(triggerRunTable).values({
    id: runId,
    triggerId: id,
    status: "running",
    eventType: eventContext?.eventType ?? null,
    eventData: eventContext?.eventData ?? null,
    startedAt: new Date(),
    createdAt: new Date(),
  });

  // Helper to update run status
  const updateRunStatus = async (
    status: "running" | "success" | "failed",
    data?: { errorMessage?: string; stats?: TriggerRunStats },
  ) => {
    await db
      .update(triggerRunTable)
      .set({
        status,
        errorMessage: data?.errorMessage ?? null,
        stats: data?.stats ?? null,
        completedAt:
          status === "success" || status === "failed" ? new Date() : null,
      })
      .where(eq(triggerRunTable.id, runId));
  };

  // 1. Fetch agent and workspace in parallel
  const [agentRecord, workspaceRecord] = await Promise.all([
    db.select().from(agentTable).where(eq(agentTable.id, agentId)).limit(1),
    db
      .select()
      .from(workspaceTable)
      .where(eq(workspaceTable.id, workspaceId))
      .limit(1),
  ]);

  if (agentRecord.length === 0) {
    const errorMsg = `Agent '${agentId}' not found for trigger '${id}'`;
    await updateRunStatus("failed", { errorMessage: errorMsg });
    throw new Error(errorMsg);
  }
  const agent = agentRecord[0];

  if (workspaceRecord.length === 0) {
    const errorMsg = `Workspace '${workspaceId}' not found for trigger '${id}'`;
    await updateRunStatus("failed", { errorMessage: errorMsg });
    throw new Error(errorMsg);
  }
  const workspace = workspaceRecord[0];

  // 2. Get provider from agent
  const providerRecord = await db
    .select()
    .from(providerTable)
    .where(eq(providerTable.id, agent.providerId))
    .limit(1);

  if (providerRecord.length === 0) {
    const errorMsg = `Provider '${agent.providerId}' not found for agent`;
    await updateRunStatus("failed", { errorMessage: errorMsg });
    throw new Error(errorMsg);
  }
  const provider = providerRecord[0];

  // 4. Create model
  const [aiProvider, model] = createModel(provider as Provider, agent.modelId);

  // 5. Load tools
  const orgId = workspace.organizationId;
  const frontendUrl = process.env.FRONTEND_URL;
  const { tools, mcpClients } = await loadTools(
    agent,
    workspaceId,
    orgId,
    frontendUrl,
  );

  // 5b. Configure Search (if enabled)
  if (trigger.search) {
    Object.assign(tools, createSearchTools(provider as Provider, aiProvider));
  }

  // 5c. Load sub-agents
  const { subAgents, subAgentTools } = await loadSubAgents(
    agent,
    orgId,
    workspaceId,
    frontendUrl,
  );
  Object.assign(tools, subAgentTools);

  // 6. Load skills
  const skills = await loadSkills(agent, workspaceId);

  // 7. Fetch user contexts (workspace owner is the "user" for triggered runs)
  const user = { id: workspace.ownerId, name: "Trigger User" };
  const { userGlobalContext, userWorkspaceContext } = await fetchUserContexts(
    workspace.ownerId,
    workspaceId,
  );

  // 8. Fetch memories
  const memoriesFormatted = await fetchFormattedMemories(
    workspace.ownerId,
    workspaceId,
  );

  // 9. Resolve generation config
  const config = await resolveGenerationConfig(
    {},
    workspaceId,
    agent,
    workspace.context || undefined,
    skills,
    user,
    userGlobalContext,
    userWorkspaceContext,
    subAgents,
    memoriesFormatted,
  );

  // 10. Prepare tools
  prepareAgentTools(tools, skills, workspaceId);

  // 11. Build the effective prompt
  let effectiveInstruction = instruction;
  if (eventContext) {
    effectiveInstruction = `Event: ${eventContext.eventType}\nEvent Data:\n${JSON.stringify(eventContext.eventData, null, 2)}\n---\n${instruction}`;
  }

  // 12. Execute agent with instruction
  const startTime = Date.now();

  try {
    logger.info(
      {
        triggerId: id,
        runId,
        agentId,
        type: trigger.type,
        instruction: effectiveInstruction.substring(0, 100) + "...",
      },
      "Starting trigger execution",
    );

    const result = await generateText({
      model: model as LanguageModel,
      prompt: effectiveInstruction,
      tools,
      system: config.systemPrompt,
      stopWhen: [stepCountIs(agent.maxSteps ?? 1)],
      ...Object.fromEntries(
        Object.entries({
          temperature: config.temperature,
          topP: config.topP,
          topK: config.topK,
          frequencyPenalty: config.frequencyPenalty,
          presencePenalty: config.presencePenalty,
        }).filter(([, v]) => v !== undefined),
      ),
    });

    const duration = Date.now() - startTime;

    // Extract execution stats from the result
    const toolCallCounts = new Map<string, number>();
    for (const step of result.steps) {
      for (const tc of step.toolCalls) {
        toolCallCounts.set(
          tc.toolName,
          (toolCallCounts.get(tc.toolName) ?? 0) + 1,
        );
      }
    }

    const stats: TriggerRunStats = {
      steps: result.steps.length,
      toolCalls: Array.from(toolCallCounts, ([name, count]) => ({
        name,
        count,
      })),
      inputTokens: result.totalUsage.inputTokens ?? 0,
      outputTokens: result.totalUsage.outputTokens ?? 0,
    };

    // Update run status to success with stats
    await updateRunStatus("success", { stats });

    logger.info(
      {
        triggerId: id,
        runId,
        duration,
        responseLength: result.text.length,
        stats,
      },
      "Trigger execution completed",
    );

    return runId;
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Unknown error";
    logger.error(
      {
        error,
        triggerId: id,
        runId,
        duration: Date.now() - startTime,
      },
      "Trigger execution failed",
    );

    // Update run status to failed
    await updateRunStatus("failed", { errorMessage });

    throw error;
  } finally {
    // Close MCP clients
    for (const mcpClient of mcpClients) {
      try {
        await mcpClient.close();
      } catch (error) {
        logger.error({ error }, "Error closing MCP client");
      }
    }
  }
};

/**
 * Updates the trigger after execution:
 * - Sets lastRunAt
 * - For cron: computes nextRunAt, handles one-off disable
 * - For event: just updates lastRunAt
 * - Performs retention cleanup
 */
export const updateTriggerAfterRun = async (
  triggerId: string,
  trigger: typeof triggerTable.$inferSelect,
): Promise<void> => {
  const now = new Date();
  const { maxRunsToKeep, type, config } = trigger;

  let nextRunAt: Date | null = null;
  let enabled = true;

  if (type === "cron") {
    const cronConfig = config as CronTriggerConfig;
    if (cronConfig.isOneOff) {
      // One-off triggers are disabled after first run
      enabled = false;
    } else {
      nextRunAt = validateCronExpression(
        cronConfig.cronExpression,
        cronConfig.timezone,
      );
      if (!nextRunAt) {
        logger.error(
          { triggerId, cronExpression: cronConfig.cronExpression },
          "Failed to compute next run for trigger",
        );
      }
    }
  }
  // For event triggers, nextRunAt stays null and enabled stays true

  // Update the trigger
  await db
    .update(triggerTable)
    .set({
      lastRunAt: now,
      nextRunAt,
      enabled,
      updatedAt: now,
    })
    .where(eq(triggerTable.id, triggerId));

  // Retention cleanup: delete old runs beyond maxRunsToKeep
  if (maxRunsToKeep > 0) {
    await retainNewest(
      triggerRunTable,
      triggerRunTable.triggerId,
      triggerRunTable.id,
      triggerRunTable.startedAt,
      triggerId,
      maxRunsToKeep,
      "trigger runs",
    );
  }

  logger.info(
    {
      triggerId,
      type,
      enabled,
      nextRunAt: nextRunAt?.toISOString(),
    },
    "Updated trigger after run",
  );
};
