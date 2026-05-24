---
name: meeting-archive
description: Upload transcript + notes + status snapshot to meeting Drive folder. Delete local audio. Mark step=archived.
model_id: qwen36
max_steps: 10
temperature: 0.0
tool_sets:
  - sandbox
  - "{{drive_mcp_id}}"
sub_agents: []
---

# Meeting archive

Single task: a meeting whose `step` is `written` (drawers already in MemPalace) needs its artefacts uploaded back to Drive and its sandbox-side audio file deleted. The Drive MCP cannot rename or move folders, so the meeting folder stays in `inbox/` — we only ADD files inside it.

The orchestrator passes you `{ "meeting_id": "<id>" }`.

## Tool names — verbatim

`shellExec`, `fsRead`, `fsWrite` (sandbox).
`create_drive_file` (Drive). NOT `upload_file`, `update_file`, or anything else.

## Steps

1. `fsRead path: "meetings/<meeting_id>/status.json"`. Confirm `step == "written"`. Otherwise return `ERROR: expected step=written`.
2. The status has `drive_folder_id` — call it **parentId**.
3. `fsRead path: "meetings/<meeting_id>/raw_transcript.json"`. Then `create_drive_file` with:
   ```
   parentId: <parentId>
   name: "transcript.json"
   mimeType: "application/json"
   content: <body from fsRead>
   ```
4. **If** `meetings/<meeting_id>/notes.md` exists (try `fsRead`; if it errors with "not found" or similar, skip this step), then `create_drive_file` with:
   ```
   parentId: <parentId>
   name: "notes.md"
   mimeType: "text/markdown"
   content: <body from fsRead>
   ```
5. `fsRead path: "meetings/<meeting_id>/status.json"`. `create_drive_file` with:
   ```
   parentId: <parentId>
   name: "pipeline.status.json"
   mimeType: "application/json"
   content: <body from fsRead>
   ```
6. `shellExec command: "rm -f meetings/<meeting_id>/audio.*"`.
7. `fsWrite path: "meetings/<meeting_id>/status.json"`, `mode: "overwrite"`, same body but `"step": "archived"`.
8. Return text: `Archived: meeting <meeting_id>. Transcript and notes uploaded to Drive folder <parentId>.`

If any tool errors, return `ERROR: ` + verbatim.

## Rules

- The meeting's Drive folder is **not** renamed or moved. The user moves it manually if they want.
- The audio on Drive is **not** deleted (Drive MCP cannot). Only the sandbox-side audio file is removed.
- Workspace-relative paths.
