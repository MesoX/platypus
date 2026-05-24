---
name: state-machine
description: The per-meeting state directory layout on the sandbox volume, the status.json schema, the rules for resuming a pipeline that was interrupted mid-run, and the archive step that uploads transcript + notes back into the meeting's Drive folder. The Drive MCP is read-mostly (no rename/move/delete), so archival is upload-only.
---

# Per-meeting state on the sandbox volume

State lives at `/workspace/meetings/<meetingId>/` where `meetingId` is the Drive folder id. The directory persists across sandbox restarts (workspace volume, ADR-0001). The directory's existence is also the claim marker — see `inbox-claim`.

## Directory layout

```
/workspace/meetings/<meetingId>/
  status.json              ← current step + meta (always present)
  audio.<ext>               ← downloaded audio; removed at archive step
  raw_transcript.json       ← WhisperX response
  calendar.json             ← match output
  extraction.json           ← drawer list + KG edges (output of meeting-extract)
  notes.md                  ← optional structured notes (output of meeting-extract)
  written.json              ← drawer ids returned by Librarian
```

The orchestrator never writes raw transcripts, extractions, or notes itself — those are written by the skill or sub-agent that produced them.

## `status.json` schema

```json
{
  "meeting_id": "<driveFolderId>",
  "drive_folder_id": "<driveFolderId>",
  "drive_folder_original_name": "Customer-X-2026-05-23",
  "drive_audio_file_id": "<audioFileId>",
  "drive_audio_original_name": "audio.wav",
  "claimed_at": "2026-05-23T14:35:12+02:00",
  "step": "claimed",
  "calendar_event_id": null,
  "adhoc_dedup_key": null,
  "errors": []
}
```

`errors` is append-only: every retryable failure appends `{ at, step, message }` where `message` is the verbatim tool error string.

## Step enum

```
claimed
  → downloaded
    → transcribed
      → calendar_matched
        → dedup_checked
          → extracted
            → written
              → archived
                → done
```

Failure states: when step X throws, set `step: "<x>_failed"` and append to `errors`. Next trigger run decides whether to retry (`errors.length < 3`) or surface as GIVE-UP.

## Resume rules

On every orchestrator invocation, before doing anything:

1. `fsList /workspace/meetings` with `recursive: false`.
2. For each subdir, `fsRead` its `status.json`.
3. Build an ordered list (oldest `claimed_at` first), excluding `done` and excluding `*_failed` entries where `errors.length >= 3`.
4. Process at most **one** meeting per run.

## Atomic updates

Use `fsWrite mode: "overwrite"` to swap `status.json` in one call. Never partial writes. When appending to `errors`: `fsRead` the current file → mutate in memory → `fsWrite` the whole new object.

## Archive step (the final step before `done`)

The Drive MCP does not expose rename, move, or delete. So archival is **upload-only**:

1. Read `/workspace/meetings/<meetingId>/raw_transcript.json` via `fsRead`. Upload it to the meeting's Drive folder via `create_file`:

   ```
   create_file
     parentId: <drive_folder_id>
     name: "transcript.json"
     mimeType: "application/json"
     content: <body from fsRead>
   ```

2. If `/workspace/meetings/<meetingId>/notes.md` exists (sub-agent emitted it), upload that too:

   ```
   create_file
     parentId: <drive_folder_id>
     name: "notes.md"
     mimeType: "text/markdown"
     content: <body from fsRead>
   ```

3. Upload a final `pipeline.status.json` snapshot to the meeting folder (rename the local `status.json` on upload so it doesn't collide with any user file):

   ```
   create_file
     parentId: <drive_folder_id>
     name: "pipeline.status.json"
     mimeType: "application/json"
     content: <body from fsRead /workspace/meetings/<meetingId>/status.json>
   ```

4. Delete the local audio file to free sandbox volume space:

   ```
   shellExec command="rm -f /workspace/meetings/<meetingId>/audio.*"
   ```

5. Update `status.json`: `step: "archived"`. The next invocation sets `step: "done"`.

The Drive folder is not moved or renamed. The user manually drags it from `inbox/` to `archive/` in the Drive UI when they want to declutter. The pipeline accepts that limitation.

## What this skill is NOT for

- Drive folder rename / move / delete — not exposed by this Drive MCP.
- Cross-meeting orchestration.
- Long-term cleanup of `/workspace/meetings/` (handled by an out-of-scope sweeper later).
