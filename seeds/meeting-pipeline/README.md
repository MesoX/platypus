# Meeting Pipeline Seeds

Specs for the meeting-recording → MemPalace pipeline (see `meeting-pipeline.md` at the repo root for design).

## Layout

```
seeds/meeting-pipeline/
  agents/      — system prompts + metadata for the three pipeline agents
  skills/      — reusable playbooks the orchestrator cites
  triggers/    — cron + chat trigger configurations
  seed.ts      — apply the specs to a target workspace
```

## What this seeds (vertical slice)

Three agents:

1. **meeting-pipeline** — orchestrator. Drives the per-meeting state machine. Calls Sandbox tools to run shell commands inside its workspace sandbox, calls Drive/Calendar MCPs, dispatches `meeting-extract` and `meeting-write` as sub-agents, and asks `Librarian` to query MemPalace.
2. **meeting-extract** — turns a corrected transcript + meeting context into a structured drawer list, KG edges, and event anchor JSON.
3. **meeting-write** — hands the approved JSON to `Librarian` for writing.

Six skills:

- `inbox-claim` — list Drive inbox, rename to `_processing_…`, download via proxy.
- `transcribe-whisperx` — POST to local WhisperX, save the JSON.
- `calendar-match` — parse filename timestamp, query Google Calendar MCP, pick the right event.
- `drive-proxy` — call `http://host.docker.internal:4010/internal/resources/google-drive/...` with `$INTERNAL_SECRET`.
- `librarian-protocol` — JSON shapes the meeting agents pass to/expect from Librarian.
- `state-machine` — `/workspace/meetings/{meeting_id}/status.json` shape, transitions, idempotent resume.

One trigger:

- `cron-scan-inbox` — every 20 minutes, fires `meeting-pipeline` with `mode=scan_inbox`.

What's deliberately **not** seeded (later iterations):
`meeting-correct`, `meeting-context`, `meeting-review`, `meeting-connect`,
nightly cron (stuck-files sweep + Google Meet recordings discovery),
user-facing preferences UI.

## Preconditions for seeding

The target workspace must already have:

- A Sandbox configured (Docker reference adapter is fine).
- An `INTERNAL_SECRET` set in the workspace's Sandbox env vars (ADR-0004), matching the backend's `INTERNAL_SECRET`. Never put it in the agent's system prompt.
- Google Drive MCP authorised (OAuth completed).
- Google Calendar MCP authorised.
- MemPalace MCP authorised.
- `Librarian` agent present, with MemPalace tool access.

The Drive MCP must hold a folder called `Meeting Recordings/inbox` that the recording scripts write to.

## How to seed

```bash
pnpm tsx seeds/meeting-pipeline/seed.ts \
  --workspace=<workspaceId> \
  --provider=<providerId> \
  --model=qwen36 \
  --drive-mcp=<driveMcpId> \
  --calendar-mcp=<calendarMcpId> \
  --librarian-agent=<librarianAgentId> \
  --backend-url=http://host.docker.internal:4010 \
  --whisperx-url=http://host.docker.internal:9000 \
  --inbox-folder="Meeting Recordings/inbox"
```

The script reads each `.md` file under `agents/` / `skills/` (front-matter + body), substitutes `{{placeholders}}` from the CLI args, then POSTs to the backend's authenticated routes. It is idempotent — re-running updates existing rows in place by name.

You also need a session cookie (the script reads `PLATYPUS_SESSION_COOKIE` from env) because all `/organizations/.../skills` and `/agents` routes require `requireAuth`.

## Running the pipeline

After seeding:

1. Drop a `.wav` into the Drive inbox folder.
2. Either wait for the cron, or open the workspace chat and say "process meetings".
3. Watch the orchestrator in the chat / run log. State artefacts live in the sandbox at `/workspace/meetings/{meeting_id}/`.

## How to extend

- New step in the pipeline → new skill markdown file + add its name to the orchestrator's `skillIds`.
- New sub-agent → new file under `agents/`, list it in the orchestrator's `subAgentIds`.
- New trigger → new file under `triggers/`.
