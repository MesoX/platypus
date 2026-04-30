import { Hono } from "hono";
import { sValidator } from "@hono/standard-validator";
import { z } from "zod";
import {
  convertToModelMessages,
  createIdGenerator,
  generateText,
  Output,
  streamText,
  APICallError,
  LoadAPIKeyError,
} from "ai";
import { stepCountIs } from "ai";
import { db } from "../index.ts";
import { dedupeArray, toKebabCase } from "../utils.ts";
import {
  chat as chatTable,
  provider as providerTable,
  workspace as workspaceTable,
} from "../db/schema.ts";
import {
  prepareChatTurn,
  NotFoundError,
  ValidationError,
  type ChatTurn,
} from "../services/chat-execution.ts";
import { openProvider } from "../services/provider.ts";
import {
  chatGenerateMetadataSchema,
  chatSubmitSchema,
  chatUpdateSchema,
  type ChatSubmitData,
  type Provider,
} from "@platypus/schemas";
import { and, count, desc, eq, or, sql } from "drizzle-orm";
import { requireAuth } from "../middleware/authentication.ts";
import {
  requireOrgAccess,
  requireWorkspaceAccess,
  requireWorkspaceOwner,
} from "../middleware/authorization.ts";
import type { Variables } from "../server.ts";
import { logger } from "../logger.ts";
import { type PlatypusUIMessage } from "../types.ts";
import {
  extractFiles,
  rewriteStorageUrls,
  deleteFiles,
} from "../storage/utils.ts";
import { getOrigin } from "../utils/get-origin.ts";

/**
 * Upserts the chat record in the database.
 */
const upsertChatRecord = async (
  id: string,
  orgId: string,
  workspaceId: string,
  messages: PlatypusUIMessage[],
  resolved: ChatTurn["resolved"],
  data: ChatSubmitData,
) => {
  const { agentId } = resolved;

  // Extract files from messages and store them
  const processedMessages = await extractFiles(messages, {
    orgId,
    workspaceId,
    chatId: id,
  });

  const dbValues = {
    messages: processedMessages,
    agentId: agentId ?? null,
    providerId: agentId ? null : resolved.providerId,
    modelId: agentId ? null : resolved.modelId,
    systemPrompt: resolved.systemPrompt ?? null,
    temperature: resolved.temperature ?? null,
    topP: resolved.topP ?? null,
    topK: resolved.topK ?? null,
    seed: resolved.seed ?? data.seed ?? null,
    presencePenalty: resolved.presencePenalty ?? null,
    frequencyPenalty: resolved.frequencyPenalty ?? null,
    updatedAt: new Date(),
  };

  try {
    const updateResult = await db
      .update(chatTable)
      .set(dbValues)
      .where(and(eq(chatTable.id, id), eq(chatTable.workspaceId, workspaceId)))
      .returning();

    if (updateResult.length === 0) {
      await db.insert(chatTable).values({
        id,
        workspaceId,
        title: "Untitled",
        createdAt: new Date(),
        ...dbValues,
      });
    }

    logger.info(
      `Successfully upserted chat '${id}' in workspace '${workspaceId}'`,
    );
  } catch (error) {
    logger.error(
      { error, chatId: id, workspaceId },
      "Error upserting chat record",
    );
  }
};

// --- Routes ---

const chat = new Hono<{ Variables: Variables }>();

chat.get(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator(
    "query",
    z.object({
      limit: z.string().optional(),
      offset: z.string().optional(),
      search: z.string().optional(),
    }),
  ),
  async (c) => {
    const workspaceId = c.req.param("workspaceId")!;
    const { limit: limitStr, offset: offsetStr, search } = c.req.valid("query");

    const limit = Math.min(parseInt(limitStr ?? "100") || 100, 100);
    const offset = parseInt(offsetStr ?? "0") || 0;

    // Build search filter using ILIKE on title and tags
    const searchFilter =
      search && search.trim() !== ""
        ? or(
            sql`${chatTable.title} ILIKE ${"%" + search.trim() + "%"}`,
            sql`EXISTS (SELECT 1 FROM jsonb_array_elements_text(${chatTable.tags}) AS t WHERE t ILIKE ${"%" + search.trim() + "%"})`,
          )
        : undefined;

    const whereClause = and(
      eq(chatTable.workspaceId, workspaceId),
      searchFilter,
    );

    const records = await db
      .select({
        id: chatTable.id,
        title: chatTable.title,
        isPinned: chatTable.isPinned,
        tags: chatTable.tags,
        agentId: chatTable.agentId,
        providerId: chatTable.providerId,
        modelId: chatTable.modelId,
        createdAt: chatTable.createdAt,
        updatedAt: chatTable.updatedAt,
      })
      .from(chatTable)
      .where(whereClause)
      .orderBy(desc(chatTable.createdAt))
      .limit(limit)
      .offset(offset);

    const [{ totalCount }] = await db
      .select({ totalCount: count() })
      .from(chatTable)
      .where(whereClause);

    return c.json({ results: records, totalCount });
  },
);

