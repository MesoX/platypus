import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Hono } from "hono";
import { mockDb, resetMockDb } from "../test-utils.ts";

const VALID_SECRET = "x".repeat(40);

process.env.INTERNAL_SECRET = VALID_SECRET;

// Import the router directly to avoid pulling the full server.ts chain
// (which transitively loads optional sandbox/docker dependencies).
const { internal } = await import("./proxy.ts");
const app = new Hono();
app.route("/internal", internal);

const baseUrl = "/internal/resources/google-drive/ws-1/mcp-1/file-12345678";
const bearerHeader = { Authorization: `Bearer ${VALID_SECRET}` };

const validMcpRow = {
  id: "mcp-1",
  workspaceId: "ws-1",
  name: "Drive",
  url: null,
  headers: null,
  authType: "oauth",
  bearerToken: null,
  oauthAccessToken: "access-token",
  oauthRefreshToken: "refresh-token",
  oauthTokenExpiresAt: new Date(Date.now() + 3600_000),
  oauthScope: null,
  oauthRequestedScope: null,
  oauthClientId: "client",
  oauthClientSecret: "secret",
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("Internal resource proxy", () => {
  beforeEach(() => {
    resetMockDb();
    process.env.INTERNAL_SECRET = VALID_SECRET;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("authentication", () => {
    it("returns 503 when INTERNAL_SECRET is unset", async () => {
      delete process.env.INTERNAL_SECRET;
      const res = await app.request(baseUrl, { headers: bearerHeader });
      expect(res.status).toBe(503);
    });

    it("returns 503 when INTERNAL_SECRET is too short", async () => {
      process.env.INTERNAL_SECRET = "too-short";
      const res = await app.request(baseUrl, { headers: bearerHeader });
      expect(res.status).toBe(503);
    });

    it("returns 401 when Authorization header is missing", async () => {
      const res = await app.request(baseUrl);
      expect(res.status).toBe(401);
    });

    it("returns 401 when Authorization header does not start with Bearer", async () => {
      const res = await app.request(baseUrl, {
        headers: { Authorization: VALID_SECRET },
      });
      expect(res.status).toBe(401);
    });

    it("returns 401 when the presented secret does not match", async () => {
      const res = await app.request(baseUrl, {
        headers: { Authorization: `Bearer ${"y".repeat(40)}` },
      });
      expect(res.status).toBe(401);
    });
  });

  describe("provider validation", () => {
    it("returns 400 for an unknown provider id", async () => {
      const res = await app.request(
        "/internal/resources/unknown-provider/ws-1/mcp-1/file-12345678",
        { headers: bearerHeader },
      );
      expect(res.status).toBe(400);
    });

    it("returns 400 when resourceId fails the provider pattern", async () => {
      const res = await app.request(
        "/internal/resources/google-drive/ws-1/mcp-1/has spaces",
        { headers: bearerHeader },
      );
      expect(res.status).toBe(400);
    });
  });

  describe("scope enforcement", () => {
    it("returns 404 when the MCP record is not found", async () => {
      mockDb.limit.mockResolvedValueOnce([]);
      const res = await app.request(baseUrl, { headers: bearerHeader });
      expect(res.status).toBe(404);
    });

    it("returns 401 when the record exists but has no access token", async () => {
      mockDb.limit.mockResolvedValueOnce([
        { ...validMcpRow, oauthAccessToken: null },
      ]);
      const res = await app.request(baseUrl, { headers: bearerHeader });
      expect(res.status).toBe(401);
    });
  });

  describe("happy path", () => {
    it("streams upstream bytes back with content-type", async () => {
      mockDb.limit.mockResolvedValueOnce([validMcpRow]);
      const upstreamBody = "audio-bytes-here";
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response(upstreamBody, {
          status: 200,
          headers: { "Content-Type": "audio/wav" },
        }) as Response,
      );

      const res = await app.request(baseUrl, { headers: bearerHeader });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toBe("audio/wav");
      expect(res.headers.get("Content-Disposition")).toBe("attachment");
      const text = await res.text();
      expect(text).toBe(upstreamBody);
    });

    it("includes the Bearer access token in the upstream request", async () => {
      mockDb.limit.mockResolvedValueOnce([validMcpRow]);
      const spy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(new Response("ok") as Response);

      await app.request(baseUrl, { headers: bearerHeader });
      const [, init] = spy.mock.calls[0]!;
      expect((init?.headers as Record<string, string>)["Authorization"]).toBe(
        `Bearer ${validMcpRow.oauthAccessToken}`,
      );
    });

    it("does not echo the INTERNAL_SECRET in the response body", async () => {
      mockDb.limit.mockResolvedValueOnce([validMcpRow]);
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("payload", { status: 200 }) as Response,
      );
      const res = await app.request(baseUrl, { headers: bearerHeader });
      const text = await res.text();
      expect(text).not.toContain(VALID_SECRET);
    });
  });

  describe("token refresh", () => {
    it("refreshes the token and uses the new value upstream when expired", async () => {
      mockDb.limit.mockResolvedValueOnce([
        {
          ...validMcpRow,
          oauthTokenExpiresAt: new Date(Date.now() - 60_000),
        },
      ]);

      const fetchSpy = vi.spyOn(globalThis, "fetch");
      // 1st call: token refresh
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "new-token", expires_in: 3600 }),
          { status: 200 },
        ) as Response,
      );
      // 2nd call: upstream resource fetch
      fetchSpy.mockResolvedValueOnce(
        new Response("ok", { status: 200 }) as Response,
      );

      const res = await app.request(baseUrl, { headers: bearerHeader });
      expect(res.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const upstreamInit = fetchSpy.mock.calls[1]![1];
      expect(
        (upstreamInit?.headers as Record<string, string>)["Authorization"],
      ).toBe("Bearer new-token");
    });
  });

  describe("upstream error pass-through", () => {
    it("returns the upstream status when the resource fetch fails", async () => {
      mockDb.limit.mockResolvedValueOnce([validMcpRow]);
      vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
        new Response("not found", { status: 404 }) as Response,
      );

      const res = await app.request(baseUrl, { headers: bearerHeader });
      expect(res.status).toBe(404);
    });
  });

  describe("method allowlist", () => {
    it("returns 405 for POST on the resource route", async () => {
      const res = await app.request(baseUrl, {
        method: "POST",
        headers: bearerHeader,
      });
      expect(res.status).toBe(405);
    });
  });
});
