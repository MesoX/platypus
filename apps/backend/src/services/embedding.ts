import { embed } from "ai";
import type { Provider } from "@platypus/schemas";
import { openProvider } from "./provider.ts";

/**
 * Generates an embedding vector for the given text. Throws if the Provider
 * type does not support text embeddings (e.g. Anthropic).
 */
export const generateEmbedding = async (
  provider: Provider,
  embeddingModelId: string,
  text: string,
): Promise<number[]> => {
  const embeddingModel = openProvider(provider).embeddingModel;
  if (!embeddingModel) {
    throw new Error(
      `Provider type '${provider.providerType}' does not support text embeddings.`,
    );
  }
  const { embedding } = await embed({
    model: embeddingModel(embeddingModelId),
    value: text,
  });
  return embedding;
};
