import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockDb, mockSession, resetMockDb } from "../test-utils.ts";

vi.mock("../services/inbound-trigger.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../services/inbound-trigger.ts")>()),
  listOrgInboundTriggers: vi.fn(),
  revokeInboundTriggerToken: vi.fn(),
}));

import app from "../server.ts";
import {
  listOrgInboundTriggers,
  revokeInboundTriggerToken,
} from "../services/inbound-trigger.ts";

const baseUrl = "/organizations/org-1/inbound-triggers";

const asRole = (role: "admin" | "member") => {
  mockSession();
  mockDb.limit.mockResolvedValueOnce([{ role }]); // requireOrgAccess
};

describe("Org Inbound Trigger Routes", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    mockDb.where.mockReturnValue(mockDb);
  });

  it("lists the Organization's Inbound Triggers for an Org Admin", async () => {
    asRole("admin");
    vi.mocked(listOrgInboundTriggers).mockResolvedValueOnce([]);

    const res = await app.request(baseUrl);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ results: [] });
    expect(listOrgInboundTriggers).toHaveBeenCalledWith("org-1");
  });

  it("revokes a token for an Org Admin", async () => {
    asRole("admin");
    vi.mocked(revokeInboundTriggerToken).mockResolvedValueOnce(true);

    const res = await app.request(`${baseUrl}/trig-1/token`, {
      method: "DELETE",
    });

    expect(res.status).toBe(200);
    expect(revokeInboundTriggerToken).toHaveBeenCalledWith("org-1", "trig-1");
  });

  it("404s a revoke of a Trigger not in the Organization", async () => {
    asRole("admin");
    vi.mocked(revokeInboundTriggerToken).mockResolvedValueOnce(false);

    const res = await app.request(`${baseUrl}/trig-x/token`, {
      method: "DELETE",
    });

    expect(res.status).toBe(404);
  });

  it.each([
    ["GET", baseUrl],
    ["DELETE", `${baseUrl}/trig-1/token`],
  ])("refuses %s to a member who is not an Org Admin", async (method, url) => {
    asRole("member");

    const res = await app.request(url, { method });

    expect(res.status).toBe(403);
    expect(listOrgInboundTriggers).not.toHaveBeenCalled();
    expect(revokeInboundTriggerToken).not.toHaveBeenCalled();
  });
});
