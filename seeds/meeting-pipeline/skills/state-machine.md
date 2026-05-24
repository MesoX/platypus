---
name: state-machine
description: The per-meeting state directory layout, the status.json schema, and the rules for resuming a pipeline that was interrupted mid-run. Also defines the cleanup step that moves the meeting folder from inbox/ to archive/ and uploads transcript + notes back to Drive.
---

# Per-meeting state on the sandbox volume

State lives at `/workspace/meetings/<meetingId>/` where `meetingId` is the Drive folder id. The directory persists across sandbox restarts (workspace volume — ADR-0001). If the directory exists, the orchestrator picks up from `status.json`; if it is gone, the meeting is forgotten.

## Directory layout

```
/workspace/meetings/<meetingId>/
  status.json              ← current step + meta (always present)
  audio.<ext>               ← downloaded audio (removed at cleanup)
  raw_transcript.json       ← WhisperX response
  calendar.json             ← match output
  extraction.json           ← drawer list + KG edges (output of meeting-extract)
  written.json              ← drawer ids returned by Librarian
  notes.md                  ← human-readable meeting notes (produced during extract)
```

The orchestrator never writes raw transcripts or extractions itself — those are written by the skill that produced them.

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

`errors` is append-only: every retryable failure appends `{ at, step, message }`.

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

Failure states: when step X throws, set `step: "<x>_failed"` and append to `errors`. Next trigger run decides whether to retry (errors.length < 3) or surface to user.

## Resume rules

On every orchestrator invocation, before doing anything:

1. `fsList /workspace/meetings` (recursive false).
2. For each subdir, `fsRead status.json`.
3. Build an ordered list (oldest `claimed_at` first), excluding `done` and `*_failed` with `errors.length >= 3`.
4. Process at most **one** meeting per run.
5. If the list is empty AND the invocation is `mode: scan_inbox`, follow `inbox-claim` to start a new one.

## Atomic updates

`fsWrite mode: overwrite` replaces `status.json` in one call. Never partial writes — concurrent runs could read a half-written file. When appending to `errors`: `fsRead` → append in memory → `fsWrite` whole.

## Archive step (the cleanup-equivalent for folder-per-meeting)

After Librarian acknowledges the write (step `written`), the archive step does the following — all via the Drive MCP, not by manipulating sandbox files:

1. **Strip the `_processing_` prefix** from the Drive folder name (back to the original visible name).
2. **Move the folder** out of `{{inbox_folder}}` into the sibling `archive/` folder. Find or create `archive/` once per run via `list_files` (same parent as inbox). The Drive MCP `update_file` accepts `addParents` / `removeParents` to move.
3. **Upload `transcript.json`** to the archived meeting folder. Source: `/workspace/meetings/<meetingId>/raw_transcript.json` on the sandbox volume. Read via `fsRead`, then `create_file` to Drive with `parents: [<archivedFolderId>]`.
4. **Upload `notes.md`** if it exists (meeting-extract produces it for customer meetings).
5. **Upload a final `status.json`** snapshot to the archived folder — useful for forensics.
6. **Delete the local audio**: `rm /workspace/meetings/<meetingId>/audio.*` via `shellExec`. The other sandbox artefacts stay on the volume for 7 days as a debug cache.

Then set `step: "archived"` then `step: "done"` and exit.

## What this skill is NOT for

- Cross-meeting orchestration.
- Long-term cleanup of `/workspace/meetings/` (handled by an out-of-scope sweeper).
- Drive folder creation outside `{{inbox_folder}}` and its sibling `archive/`. No other Drive locations are touched.
