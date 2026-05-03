import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockDb, dbMethods } = vi.hoisted(() => {
  const mock: any = {};
  const methods = [
    "select",
    "from",
    "where",
    "limit",
    "orderBy",
    "innerJoin",
    "insert",
    "values",
    "update",
    "set",
    "delete",
    "returning",
  ];
  methods.forEach((method) => {
    mock[method] = vi.fn().mockReturnValue(mock);
  });
  return { mockDb: mock, dbMethods: methods };
});

vi.mock("../index.ts", () => ({
  db: mockDb,
}));

vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual("drizzle-orm");
  return {
    ...actual,
    eq: vi.fn(),
    and: vi.fn((...args: unknown[]) => args.filter(Boolean)),
    asc: vi.fn(),
  };
});

import { createDashboardTools } from "./dashboard.ts";

const ctx = { toolCallId: "test", messages: [] };
const workspaceId = "ws-1";
const agentId = "agent-1";
const orgId = "org-1";
const frontendUrl = "http://localhost:3000";
const dashboardId = "dash-1";
const widgetId = "widget-1";

function resetDb() {
  dbMethods.forEach((method: string) => {
    mockDb[method] = vi.fn().mockReturnValue(mockDb);
  });
}

describe("createDashboardTools", () => {
  let tools: ReturnType<typeof createDashboardTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetDb();
    tools = createDashboardTools(workspaceId, agentId, orgId, frontendUrl);
  });

  it("returns the expected tool names", () => {
    expect(Object.keys(tools)).toEqual([
      "listDashboards",
      "listWidgets",
      "getWidget",
      "updateWidgetData",
    ]);
  });

  describe("listDashboards", () => {
    it("returns dashboards in workspace", async () => {
      const dashboards = [{ id: dashboardId, name: "Sales" }];
      mockDb.orderBy.mockResolvedValueOnce(dashboards);

      const result = await tools.listDashboards.execute({}, ctx);
      expect(result).toEqual(dashboards);
    });
  });

  describe("listWidgets", () => {
    it("returns error when dashboard not found", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      const result = await tools.listWidgets.execute({ dashboardId }, ctx);
      expect(result).toEqual({ error: "Dashboard not found" });
    });

    it("returns widgets for a dashboard", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: dashboardId, workspaceId }]);
      const widgets = [{ id: widgetId, dashboardId, type: "metric" }];
      mockDb.orderBy.mockResolvedValueOnce(widgets);

      const result = await tools.listWidgets.execute({ dashboardId }, ctx);
      expect(result).toEqual(widgets);
    });
  });

  describe("updateWidgetData", () => {
    it("returns error when dashboard not found", async () => {
      mockDb.limit.mockResolvedValueOnce([]);

      const result = await tools.updateWidgetData.execute(
        {
          dashboardId,
          widgetId,
          type: "metric",
          data: { value: 100, label: "Revenue" },
        },
        ctx,
      );
      expect(result).toEqual({ error: "Dashboard not found" });
    });

    it("returns error when widget not found", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: dashboardId, workspaceId }]);
      mockDb.limit.mockResolvedValueOnce([]);

      const result = await tools.updateWidgetData.execute(
        {
          dashboardId,
          widgetId,
          type: "metric",
          data: { value: 100, label: "Revenue" },
        },
        ctx,
      );
      expect(result).toEqual({ error: "Widget not found" });
    });

    it("returns error on widget type mismatch", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: dashboardId, workspaceId }]);
      mockDb.limit.mockResolvedValueOnce([
        { id: widgetId, dashboardId, type: "text" },
      ]);

      const result = await tools.updateWidgetData.execute(
        {
          dashboardId,
          widgetId,
          type: "metric",
          data: { value: 100, label: "Revenue" },
        },
        ctx,
      );
      expect(result).toEqual({ error: "Widget type mismatch" });
    });

    it("updates metric widget data", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: dashboardId, workspaceId }]);
      mockDb.limit.mockResolvedValueOnce([
        { id: widgetId, dashboardId, type: "metric" },
      ]);
      const updated = {
        id: widgetId,
        dashboardId,
        type: "metric",
        data: { value: 100, label: "Revenue" },
      };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const result = await tools.updateWidgetData.execute(
        {
          dashboardId,
          widgetId,
          type: "metric",
          data: { value: 100, label: "Revenue" },
        },
        ctx,
      );
      expect(result).toEqual(updated);
    });

    it("updates text widget data", async () => {
      mockDb.limit.mockResolvedValueOnce([{ id: dashboardId, workspaceId }]);
      mockDb.limit.mockResolvedValueOnce([
        { id: widgetId, dashboardId, type: "text" },
      ]);
      const updated = {
        id: widgetId,
        dashboardId,
        type: "text",
        data: { content: "# Status\nAll good" },
      };
      mockDb.returning.mockResolvedValueOnce([updated]);

      const result = await tools.updateWidgetData.execute(
        {
          dashboardId,
          widgetId,
          type: "text",
          data: { content: "# Status\nAll good" },
        },
        ctx,
      );
      expect(result).toEqual(updated);
    });
  });
});
