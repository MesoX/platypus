---
name: inbox-claim
description: How to atomically claim a meeting from the Google Drive inbox. Each meeting lives in its own folder under `{{inbox_folder}}/`. Claim by renaming the folder to `_processing_…`, locate the audio file inside, download it via the drive-proxy skill.
---

# How to claim one meeting from the Drive inbox

A meeting is **a folder** under `{{inbox_folder}}/`, not a loose file. The folder may contain one audio recording plus optional companions (slides PDF, notes text, etc.). This shape lets multi-file meetings stay together and gives every meeting a permanent home after archival.

```
Meeting Recordings/
  inbox/
    Customer-X-2026-05-23/         ← one meeting
      audio.wav
      slides.pdf                   ← optional
  archive/
    Customer-Y-2026-05-22/          ← already-processed meeting
      audio.wav
      transcript.json
      notes.md
      status.json
```

## Locate the inbox folder id

The inbox folder's path is `{{inbox_folder}}`. Find its id once per run via the Drive MCP `list_files` tool:

```
q: name = '{{inbox_folder_name}}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false
fields: id, name
```

Cache that id for the rest of the run.

## List candidate meeting folders

```
list_files
  q: '<inboxFolderId>' in parents and mimeType = 'application/vnd.google-apps.folder' and trashed = false and not name contains '_processing_'
  orderBy: createdTime asc
  fields: id, name, createdTime
  pageSize: 10
```

Skip:

- Folders whose visible name starts with `_processing_` (claimed already).
- Folders that contain zero audio/video files (check below; empty placeholder folders).

If no folder passes, **exit the run cleanly** — there is no work to do.

## Compute the meeting id

`meeting_id` = the Drive folder's id. The id is stable across rename, so claim and archive operations don't break it.

## Atomically claim by renaming

Rename the chosen folder with a `_processing_<ISO8601-no-colons>_` prefix on its visible name. Drive's `update_file` works on folders too.

```
update_file
  fileId: <folderId>
  body: { name: "_processing_2026-05-23T1400_<original-folder-name>" }
```

If `update_file` returns 409/412 or the read-back name still starts with `_processing_` and that prefix is NOT yours, another run won. Move to the next candidate.

## Find the audio file inside

```
list_files
  q: '<folderId>' in parents and trashed = false
  fields: id, name, mimeType, size, createdTime
  pageSize: 50
```

From the result, pick the one audio/video file:

1. Mime type starts with `audio/` or `video/`, OR
2. Name ends in `.wav`, `.mp3`, `.m4a`, `.webm`, `.mp4`, `.flac`, `.ogg`.

If zero matches, mark the meeting `claimed_failed` and surface to the user — the recording is missing. If multiple, pick the largest (rough heuristic for "the actual recording vs short voice memo").

Save the audio file's id and original name in `status.json` (see `state-machine`).

## Create the sandbox state directory

```bash
mkdir -p /workspace/meetings/<folderId>
```

Write initial `status.json`:

```json
{
  "meeting_id": "<folderId>",
  "drive_folder_id": "<folderId>",
  "drive_folder_original_name": "Customer-X-2026-05-23",
  "drive_audio_file_id": "<audioFileId>",
  "drive_audio_original_name": "audio.wav",
  "claimed_at": "<ISO timestamp>",
  "step": "claimed",
  "errors": []
}
```

## Download the audio

Use the `drive-proxy` skill to stream the audio bytes from the proxy into `/workspace/meetings/<folderId>/audio.<ext>`. The extension comes from the original audio filename. After a 200 response, advance status to `downloaded`.

## What this skill is NOT for

- Touching files outside `{{inbox_folder}}/`.
- Reading the audio file's content (that's WhisperX's job, see `transcribe-whisperx`).
- Archival. Cleanup moves the folder to `archive/` in its own step (see `state-machine`).