chat.get(
  "/:chatId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  async (c) => {
    const chatId = c.req.param("chatId");
    const workspaceId = c.req.param("workspaceId")!;

    const record = await db
      .select()
      .from(chatTable)
      .where(
        and(eq(chatTable.id, chatId), eq(chatTable.workspaceId, workspaceId)),
      )
      .limit(1);
    if (record.length === 0) {
      return c.json({ error: "Chat not found" }, 404);
    }

    // Rewrite storage:// URLs to HTTP URLs
    const chat = record[0];
    const origin = getOrigin(c);
    if (chat.messages) {
      chat.messages = rewriteStorageUrls(
        chat.messages as PlatypusUIMessage[],
        origin,
      );
    }

    return c.json(chat);
  },
);

chat.post(
  "/",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  sValidator("json", chatSubmitSchema),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const workspaceId = c.req.param("workspaceId")!;
    const data = c.req.valid("json");
    const { messages = [] } = data;
    const user = c.get("user")!;

    let turn: ChatTurn;
    try {
      turn = await prepareChatTurn({
        orgId,
        workspaceId,
        user: { id: user.id, name: user.name },
        request: data,
        messages,
        origin: getOrigin(c),
        frontendUrl: process.env.FRONTEND_URL,
      });
    } catch (error) {
      if (error instanceof ValidationError) {
        return c.json({ message: error.message }, 400);
      }
      if (error instanceof NotFoundError) {
        return c.json({ message: error.message }, 404);
      }
      throw error;
    }

    c.req.raw.signal.addEventListener("abort", () => {
      void turn.dispose();
    });

    logger.debug(
      { systemPrompt: turn.stream.system },
      "System prompt for chat",
    );

    const result = streamText({
      model: turn.stream.model as any,
      messages: await convertToModelMessages(turn.stream.messages),
      stopWhen: [stepCountIs(turn.stream.maxSteps)],
      tools: turn.stream.tools,
      system: turn.stream.system,
      abortSignal: c.req.raw.signal,
      temperature: turn.stream.temperature,
      topP: turn.stream.topP,
      topK: turn.stream.topK,
      frequencyPenalty: turn.stream.frequencyPenalty,
      presencePenalty: turn.stream.presencePenalty,
      seed: turn.stream.seed,
    });

    return result.toUIMessageStreamResponse<PlatypusUIMessage>({
      originalMessages: messages,
      generateMessageId: createIdGenerator({
        prefix: "msg",
        size: 16,
      }),
      messageMetadata: () =>
        turn.resolved.agentId ? { agentId: turn.resolved.agentId } : undefined,
      onError: (error) => {
        logger.error({ error }, "Chat stream error");
        if (LoadAPIKeyError.isInstance(error)) {
          return "AI provider API key is missing or not configured.";
        }
        if (APICallError.isInstance(error)) {
          if (error.statusCode === 401 || error.statusCode === 403) {
            return "AI provider authentication failed. Your API key may be invalid or expired.";
          }
          if (error.statusCode === 429) {
            return "AI provider rate limit exceeded. Please try again later.";
          }
          if (error.statusCode != null && error.statusCode >= 500) {
            return "AI provider is currently unavailable. Please try again later.";
          }
          return `AI provider error: ${error.message}`;
        }
        if (error instanceof Error) {
          return error.message;
        }
        return "An unexpected error occurred.";
      },
      onFinish: async ({ messages: finalMessages }) => {
        try {
          await turn.dispose();
          await upsertChatRecord(
            data.id,
            orgId,
            workspaceId,
            finalMessages,
            turn.resolved,
            data,
          );
        } catch (error) {
          logger.error({ error }, "Error in onFinish");
        }
      },
    });
  },
);

chat.delete(
  "/:chatId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  async (c) => {
    const chatId = c.req.param("chatId");
    const workspaceId = c.req.param("workspaceId")!;

    // First fetch the chat to get its messages for file cleanup
    const chatRecord = await db
      .select()
      .from(chatTable)
      .where(
        and(eq(chatTable.id, chatId), eq(chatTable.workspaceId, workspaceId)),
      )
      .limit(1);

    if (chatRecord.length === 0) {
      return c.json({ error: "Chat not found" }, 404);
    }

    // Delete associated files from storage (best-effort)
    if (chatRecord[0].messages) {
      await deleteFiles(chatRecord[0].messages as PlatypusUIMessage[]);
    }

    // Delete the chat record
    await db
      .delete(chatTable)
      .where(
        and(eq(chatTable.id, chatId), eq(chatTable.workspaceId, workspaceId)),
      );

    return c.json({ message: "Chat deleted successfully" }, 200);
  },
);

