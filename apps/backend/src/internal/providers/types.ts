import type { mcp } from "../../db/schema.ts";

export type McpRow = typeof mcp.$inferSelect;

export type UpstreamRequest = {
  url: string;
  headers: Record<string, string>;
};

export type RefreshedToken = {
  accessToken: string;
  expiresInSeconds?: number;
};

export interface ResourceProvider {
  readonly id: string;
  readonly resourceIdPattern: RegExp;
  buildUpstream(record: McpRow, resourceId: string): UpstreamRequest;
  refreshToken?(record: McpRow): Promise<RefreshedToken | null>;
}
