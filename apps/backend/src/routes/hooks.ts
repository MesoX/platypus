import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Variables } from "../server.ts";
import {
  acceptInboundCall,
  authenticateInboundCall,
  getInboundRunStatus,
  inboundEntityId,
  inboundTriggerSettings,
  INBOUND_RETRY_AFTER_SECONDS,
  loadInboundTarget,
  logInboundCall,
  touchInboundTrigger,
  validateInboundBody,
  type InboundAuthResult,
  type InboundRejectReason,
  type InboundTarget,
} from "../services/inbound-trigger.ts";

/**
 * `/hooks/*` — the ingress for callers that are not a browser session
 * (ADR-0030). Mounted outside `/organizations/...` and outside session auth,
 * so an Operator on a private network can expose this prefix alone through a
 * proxy or tunnel. Nothing here reads a session cookie.
 *
 * `POST /hooks/triggers/:triggerId` fires an Inbound Trigger and answers
 * `202 { runId, deduplicated }` before the run starts.
 * `GET /hooks/triggers/:triggerId/runs/:runId` polls that run.
 *
 * Every rejection a caller could use to learn what exists — an unknown
 * Trigger, a wrong, missing or expired token, a disabled Trigger, a closed
 * gate, a Trigger that is not inbound — is the same `404` with the same body.
 */
const hooks = new Hono<{ Variables: Variables }>();

/** The one body every "does not exist, as far as you know" answer carries. */
const NOT_FOUND_BODY = { error: "Not Found" } as const;

const notFound = (c: Context) => c.json(NOT_FOUND_BODY, 404);

/**
 * Rejections that name a real Inbound Trigger. They stamp its "last
 * rejected", which is how an Owner or Org Admin sees that something is
 * calling with a bad or expired token without searching the logs. An unknown
 * id, or a Trigger of another type, names no Inbound Trigger to stamp.
 */
const REAL_TRIGGER_REJECTIONS = new Set<InboundRejectReason>([
  "missing_token",
  "bad_token",
  "expired_token",
  "disabled",
  "gate",
  "misconfigured",
  "invalid_inputs",
  "body_too_large",
]);

const logContext = (target: InboundTarget | null) =>
  target
    ? {
        organizationId: target.organizationId,
        workspaceId: target.workspaceId,
      }
    : {};

/** Logs a rejection, and stamps "last rejected" when it names a real one. */
const recordRejection = async (
  triggerId: string,
  reason: InboundRejectReason,
  target: InboundTarget | null,
) => {
  logInboundCall({
    triggerId,
    ...logContext(target),
    outcome: "rejected",
    reason,
  });
  if (
    target?.trigger.type === "inbound" &&
    REAL_TRIGGER_REJECTIONS.has(reason)
  ) {
    await touchInboundTrigger(triggerId, "lastRejectedAt");
  }
};

/**
 * The body cap is checked first — before the token — and is the only size
 * limit: it bounds what reaches the Agent's context and run history. Read per
 * request, so the middleware takes the value the boot validation reported.
 */
const capBody: MiddlewareHandler = (c, next) =>
  bodyLimit({
    maxSize: inboundTriggerSettings().maxBodyBytes,
    onError: async (limited) => {
      const triggerId = limited.req.param("triggerId") ?? "";
      const target = triggerId ? await loadInboundTarget(triggerId) : null;
      await recordRejection(triggerId, "body_too_large", target);
      return limited.json({ error: "Payload Too Large" }, 413);
    },
  })(c, next);

hooks.post("/triggers/:triggerId", capBody, async (c) => {
  // Always present: the path names it. `capBody` widens the context type.
  const triggerId = c.req.param("triggerId") ?? "";
  try {
    return await fire(c, triggerId);
  } catch (error) {
    // Every call writes exactly one line. Each path in `fire` logs as it
    // returns, and nothing after a log line can throw, so a throw here means
    // none was written yet.
    logInboundCall({
      triggerId,
      outcome: "rejected",
      reason: "internal_error",
    });
    throw error;
  }
});

const fire = async (c: Context, triggerId: string) => {
  const raw = await c.req.text();

  const auth: InboundAuthResult = await authenticateInboundCall(
    triggerId,
    c.req.header("Authorization"),
  );
  if (!auth.ok) {
    await recordRejection(triggerId, auth.reason, auth.target);
    return notFound(c);
  }
  const { target, config } = auth;

  let body: unknown;
  try {
    body = raw.trim() === "" ? undefined : JSON.parse(raw);
  } catch {
    await recordRejection(triggerId, "invalid_inputs", target);
    return c.json({ error: "The request body is not valid JSON." }, 400);
  }
  const validated = validateInboundBody(body, config.inputs);
  if (!validated.ok) {
    await recordRejection(triggerId, "invalid_inputs", target);
    return c.json({ error: validated.message }, 400);
  }

  const recordKey =
    config.recordKey !== undefined
      ? inboundEntityId(target.trigger, config, validated.inputs)
      : undefined;
  const acceptance = await acceptInboundCall(target, config, validated.inputs);

  if (acceptance.outcome === "rate_limited") {
    logInboundCall({
      triggerId,
      ...logContext(target),
      outcome: "rate_limited",
      recordKey,
    });
    await touchInboundTrigger(triggerId, "lastRejectedAt");
    c.header("Retry-After", String(INBOUND_RETRY_AFTER_SECONDS));
    return c.json({ error: "Too Many Requests" }, 429);
  }

  const deduplicated = acceptance.outcome === "deduplicated";
  logInboundCall({
    triggerId,
    ...logContext(target),
    outcome: acceptance.outcome,
    runId: acceptance.runId,
    deduplicated,
    recordKey,
  });
  // A suppressed call used a valid token as much as an accepted one did, so
  // it counts as use: "last used" is how a leaked token in use shows up.
  await touchInboundTrigger(triggerId, "lastUsedAt");
  return c.json({ runId: acceptance.runId, deduplicated }, 202);
};

hooks.get("/triggers/:triggerId/runs/:runId", async (c) => {
  const triggerId = c.req.param("triggerId");
  const auth = await authenticateInboundCall(
    triggerId,
    c.req.header("Authorization"),
  );
  if (!auth.ok) return notFound(c);

  const run = await getInboundRunStatus(triggerId, c.req.param("runId"));
  if (!run) return notFound(c);
  return c.json(run, 200);
});

export { hooks };
