import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { createHash, timingSafeEqual } from "node:crypto";
import { db } from "../index.ts";
import { mcp as mcpTable } from "../db/schema.ts";
import { logger } from "../logger.ts";
import { getProvider } from "./providers/index.ts";
import type { McpRow } from "./providers/types.ts";

/**
 * Internal resource proxy.
 *
 * Trusted services on the same network (e.g. shell-mcp) call this
 * endpoint to fetch raw resource bytes from a workspace's external
 * integration (Google Drive today; Gmail, Dropbox etc. in the future).
 * The proxy uses the workspace's stored OAuth credentials, refreshes
 * them if expired, and streams the upstream response back to the
 * caller. Tokens never leave the backend.
 *
 * Auth: shared `INTERNAL_SECRET` env var (Bearer header). The endpoint
 * is disabled entirely when the secret is unset or shorter than the
 * minimum length below — there is no fallback.
 */

const MIN_SECRET_LENGTH = 32;

/**
 * Read and validate the configured `INTERNAL_SECRET` on every request.
 * Reading per-request (rather than caching at module load) keeps the
 * code robust to env changes during process lifetime and makes tests
 * trivial to set up — tests stub the env var without having to re-import
 * the module.
 */
function readSecretHash(): Buffer | null {
  const raw = process.env.INTERNAL_SECRET?.trim() ?? "";
  if (raw.length < MIN_SECRET_LENGTH) return null;
  return createHash("sha256").update(raw).digest();
}

function constantTimeMatch(presented: string, expected: Buffer): boolean {
  const candidate = createHash("sha256").update(presented).digest();
  return timingSafeEqual(candidate, expected);
}

const internal = new Hono();

internal.use("*", async (c, next) => {
  const expected = readSecretHash();
  if (!expected) {
    return c.json({ error: "Internal endpoints are disabled" }, 503);
  }
  const header = c.req.header("Authorization") ?? "";
  const presented = header.startsWith("Bearer ")
    ? header.slice("Bearer ".length)
    : "";
  if (!presented || !constantTimeMatch(presented, expected)) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

/**
 * Stream a resource from an external provider, on behalf of a workspace.
 *
 * Path params:
 *   provider     — provider id (e.g. "google-drive"); see {@link getProvider}
 *   workspaceId  — workspace that owns the integration
 *   mcpId        — specific MCP record (a workspace may have several)
 *   resourceId   — provider-specific identifier (e.g. Drive file ID)
 *
 * Cross-workspace fetches return 404 to avoid an existence oracle.
 */
internal.get(
  "/resources/:provider/:workspaceId/:mcpId/:resourceId",
  async (c) => {
    const startedAt = Date.now();
    const {
      provider: providerId,
      workspaceId,
      mcpId,
      resourceId,
    } = c.req.param();

    const provider = getProvider(providerId);
    if (!provider) {
      return c.json({ error: "Unknown provider" }, 400);
    }

    if (!provider.resourceIdPattern.test(resourceId)) {
      return c.json({ error: "Invalid resourceId" }, 400);
    }

    const rows = await db
      .select()
      .from(mcpTable)
      .where(and(eq(mcpTable.id, mcpId), eq(mcpTable.workspaceId, workspaceId)))
      .limit(1);

    const record = rows[0];
    if (!record) {
      return c.json({ error: "Resource not found" }, 404);
    }

    let workingRecord: McpRow = record;
    if (!workingRecord.oauthAccessToken) {
      return c.json(
        {
          error:
            "MCP has no OAuth token — authorize the integration in Platypus first",
        },
        401,
      );
    }

    if (
      workingRecord.oauthTokenExpiresAt &&
      workingRecord.oauthTokenExpiresAt <= new Date() &&
      provider.refreshToken
    ) {
      const refreshed = await provider.refreshToken(workingRecord);
      if (refreshed) {
        const newExpiresAt = refreshed.expiresInSeconds
          ? new Date(Date.now() + refreshed.expiresInSeconds * 1000)
          : null;
        workingRecord = {
          ...workingRecord,
          oauthAccessToken: refreshed.accessToken,
          oauthTokenExpiresAt: newExpiresAt,
        };
        await db
          .update(mcpTable)
          .set({
            oauthAccessToken: refreshed.accessToken,
            oauthTokenExpiresAt: newExpiresAt,
            updatedAt: new Date(),
          })
          .where(eq(mcpTable.id, mcpId));
      }
    }

    const upstream = provider.buildUpstream(workingRecord, resourceId);
    const upstreamRes = await fetch(upstream.url, {
      headers: upstream.headers,
    });

    const durationMs = Date.now() - startedAt;
    logger.info(
      {
        provider: provider.id,
        workspaceId,
        mcpId,
        resourceId,
        upstreamStatus: upstreamRes.status,
        durationMs,
      },
      "internal.proxy",
    );

    if (!upstreamRes.ok) {
      const detail = await upstreamRes.text();
      return c.json(
        { error: `Upstream returned ${upstreamRes.status}`, detail },
        upstreamRes.status as 400 | 401 | 403 | 404 | 500,
      );
    }

    const responseHeaders: Record<string, string> = {
      "Content-Type":
        upstreamRes.headers.get("Content-Type") ?? "application/octet-stream",
      "Content-Disposition": "attachment",
    };
    const contentLength = upstreamRes.headers.get("Content-Length");
    if (contentLength) responseHeaders["Content-Length"] = contentLength;

    return new Response(upstreamRes.body, { headers: responseHeaders });
  },
);

// Explicit 405 for non-GET methods on the resource route, so callers see
// the right status instead of Hono's default 404 for unmatched methods.
internal.on(
  ["POST", "PUT", "PATCH", "DELETE"],
  "/resources/:provider/:workspaceId/:mcpId/:resourceId",
  (c) => c.json({ error: "Method not allowed" }, 405),
);

export { internal };
