# Meeting Pipeline — Onboarding Checklist

Before the seeded agents can do anything useful, every workspace that wants the pipeline must complete the prerequisites below. Skipping any step produces silent failures or hallucinated error notifications — the orchestrator cannot recover from a missing prerequisite.

This list lives in the repo (`seeds/meeting-pipeline/ONBOARDING.md`) and should be wrapped into a guided onboarding flow in the UI when the pipeline graduates from experimental.

## What the operator does once per Platypus deployment

1. **Deploy the backend with the resource proxy and sandbox-host-extra-hosts patches.** Both PRs are required.
2. **Set `INTERNAL_SECRET` in the backend `.env`.** Minimum 32 characters. Generate via `openssl rand -hex 32`. The pipeline relies on `feature/internal-resource-proxy` to stream Drive bytes; without the secret the entire `/internal/*` mount is disabled.
3. **Enable the Docker sandbox backend.** Add `compose.sandbox.yaml` overlay to the compose stack and set `PLATYPUS_SANDBOX_DOCKER_ENABLED=true` in the backend env. Requires the Docker socket bind-mount described in ADR-0003.
4. **Verify WhisperX is reachable by sandbox containers.** WhisperX must bind to `0.0.0.0:9000` on the host (not `127.0.0.1:9000`), so containers can reach it via `host.docker.internal:9000`.

## What the workspace owner does once per workspace

5. **Authorise the three MCPs.** Google Drive, Google Calendar, and MemPalace must all be added to the workspace and have a valid OAuth token. The Drive MCP needs the `https://www.googleapis.com/auth/drive` scope.
6. **Have a `Librarian` agent in the workspace.** The pipeline never touches MemPalace directly; every read and write is delegated to Librarian. Without it the dedup check, context lookup, and final write all fail.
7. **Create the Drive folder layout.** In the user's Drive, manually create:
   ```
   Meeting Recordings/
     inbox/          (drop new meetings here)
     archive/        (auto-populated by the pipeline)
   ```
   Inside `inbox/`, one folder per meeting:
   ```
   Meeting Recordings/inbox/Customer-X-2026-05-23/
     audio.wav
     slides.pdf       (optional)
   ```
8. **Configure the workspace Sandbox.** Workspace → Settings → Sandbox → Create. Backend = `docker`. **Add `INTERNAL_SECRET` to the Sandbox env vars** (workspace-default env, see ADR-0004), value matching the backend's `INTERNAL_SECRET` exactly. Without this env var the orchestrator cannot authenticate to the Drive proxy and the pipeline halts at the download step.

## What the seed script does

9. **Run the seed.** From the repo root on a box that can reach the backend (the backend container itself or a host with the same network):

   ```bash
   pnpm tsx seeds/meeting-pipeline/seed.ts \
     --backend=<backend-url> \
     --org=<orgId> \
     --workspace=<workspaceId> \
     --provider=<providerId> \
     --model=<modelId> \
     --drive-mcp=<driveMcpId> \
     --calendar-mcp=<calendarMcpId> \
     --librarian-agent=<librarianAgentId> \
     --backend-url=http://host.docker.internal:<backendPort> \
     --whisperx-url=http://host.docker.internal:9000 \
     --inbox-folder='Meeting Recordings/inbox' \
     --timezone=<IANA timezone> \
     --language-hint=<cs|en|...>
   ```

   The script reads each `.md`/`.json` under `seeds/meeting-pipeline/`, substitutes placeholders, and creates skills, sub-agents, the orchestrator, and the cron trigger. It is idempotent — re-running updates existing rows by name.

   Authentication: `PLATYPUS_SESSION_COOKIE` env var, copied from the browser (`better-auth.session_token` cookie).

   Trigger creation requires the workspace **owner**'s session cookie, not super-admin. If the seed reports `403 Only the workspace owner` on the trigger step, re-run as the owner or create the trigger by hand in the UI.

## Sanity checks after seeding

10. **Skills + agents + trigger exist.** Workspace → Settings → Skills (expect 7), Agents (expect 3 new: `meeting-pipeline`, `meeting-extract`, `meeting-write`), Triggers (expect 1: `meeting-pipeline cron scan`).
11. **Drop a real meeting folder into the inbox.** Open chat with `meeting-pipeline` agent, type `process meetings`, watch the tool calls. The first invocation should claim, download, and emit one `Claimed:` notification.
12. **Wait or re-trigger every 20 minutes** to advance the state machine through transcribe → calendar-match → dedup-check → extract → write → archive.

## Known surprise paths

- **Empty inbox is silent.** No notification, no chat output beyond `"No meetings to process."`. This is by design.
- **WhisperX is FIFO.** Concurrent meetings queue. A 60-minute audio takes 5–8 minutes; the orchestrator's `shellExec` is given `timeoutMs: 600_000` (10 min hard cap) for that step.
- **One step per run.** A single meeting needs ~7 cron invocations end-to-end (or one manual chat invocation per step). The orchestrator deliberately does not loop.
- **Failures retry up to 3 times.** After three consecutive `*_failed` transitions on the same step, the orchestrator emits a `GIVE-UP:` notification and skips the meeting until the user intervenes (move folder back to inbox, delete sandbox state dir, etc.).

## How a Platypus admin can verify a workspace is correctly onboarded

A future onboarding skill should automate these checks. For now, by hand:

- Workspace has a row in the `sandbox` table with `backend='docker'` and `env->>'INTERNAL_SECRET'` matching the backend's.
- Workspace has MCP rows for Google Drive, Google Calendar, MemPalace, each with `oauth_authorized=true` and a non-null `oauth_access_token`.
- Workspace has an agent named `Librarian` with MemPalace in its `tool_set_ids`.
- Drive contains `Meeting Recordings/inbox` and `Meeting Recordings/archive` folders.
