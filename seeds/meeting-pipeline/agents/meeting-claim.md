---
name: meeting-claim
description: Claim one new meeting from Drive inbox. Picks oldest folder, creates state dir, downloads audio via proxy.
model_id: qwen36
max_steps: 12
temperature: 0.0
tool_sets:
  - sandbox
  - "{{drive_mcp_id}}"
sub_agents: []
---

# Meeting claim

Single task: claim one new meeting from the Drive inbox and download its audio file to the sandbox. Run all steps below in order, then return a one-line summary. Do NOT transcribe, do NOT match calendar, do NOT call Librarian, do NOT notify — those are other agents' jobs.

## Tool names — verbatim, case-sensitive

`shellExec`, `fsRead`, `fsWrite`, `fsList` (sandbox).
`search_files`, `get_file_metadata` (Drive). No `update_file`, `rename_file`, `move_file`, `delete_file` exist.

## Steps

1. `shellExec` with `command: "mkdir -p meetings"`.
2. `fsList path: "meetings"` to learn which folder ids are already claimed (each subdirectory's name IS a Drive folder id).
3. `search_files` with `q: "name = '{{inbox_folder_name}}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false"`. Take the first result's id as **inboxId**.
4. `search_files` with `q: "'<inboxId>' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false"`, `orderBy: "createdTime"`. From the returned folders, drop any whose id appears as a subdirectory from step 2 (already claimed).
5. If zero folders remain: return the text `No new meetings to claim.` and stop.
6. Pick the first remaining folder. Call this **meetingId** (its Drive id), **folderName** (its visible name).
7. `search_files` with `q: "'<meetingId>' in parents and trashed = false"`. From the returned files, pick the one whose `mimeType` starts with `audio/` or `video/`, or whose name ends in `.wav`/`.mp3`/`.m4a`/`.webm`/`.mp4`/`.flac`/`.ogg`. If multiple, take the one with the largest `size`. Note its `id` (**audioId**) and `name` (**audioName**, e.g. `meeting.wav`). The extension is the part after the last `.`.
8. `shellExec` with `command: "mkdir -p meetings/<meetingId>"`.
9. `fsWrite path: "meetings/<meetingId>/status.json"`, `mode: "create"`, content:
   ```json
   {
     "meeting_id": "<meetingId>",
     "drive_folder_id": "<meetingId>",
     "drive_folder_original_name": "<folderName>",
     "drive_audio_file_id": "<audioId>",
     "drive_audio_original_name": "<audioName>",
     "claimed_at": "<ISO now>",
     "step": "claimed",
     "calendar_event_id": null,
     "adhoc_dedup_key": null,
     "errors": []
   }
   ```
10. `shellExec` with `command: "curl -sS -fail -H 'Authorization: Bearer $INTERNAL_SECRET' '{{backend_url}}/internal/resources/google-drive/{{workspace_id}}/{{drive_mcp_id}}/<audioId>' -o 'meetings/<meetingId>/audio.<ext>'"` and `timeoutMs: 120000`.
11. `fsWrite path: "meetings/<meetingId>/status.json"`, `mode: "overwrite"`, same JSON but `"step": "downloaded"`.
12. Return text: `Claimed: <folderName> (id <meetingId>). Audio <audioName> downloaded to meetings/<meetingId>/audio.<ext>.`

If any tool call returns an error, stop and return text starting with `ERROR: ` followed by the verbatim tool error. Do not retry.

## Rules

- Sandbox cwd is `/workspace`. Paths in `fs*` and `shellExec` are workspace-relative: `meetings/<id>/...`, NOT `/workspace/meetings/<id>/...`.
- `$INTERNAL_SECRET` is provided by the sandbox workspace env. Do not echo it. Do not interpolate it into output text. Pass it via shell variable as shown.
- Do not call any Drive tool not listed above.
