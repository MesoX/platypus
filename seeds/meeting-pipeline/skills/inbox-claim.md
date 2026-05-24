---
name: inbox-claim
description: How to atomically claim a meeting recording from the Google Drive inbox so two concurrent pipeline runs cannot fight over the same file. Lists candidates, renames one to a `_processing_` prefix, downloads its bytes into the sandbox via the drive-proxy skill.
---

# How to claim one file from the Drive inbox

## Locate the inbox folder

The inbox folder for this workspace is named `{{inbox_folder}}` and lives at the root of the user's Drive. Find its folder id by calling the Drive MCP `list_files` tool with:

```
q: name = '{{inbox_folder_name}}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false
fields: id, name
```

Cache the folder id between calls within a single pipeline run.

## List candidates

```
list_files
  q: '<folderId>' in parents and trashed = false and not name contains '_processing_'
  orderBy: createdTime asc
  fields: id, name, mimeType, createdTime
  pageSize: 10
```

Skip:

- Files with `_processing_` in the name (already claimed by another run).
- Folders.
- Files whose mime type is neither `audio/*` nor `video/*` and whose name does not end in a known media extension (`.wav`, `.mp3`, `.m4a`, `.webm`, `.mp4`).

If no candidates remain, **exit the run cleanly** with a one-line summary — there is no work to do.

## Compute the meeting id

For each candidate, the meeting id is its Drive file id (stable across the rename below). Use it as the directory name under `/workspace/meetings/<meetingId>/`.

## Atomically claim by renaming

Rename the chosen file with a `_processing_<ISO8601-no-colons>_` prefix on the visible name. Drive ids are stable across rename, so the meetingId does not change.

```
update_file
  fileId: <fileId>
  body: { name: "_processing_2026-05-23T1400_<original-name>" }
```

If the rename fails with 409/412 or returns a name that already starts with `_processing_`, another run won this race. Move to the next candidate.

## Persist the claim

Create the state directory and write the initial `status.json` (see the `state-machine` skill):

```bash
mkdir -p /workspace/meetings/<meetingId>
```

```json
{
  "meeting_id": "<fileId>",
  "drive_file_id": "<fileId>",
  "original_name": "<original-name>",
  "claimed_at": "<ISO timestamp>",
  "step": "claimed"
}
```

Write that to `/workspace/meetings/<meetingId>/status.json` via `fsWrite`.

## Download the bytes

Use the `drive-proxy` skill to stream the audio into `/workspace/meetings/<meetingId>/audio.<ext>`. Pick the extension from the original filename. Once the download returns 200, advance status to `downloaded`.

## What this skill is NOT for

- Deleting files. Cleanup is its own step, after MemPalace writes succeed.
- Touching files in other folders. The inbox is the only authoritative source.
