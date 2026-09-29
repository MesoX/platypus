import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { resetMockDb, seedDb, type Row } from "../test-utils.ts";
import { mockLogger, mockNanoid } from "../test-setup.ts";

vi.mock("./trigger-firing.ts", () => ({
  fireTrigger: vi.fn(() => Promise.resolve("ran")),
}));
vi.mock("./notification.ts", () => ({
  createNotification: vi.fn(() => Promise.resolve({ id: "notification-1" })),
}));

import { fireTrigger } from "./trigger-firing.ts";
import { createNotification } from "./notification.ts";
import { hashInboundToken } from "./inbound-trigger-token.ts";
import {
  acceptInboundCall,
  activeInboundRunCount,
  authenticateInboundCall,
  bearerToken,
  dueReminder,
  inboundTokenStatus,
  listOrgInboundTriggers,
  logInboundCall,
  resetInboundRunSlots,
  resetInboundTouches,
  revokeInboundTriggerToken,
  sendInboundTokenReminders,
  touchInboundTrigger,
  validateInboundBody,
  type InboundTarget,
} from "./inbound-trigger.ts";
import type { InboundTriggerConfig } from "@platypus/schemas";

const NOW = new Date("2026-09-29T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const TOKEN = "pit_the-right-token";

const config: InboundTriggerConfig = {
  inputs: [
    { name: "issueKey", required: true, description: "The issue key" },
    { name: "note", required: false },
  ],
  recordKey: "issueKey",
  tokenExpiryDays: 90,
};

const inboundTrigger = (over: Row = {}): Row => ({
  id: "trig-1",
  workspaceId: "ws-1",
  agentId: "agent-1",
  type: "inbound",
  name: "Ready for AI",
  instruction: "Work the issue",
  enabled: true,
  maxRunsToKeep: 10,
  config,
  tokenHash: hashInboundToken(TOKEN),
  tokenCreatedAt: new Date(NOW.getTime() - 10 * DAY),
  tokenExpiresAt: new Date(NOW.getTime() + 80 * DAY),
  tokenNotice: null,
  lastUsedAt: null,
  lastRejectedAt: null,
  createdAt: new Date(NOW.getTime() - 10 * DAY),
  ...over,
});

const seed = ({
  trigger = [inboundTrigger()],
  gate = "all",
  allowed = false,
  runs = [],
}: {
  trigger?: Row[];
  gate?: string;
  allowed?: boolean;
  runs?: Row[];
} = {}) =>
  seedDb({
    trigger,
    workspace: [
      {
        id: "ws-1",
        organizationId: "org-1",
        ownerId: "user-1",
        name: "Support",
        inboundTriggersAllowed: allowed,
      },
    ],
    organization: [{ id: "org-1", name: "Acme", inboundTriggerGate: gate }],
    user: [{ id: "user-1", name: "Owner" }],
    trigger_run: runs,
  });

const target = (over: Row = {}): InboundTarget => ({
  trigger: inboundTrigger(over) as InboundTarget["trigger"],
  organizationId: "org-1",
  workspaceId: "ws-1",
  gate: "all",
  workspaceAllowed: false,
});

const settings = { maxConcurrentRuns: 5, maxBodyBytes: 65536 };

describe("inbound triggers", () => {
  beforeEach(() => {
    resetMockDb();
    vi.clearAllMocks();
    resetInboundRunSlots();
    resetInboundTouches();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("bearerToken", () => {
    it("reads only an Authorization: Bearer header", () => {
      expect(bearerToken(`Bearer ${TOKEN}`)).toBe(TOKEN);
      expect(bearerToken(`bearer ${TOKEN}`)).toBe(TOKEN);
      expect(bearerToken(TOKEN)).toBeNull();
      expect(bearerToken(`Basic ${TOKEN}`)).toBeNull();
      expect(bearerToken(undefined)).toBeNull();
    });
  });

  describe("authenticateInboundCall", () => {
    const reasonFor = async (header: string | undefined, id = "trig-1") => {
      const result = await authenticateInboundCall(id, header);
      return result.ok ? "ok" : result.reason;
    };

    it("admits the right token on an enabled Trigger behind an open gate", async () => {
      seed();
      const result = await authenticateInboundCall("trig-1", `Bearer ${TOKEN}`);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.config.recordKey).toBe("issueKey");
        expect(result.target.organizationId).toBe("org-1");
      }
    });

    it("names why each refused call was refused", async () => {
      seed();
      expect(await reasonFor(`Bearer ${TOKEN}`, "nope")).toBe(
        "unknown_trigger",
      );
      expect(await reasonFor(undefined)).toBe("missing_token");
      expect(await reasonFor("Bearer pit_wrong")).toBe("bad_token");
    });

    it("refuses a Trigger of another type before looking at the token", async () => {
      seed({ trigger: [inboundTrigger({ type: "cron", tokenHash: null })] });
      expect(await reasonFor(`Bearer ${TOKEN}`)).toBe("not_inbound");
    });

    it("refuses a revoked token as a bad one", async () => {
      seed({ trigger: [inboundTrigger({ tokenHash: null })] });
      expect(await reasonFor(`Bearer ${TOKEN}`)).toBe("bad_token");
    });

    it("checks the token before `enabled`, so only its holder learns the Trigger is off", async () => {
      seed({ trigger: [inboundTrigger({ enabled: false })] });
      expect(await reasonFor("Bearer pit_wrong")).toBe("bad_token");
      expect(await reasonFor(`Bearer ${TOKEN}`)).toBe("disabled");
    });

    it("applies the Organization gate on every call", async () => {
      seed({ gate: "off" });
      expect(await reasonFor(`Bearer ${TOKEN}`)).toBe("gate");

      seed({ gate: "selected", allowed: false });
      expect(await reasonFor(`Bearer ${TOKEN}`)).toBe("gate");

      seed({ gate: "selected", allowed: true });
      expect(await reasonFor(`Bearer ${TOKEN}`)).toBe("ok");
    });

    it("tells the Owner the first time an expired token is used, and only then", async () => {
      const fake = seed({
        trigger: [
          inboundTrigger({ tokenExpiresAt: new Date(NOW.getTime() - 1) }),
        ],
      });

      expect(await reasonFor(`Bearer ${TOKEN}`)).toBe("expired_token");
      expect(await reasonFor(`Bearer ${TOKEN}`)).toBe("expired_token");

      expect(createNotification).toHaveBeenCalledTimes(1);
      expect(createNotification).toHaveBeenCalledWith(
        expect.anything(),
        { orgId: "org-1", workspaceId: "ws-1", agentId: "agent-1" },
        expect.objectContaining({ title: "Inbound trigger token has expired" }),
      );
      expect(fake.tables.trigger[0].tokenNotice).toBe("expired");
    });

    it("does not re-send the expired notice after its Notification is deleted", async () => {
      seed({
        trigger: [
          inboundTrigger({
            tokenExpiresAt: new Date(NOW.getTime() - 1),
            tokenNotice: "expired",
          }),
        ],
      });
      expect(await reasonFor(`Bearer ${TOKEN}`)).toBe("expired_token");
      expect(createNotification).not.toHaveBeenCalled();
    });
  });

  describe("validateInboundBody", () => {
    const declared = config.inputs;

    it("accepts declared string inputs, and an empty body when nothing is required", () => {
      expect(
        validateInboundBody({ inputs: { issueKey: "PLAT-42" } }, declared),
      ).toEqual({ ok: true, inputs: { issueKey: "PLAT-42" } });
      expect(validateInboundBody(undefined, [])).toEqual({
        ok: true,
        inputs: {},
      });
      expect(validateInboundBody({}, [])).toEqual({ ok: true, inputs: {} });
    });

    it.each([
      [{ inputs: {} }, "Required input 'issueKey' is missing."],
      [
        { inputs: { issueKey: "A", extra: "x" } },
        "Input 'extra' is not declared.",
      ],
      [{ inputs: { issueKey: 42 } }, "Input 'issueKey' must be a string."],
      [{ inputs: { issueKey: null } }, "Input 'issueKey' must be a string."],
      [{ inputs: ["PLAT-42"] }, "'inputs' must be a JSON object."],
      [["PLAT-42"], "The request body must be a JSON object."],
      [
        { issueKey: "PLAT-42" },
        `Unexpected field 'issueKey'. The body is { "inputs": { ... } }.`,
      ],
    ])("refuses %j without coercing it", (body, message) => {
      expect(validateInboundBody(body, declared)).toEqual({
        ok: false,
        message,
      });
    });
  });

  describe("acceptInboundCall", () => {
    it("writes the run row as pending before firing it, under the record key's value", async () => {
      mockNanoid.mockReturnValueOnce("run-1");
      const fake = seed();

      const result = await acceptInboundCall(
        target(),
        config,
        { issueKey: "PLAT-42" },
        settings,
      );

      expect(result).toEqual({ outcome: "accepted", runId: "run-1" });
      expect(fake.tables.trigger_run).toEqual([
        expect.objectContaining({
          id: "run-1",
          triggerId: "trig-1",
          status: "pending",
          entityId: "PLAT-42",
          eventType: null,
          eventData: { inputs: { issueKey: "PLAT-42" } },
        }),
      ]);
      expect(fireTrigger).toHaveBeenCalledWith(
        expect.objectContaining({ id: "trig-1" }),
        {
          kind: "inbound",
          runId: "run-1",
          inputs: { issueKey: "PLAT-42" },
          declared: config.inputs,
          entityId: "PLAT-42",
        },
      );
    });

    it("serialises calls for one record under an advisory lock", async () => {
      const fake = seed();
      await acceptInboundCall(target(), config, { issueKey: "A" }, settings);
      expect(fake.execute).toHaveBeenCalledTimes(1);
    });

    it("returns the active run for a record that has one, and starts nothing", async () => {
      const fake = seed({
        runs: [
          {
            id: "run-active",
            triggerId: "trig-1",
            entityId: "PLAT-42",
            status: "running",
            startedAt: NOW,
          },
        ],
      });

      const result = await acceptInboundCall(
        target(),
        config,
        { issueKey: "PLAT-42", note: "dropped" },
        settings,
      );

      expect(result).toEqual({ outcome: "deduplicated", runId: "run-active" });
      expect(fake.tables.trigger_run).toHaveLength(1);
      expect(fireTrigger).not.toHaveBeenCalled();
      expect(activeInboundRunCount()).toBe(0);
    });

    it("does not deduplicate against a finished run, or another record's", async () => {
      seed({
        runs: [
          {
            id: "run-done",
            triggerId: "trig-1",
            entityId: "PLAT-42",
            status: "success",
            startedAt: NOW,
          },
          {
            id: "run-other",
            triggerId: "trig-1",
            entityId: "PLAT-7",
            status: "pending",
            startedAt: NOW,
          },
        ],
      });
      mockNanoid.mockReturnValueOnce("run-new");

      const result = await acceptInboundCall(
        target(),
        config,
        { issueKey: "PLAT-42" },
        settings,
      );
      expect(result).toEqual({ outcome: "accepted", runId: "run-new" });
    });

    it("writes a suppressed row once the breaker's limit for that record is reached, leaving others alone", async () => {
      process.env.TRIGGER_BREAKER_MAX_RUNS = "2";
      try {
        const done = (id: string) => ({
          id,
          triggerId: "trig-1",
          entityId: "PLAT-42",
          status: "success",
          startedAt: new Date(NOW.getTime() - 60_000),
        });
        const fake = seed({ runs: [done("r1"), done("r2")] });
        mockNanoid.mockReturnValueOnce("run-suppressed");

        const tripped = await acceptInboundCall(
          target(),
          config,
          { issueKey: "PLAT-42" },
          settings,
        );
        expect(tripped).toEqual({
          outcome: "suppressed",
          runId: "run-suppressed",
        });
        expect(fake.tables.trigger_run.at(-1)).toMatchObject({
          id: "run-suppressed",
          status: "suppressed",
        });

        mockNanoid.mockReturnValueOnce("run-other-record");
        const other = await acceptInboundCall(
          target(),
          config,
          { issueKey: "PLAT-7" },
          settings,
        );
        expect(other.outcome).toBe("accepted");
        expect(fireTrigger).toHaveBeenCalledTimes(1);
      } finally {
        delete process.env.TRIGGER_BREAKER_MAX_RUNS;
      }
    });

    it("counts the whole Trigger when no record key is marked", async () => {
      const unkeyed = { ...config, recordKey: undefined };
      const fake = seed();
      await acceptInboundCall(target(), unkeyed, { issueKey: "A" }, settings);
      await acceptInboundCall(target(), unkeyed, { issueKey: "A" }, settings);

      // No dedup without a key: both calls ran, counted under the Trigger.
      expect(fireTrigger).toHaveBeenCalledTimes(2);
      expect(fake.tables.trigger_run.map((run) => run.entityId)).toEqual([
        "trig-1",
        "trig-1",
      ]);
    });

    it("refuses past the concurrency cap without writing a row, and frees the slot when a run ends", async () => {
      let finish: () => void = () => {};
      vi.mocked(fireTrigger).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = () => resolve("ran");
          }),
      );
      const fake = seed();
      const one = { ...settings, maxConcurrentRuns: 1 };

      await acceptInboundCall(target(), config, { issueKey: "A" }, one);
      expect(
        await acceptInboundCall(target(), config, { issueKey: "B" }, one),
      ).toEqual({ outcome: "rate_limited" });
      expect(fake.tables.trigger_run).toHaveLength(1);

      finish();
      await vi.waitFor(() => expect(activeInboundRunCount()).toBe(0));
      expect(
        (await acceptInboundCall(target(), config, { issueKey: "B" }, one))
          .outcome,
      ).toBe("accepted");
    });
  });

  describe("touchInboundTrigger", () => {
    it("writes at most once a minute per Trigger and column", async () => {
      const fake = seed();

      await touchInboundTrigger("trig-1", "lastUsedAt", NOW);
      expect(fake.tables.trigger[0].lastUsedAt).toEqual(NOW);

      const soon = new Date(NOW.getTime() + 30_000);
      await touchInboundTrigger("trig-1", "lastUsedAt", soon);
      expect(fake.tables.trigger[0].lastUsedAt).toEqual(NOW);

      await touchInboundTrigger("trig-1", "lastRejectedAt", soon);
      expect(fake.tables.trigger[0].lastRejectedAt).toEqual(soon);

      const later = new Date(NOW.getTime() + 61_000);
      await touchInboundTrigger("trig-1", "lastUsedAt", later);
      expect(fake.tables.trigger[0].lastUsedAt).toEqual(later);
    });
  });

  describe("logInboundCall", () => {
    it("writes every documented field on every line, null where it does not apply", () => {
      logInboundCall({
        triggerId: "nope",
        outcome: "rejected",
        reason: "unknown_trigger",
      });
      expect(mockLogger.info).toHaveBeenCalledWith(
        {
          organizationId: null,
          workspaceId: null,
          triggerId: "nope",
          outcome: "rejected",
          reason: "unknown_trigger",
          runId: null,
          deduplicated: null,
          recordKey: null,
        },
        "Inbound trigger call",
      );
    });
  });

  describe("expiry reminders", () => {
    const token = (createdDaysAgo: number, expiresInDays: number) => ({
      tokenCreatedAt: new Date(NOW.getTime() - createdDaysAgo * DAY),
      tokenExpiresAt: new Date(NOW.getTime() + expiresInDays * DAY),
    });

    it("is owed 30 days out, then 7 days out", () => {
      expect(dueReminder(token(60, 31), NOW)).toBeNull();
      expect(dueReminder(token(60, 30), NOW)).toBe("expiring_30");
      expect(dueReminder(token(60, 8), NOW)).toBe("expiring_30");
      expect(dueReminder(token(83, 7), NOW)).toBe("expiring_7");
      expect(dueReminder(token(90, 0), NOW)).toBeNull();
    });

    it("skips a reminder that would fall before the token was created", () => {
      // A 30-day token: its 30-day reminder would be at the moment of issue.
      expect(dueReminder(token(0, 30), NOW)).toBeNull();
      expect(dueReminder(token(1, 29), NOW)).toBeNull();
      expect(dueReminder(token(23, 7), NOW)).toBe("expiring_7");
    });

    it("sends each reminder once, recorded on the Trigger", async () => {
      const fake = seed({
        trigger: [
          inboundTrigger({
            tokenCreatedAt: new Date(NOW.getTime() - 70 * DAY),
            tokenExpiresAt: new Date(NOW.getTime() + 20 * DAY),
          }),
        ],
      });

      await sendInboundTokenReminders(NOW);
      await sendInboundTokenReminders(NOW);
      expect(createNotification).toHaveBeenCalledTimes(1);
      expect(fake.tables.trigger[0].tokenNotice).toBe("expiring_30");

      const weekOut = new Date(NOW.getTime() + 14 * DAY);
      await sendInboundTokenReminders(weekOut);
      expect(createNotification).toHaveBeenCalledTimes(2);
      expect(fake.tables.trigger[0].tokenNotice).toBe("expiring_7");
    });

    it("skips revoked tokens and Triggers of other types", async () => {
      seed({
        trigger: [
          inboundTrigger({ id: "revoked", tokenHash: null }),
          inboundTrigger({ id: "cron", type: "cron" }),
        ],
      });
      await sendInboundTokenReminders(new Date(NOW.getTime() + 60 * DAY));
      expect(createNotification).not.toHaveBeenCalled();
    });
  });

  describe("Org Admin oversight", () => {
    it("lists the Organization's Inbound Triggers with their token status, never the token", async () => {
      seed({
        trigger: [
          inboundTrigger(),
          inboundTrigger({
            id: "trig-2",
            tokenExpiresAt: new Date(NOW.getTime() + 5 * DAY),
          }),
          inboundTrigger({ id: "trig-cron", type: "cron" }),
        ],
      });

      const rows = await listOrgInboundTriggers("org-1", NOW);
      expect(rows.map((row) => [row.id, row.tokenStatus])).toEqual([
        ["trig-1", "active"],
        ["trig-2", "expiring"],
      ]);
      expect(rows[0]).toMatchObject({
        workspaceName: "Support",
        ownerName: "Owner",
      });
      expect(JSON.stringify(rows)).not.toContain(hashInboundToken(TOKEN));
      expect(await listOrgInboundTriggers("org-2", NOW)).toEqual([]);
    });

    it("classifies a token's standing", () => {
      const at = (days: number) => new Date(NOW.getTime() + days * DAY);
      expect(
        inboundTokenStatus({ tokenHash: null, tokenExpiresAt: null }, NOW),
      ).toBe("none");
      expect(
        inboundTokenStatus({ tokenHash: "h", tokenExpiresAt: at(-1) }, NOW),
      ).toBe("expired");
      expect(
        inboundTokenStatus({ tokenHash: "h", tokenExpiresAt: at(30) }, NOW),
      ).toBe("expiring");
      expect(
        inboundTokenStatus({ tokenHash: "h", tokenExpiresAt: at(31) }, NOW),
      ).toBe("active");
    });

    it("revokes a token and tells the Owner", async () => {
      const fake = seed();

      expect(await revokeInboundTriggerToken("org-1", "trig-1")).toBe(true);
      expect(fake.tables.trigger[0]).toMatchObject({
        tokenHash: null,
        tokenExpiresAt: null,
        tokenNotice: null,
      });
      expect(createNotification).toHaveBeenCalledWith(
        expect.anything(),
        { orgId: "org-1", workspaceId: "ws-1", agentId: "agent-1" },
        expect.objectContaining({ title: "Inbound trigger token revoked" }),
      );

      // The revoked token now fails like any wrong one.
      const result = await authenticateInboundCall("trig-1", `Bearer ${TOKEN}`);
      expect(result.ok ? "ok" : result.reason).toBe("bad_token");
    });

    it("cannot reach another Organization's Trigger", async () => {
      const fake = seed();
      expect(await revokeInboundTriggerToken("org-2", "trig-1")).toBe(false);
      expect(fake.tables.trigger[0].tokenHash).not.toBeNull();
      expect(createNotification).not.toHaveBeenCalled();
    });
  });
});
