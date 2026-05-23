import type { mcp } from "../../db/schema.ts";

/**
 * Database row for an MCP integration. Carries OAuth credentials and
 * provider-specific configuration that the resource proxy uses to fetch
 * resources on behalf of the workspace.
 */
export type McpRow = typeof mcp.$inferSelect;

/**
 * Upstream request descriptor returned by a {@link ResourceProvider}.
 * The proxy executes this request and streams the response body back to
 * the caller. Token values live only inside `headers` and are never
 * exposed in logs or response bodies.
 */
export type UpstreamRequest = {
  url: string;
  headers: Record<string, string>;
};

/**
 * Refreshed OAuth token returned by a provider's {@link ResourceProvider.refreshToken}.
 * Optional `expiresInSeconds` lets the proxy compute a new
 * `oauthTokenExpiresAt` timestamp; if omitted, the token is treated as
 * non-expiring (the proxy will simply attempt to refresh again on the
 * next call if the upstream rejects it).
 */
export type RefreshedToken = {
  accessToken: string;
  expiresInSeconds?: number;
};

/**
 * Adapter that translates a stored MCP credential plus a caller-supplied
 * `resourceId` into a concrete upstream HTTP request. Each provider also
 * declares how to validate the `resourceId` and (optionally) how to
 * refresh an expired access token.
 *
 * Providers must not perform side effects beyond the network call the
 * proxy will execute on their behalf — no logging of token values, no
 * database writes (token persistence is handled by the proxy after a
 * successful refresh).
 */
export interface ResourceProvider {
  /**
   * Stable identifier matched against the `:provider` segment of the
   * proxy URL. Lowercase, hyphen-separated, e.g. "google-drive".
   */
  readonly id: string;

  /**
   * Regular expression the caller-supplied `resourceId` must match. The
   * proxy rejects requests whose `resourceId` does not match before
   * invoking the provider, preventing path/URL injection.
   */
  readonly resourceIdPattern: RegExp;

  /**
   * Construct the upstream request for a validated `resourceId`. The
   * `record.oauthAccessToken` is guaranteed non-null at this point.
   */
  buildUpstream(record: McpRow, resourceId: string): UpstreamRequest;

  /**
   * Optional: exchange the stored refresh token for a fresh access
   * token. Returning `null` signals that refresh is not possible (the
   * proxy will then respond 401 to the caller).
   *
   * If omitted, the proxy will not attempt a refresh and will pass the
   * existing access token through.
   */
  refreshToken?(record: McpRow): Promise<RefreshedToken | null>;
}
