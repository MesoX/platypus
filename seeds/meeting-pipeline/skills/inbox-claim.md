---
name: inbox-claim
description: How to claim a meeting from the Google Drive inbox. The Drive MCP exposed by Google is read-mostly (no rename or move), so claiming is done entirely via the sandbox state directory. Race-safe because the cron scheduler runs one pipeline at a time per agent.
---

# How to claim one meeting from the Drive inbox

A meeting is **a folder** under `{{inbox_folder}}/`. Inside that folder lives the audio recording (`.wav`/`.mp3`/`.m4a`/`.webm`/`.mp4`) plus any optional companions.

```
Meeting Recordings/
  inbox/
    Customer-X-2026-05-23/         ← one meeting
      audio.wav
      slides.pdf                   ← optional
```

The Google Drive MCP available in this workspace exposes only read + create. No rename, move, or delete. So we **cannot** mark folders with a `_processing_` prefix on the Drive side. Claiming is therefore done **entirely** by the existence of the per-meeting state directory at `/workspace/meetings/<folderId>/` on the sandbox volume. If the directory exists, the meeting is claimed (and either in flight or done). If it does not exist, the meeting has not been picked up yet.

Race safety: the cron trigger runs at most one execution per trigger at a time, so two parallel orchestrator runs picking the same folder is not a concern.

## Available Drive tools (exact names, case-sensitive)

- `search_files` — query-based listing
- `list_recent_files` — recent files in the user's Drive
- `get_file_metadata` — single file lookup by id
- `download_file_content` — small text fetch (do not use for audio; use the proxy)
- `read_file_content` — small text reading
- `create_file` — upload a new file under a given parent folder
- `copy_file` — duplicate

## Available sandbox tools (exact names, case-sensitive)

- `shellExec` (NOT `shell_exec`)
- `fsRead`, `fsWrite`, `fsEdit`, `fsList`

## Procedure

### 1. Locate the inbox folder id

Call `search_files` with `q: name = '{{inbox_folder_name}}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`. Cache the returned id for the rest of this run.

### 2. List candidate meeting folders inside inbox

Call `search_files` with:

```
q: '<inboxFolderId>' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false
orderBy: createdTime
pageSize: 25
```

### 3. Filter out already-claimed meetings

For each returned folder, check whether `/workspace/meetings/<folderId>/` already exists using `fsList /workspace/meetings`. Skip folders whose id appears as a subdirectory there — those are claimed.

If the filtered list is empty: **this is normal "nothing to process" state — exit silently, do not notify**.

### 4. Pick one

Take the oldest unclaimed folder by `createdTime`.

### 5. List the meeting folder's contents

Call `search_files` with `q: '<folderId>' in parents and trashed = false` (no `orderBy`). Returned files: pick the one whose `mimeType` starts with `audio/` or `video/`, or whose name ends in `.wav`/`.mp3`/`.m4a`/`.webm`/`.mp4`/`.flac`/`.ogg`. If multiple, take the largest. If zero, mark the meeting `claimed_failed` and surface to the user — there is no audio to process.

### 6. Create the sandbox state directory

```
shellExec command="mkdir -p /workspace/meetings/<folderId>"
```

### 7. Write the initial `status.json`

Use `fsWrite mode: "create"`:

```json
{
  "meeting_id": "<folderId>",
  "drive_folder_id": "<folderId>",
  "drive_folder_original_name": "Customer-X-2026-05-23",
  "drive_audio_file_id": "<audioFileId>",
  "drive_audio_original_name": "audio.wav",
  "claimed_at": "<ISO timestamp>",
  "step": "claimed",
  "calendar_event_id": null,
  "adhoc_dedup_key": null,
  "errors": []
}
```

### 8. Download the audio

Use the `drive-proxy` skill to stream the audio file's bytes from the backend proxy into `/workspace/meetings/<folderId>/audio.<ext>`. The extension comes from the original audio filename's suffix.

### 9. Update status.json

Use `fsWrite mode: "overwrite"`:

```json
{ ...same fields..., "step": "downloaded" }
```

### 10. Notify

Call `createNotification` with the `notify-user` skill's "Claimed:" template.

### 11. Exit

You are done. Do not advance to transcription this run. The next cron invocation handles `downloaded → transcribed`.

## What this skill is NOT for

- Renaming or moving the Drive folder. The Drive MCP does not expose that capability.
- Deleting the audio from Drive. Not exposed either.
- Touching files outside `{{inbox_folder}}/`.
