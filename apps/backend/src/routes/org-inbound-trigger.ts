import { Hono } from "hono";
import { requireAuth } from "../middleware/authentication.ts";
import { orgScopeOf, requireOrgAccess } from "../middleware/authorization.ts";
import {
  listOrgInboundTriggers,
  revokeInboundTriggerToken,
} from "../services/inbound-trigger.ts";
import { NotFoundError } from "../errors.ts";
import type { Variables } from "../server.ts";

/**
 * Org Admin oversight of Inbound Triggers (ADR-0030): see every one in the
 * Organization and revoke a token. Nothing else — no edit, no disable, no
 * lock. The Workspace Owner creates, edits and regenerates; the Organization
 * gate is the broader off switch.
 */
const orgInboundTrigger = new Hono<{ Variables: Variables }>();

/** Every Inbound Trigger in the Organization. Never a token. */
orgInboundTrigger.get(
  "/",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    return c.json({ results: await listOrgInboundTriggers(orgId) });
  },
);

/** Revoke an Inbound Trigger's token. The Owner is notified. */
orgInboundTrigger.delete(
  "/:triggerId/token",
  requireAuth,
  requireOrgAccess(["admin"]),
  async (c) => {
    const { orgId } = orgScopeOf(c);
    if (!(await revokeInboundTriggerToken(orgId, c.req.param("triggerId")))) {
      throw new NotFoundError("Inbound trigger not found");
    }
    return c.json({ message: "Token revoked" });
  },
);

export { orgInboundTrigger };