chat.put(
  "/:chatId",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  requireWorkspaceOwner,
  sValidator("json", chatUpdateSchema),
  async (c) => {
    const chatId = c.req.param("chatId");
    const workspaceId = c.req.param("workspaceId")!;
    const { title, isPinned, tags } = c.req.valid("json");

    const result = await db
      .update(chatTable)
      .set({ title, isPinned, tags, updatedAt: new Date() })
      .where(
        and(eq(chatTable.id, chatId), eq(chatTable.workspaceId, workspaceId)),
      )
      .returning();

    if (result.length === 0) {
      return c.json({ error: "Chat not found" }, 404);
    }

    return c.json(result[0]);
  },
);

chat.post(
  "/:chatId/generate-metadata",
  requireAuth,
  requireOrgAccess(),
  requireWorkspaceAccess,
  sValidator("json", chatGenerateMetadataSchema),
  async (c) => {
    const orgId = c.req.param("orgId")!;
    const chatId = c.req.param("chatId");
    const workspaceId = c.req.param("workspaceId")!;
    const { providerId } = c.req.valid("json");

    // Fetch chat record
    const chatRecord = await db
      .select()
      .from(chatTable)
      .where(
        and(eq(chatTable.id, chatId), eq(chatTable.workspaceId, workspaceId)),
      )
      .limit(1);
    if (chatRecord.length === 0) {
      return c.json({ error: "Chat not found" }, 404);
    }
    const chat = chatRecord[0];

    // Fetch workspace to check for task model provider override
    const workspaceRecord = await db
      .select()
      .from(workspaceTable)
      .where(eq(workspaceTable.id, workspaceId))
      .limit(1);

    if (workspaceRecord.length === 0) {
      return c.json({ error: "Workspace not found" }, 404);
    }
    const workspace = workspaceRecord[0];

    // Use workspace task model provider if set, otherwise use request providerId
    const effectiveProviderId = workspace.taskModelProviderId || providerId;

    // Fetch provider record
    const providerRecord = await db
      .select()
      .from(providerTable)
      .where(
        and(
          eq(providerTable.id, effectiveProviderId),
          or(
            eq(providerTable.workspaceId, workspaceId),
            eq(providerTable.organizationId, orgId),
          ),
        ),
      )
      .limit(1);

    if (providerRecord.length === 0) {
      return c.json({ error: "Provider not found" }, 404);
    }
    const provider = providerRecord[0] as Provider;

    // Fetch existing tags from all chats in the workspace
    const existingTagsResult = await db.execute(sql`
      SELECT DISTINCT value as tag
      FROM ${chatTable}, jsonb_array_elements_text(${chatTable.tags})
      WHERE ${chatTable.workspaceId} = ${workspaceId}
    `);
    const existingTags = existingTagsResult.rows.map(
      (row) => row.tag as string,
    );

    // Instantiate model
    const model = openProvider(provider).languageModel(provider.taskModelId);

    // Generate title
    const messages = (chat.messages as PlatypusUIMessage[]) || [];
    const conversationText = messages
      .map((m) => {
        const message = m.parts.map((p) => {
          if (p.type === "text") return p.text;
          return "";
        });
        return `${m.role}:\n${message.join("")}`;
      })
      .join("\n");

    const promptParts = [
      `Generate a short, descriptive title for this chat conversation. You MAY use at most one emoji. The complete title MUST NOT exceed 30 characters.`,
      `Also generate between 1 and 5 kebab-case tags relevant to the chat.`,
      `Each tag should ideally be a single word but no more than two words.`,
      `IMPORTANT: Avoid ambiguous words that lack context when viewed alone. For example, prefer "web-browser" over "chrome", "metal-finish" over "chrome", "programming-language" over "python", or "file-format" over "pdf". Tags should be descriptive enough to be understood without seeing the conversation.`,
    ];

    // Add existing tags context if available
    if (existingTags.length > 0) {
      promptParts.push(
        `Existing tags in this workspace: ${existingTags.join(", ")}`,
      );
      promptParts.push(
        `Prefer using tags from the existing list when they accurately describe the conversation. Only create new tags if none of the existing tags are applicable.`,
      );
    }

    promptParts.push(`Conversation:\n${conversationText}`);

    const { output } = await generateText({
      model: model as any,
      output: Output.object({
        schema: z.object({
          title: z.string(),
          tags: z.array(z.string()),
        }),
      }),
      prompt: promptParts.join("\n"),
    });

    let newTitle = output.title;
    // Truncate the title if it exceeds 30 characters. This is needed as some
    // models don't respect the limit mentioned in the above prompt :\
    if (newTitle.length > 30) {
      newTitle = newTitle.slice(0, 29) + "…";
    }

    // Enforce kebab-case tags and dedupe
    const newTags = dedupeArray(output.tags.map(toKebabCase));

    // Update chat title and tags
    const updateResult = await db
      .update(chatTable)
      .set({ title: newTitle, tags: newTags, updatedAt: new Date() })
      .where(
        and(eq(chatTable.id, chatId), eq(chatTable.workspaceId, workspaceId)),
      )
      .returning();

    return c.json(updateResult[0]);
  },
);

export { chat };
