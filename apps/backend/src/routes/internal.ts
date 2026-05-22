import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../index.ts";
import { mcp as mcpTable } from "../db/schema.ts";

/**
 * Internal routes — not for end users. Called by trusted services on the
 * same Docker network (e.g. shell-mcp, whisperx-mcp).
 *
 * Auth: INTERNAL_SECRET env var. Set it in the backend and pass the same
 * value to any service that needs to call these endpoints.
 * If INTERNAL_SECRET is not set the routes are disabled entirely.
 */
const internal = new Hono();

const INTERNAL_SECRET = process.env.INTERNAL_SECRET?.trim();

/** Middleware: reject all requests when no secret is configured, or when the
 *  provided secret doesn't match. */
internal.use("*", async (c, next) => {
  if (!INTERNAL_SECRET) {
    return c.json(
      { error: "Internal endpoints are disabled (INTERNAL_SECRET not set)" },
      503,
    );
  }
  const auth = c.req.header("Authorization") ?? "";
  if (auth !== `Bearer ${INTERNAL_SECRET}`) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  await next();
});

/**
 * Proxy a Google Drive file download using the workspace's stored OAuth token.
 *
 * The caller (e.g. shell-mcp running a curl command) passes:
 *   workspaceId  — identifies which workspace's Drive credentials to use
 *   mcpId        — the specific Drive MCP record (one workspace can have multiple)
 *   fileId       — Google Drive file ID
 *
 * The endpoint streams the raw file bytes back so the caller can pipe them
 * directly to disk or another service (e.g. WhisperX).
 */
internal.get(
  "/resources/drive/:workspaceId/:mcpId/:fileId",
  async (c) => {
    const { workspaceId, mcpId, fileId } = c.req.param();

    const rows = await db
      .select()
      .from(mcpTable)
      .where(and(eq(mcpTable.id, mcpId), eq(mcpTable.workspaceId, workspaceId)))
      .limit(1);

    const record = rows[0];
    if (!record) {
      return c.json({ error: "MCP not found" }, 404);
    }

    let accessToken = record.oauthAccessToken;
    if (!accessToken) {
      return c.json(
        { error: "Drive MCP has no OAuth token — authorize it in Platypus first" },
        401,
      );
    }

    // Proactively refresh if the token is expired and we have everything needed.
    if (
      record.oauthTokenExpiresAt &&
      record.oauthTokenExpiresAt <= new Date() &&
      record.oauthRefreshToken &&
      record.oauthClientId &&
      record.oauthClientSecret
    ) {
      const refreshed = await refreshOAuthToken(
        record.oauthRefreshToken,
        record.oauthClientId,
        record.oauthClientSecret,
      );
      if (refreshed) {
        accessToken = refreshed.access_token;
        await db
          .update(mcpTable)
          .set({
            oauthAccessToken: refreshed.access_token,
            oauthTokenExpiresAt: refreshed.expires_in
              ? new Date(Date.now() + refreshed.expires_in * 1000)
              : null,
            updatedAt: new Date(),
          })
          .where(eq(mcpTable.id, mcpId));
      }
    }

    const driveUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;
    const driveRes = await fetch(driveUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!driveRes.ok) {
      const detail = await driveRes.text();
      return c.json(
        { error: `Drive API returned ${driveRes.status}`, detail },
        driveRes.status as 400 | 401 | 403 | 404 | 500,
      );
    }

    const headers: Record<string, string> = {
      "Content-Type":
        driveRes.headers.get("Content-Type") ?? "application/octet-stream",
      "Content-Disposition": "attachment",
    };
    const contentLength = driveRes.headers.get("Content-Length");
    if (contentLength) headers["Content-Length"] = contentLength;

    return new Response(driveRes.body, { headers });
  },
);

/** Refresh a Google OAuth access token using the stored refresh token. */
async function refreshOAuthToken(
  refreshToken: string,
  clientId: string,
  clientSecret: string,
): Promise<{ access_token: string; expires_in?: number } | null> {
  try {
    const res = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    if (!res.ok) return null;
    return (await res.json()) as { access_token: string; expires_in?: number };
  } catch {
    return null;
  }
}

export { internal };
