---
name: state-machine
description: The per-meeting state directory layout, the status.json schema, and the rules for resuming a pipeline that was interrupted mid-run. The orchestrator must consult status.json on every step and update it atomically before advancing.
---

# Per-meeting state on the sandbox volume

State lives at `/workspace/meetings/<meetingId>/`. The directory persists across sandbox restarts (it is on the workspace volume, ADR-0001). The directory is the source of truth — if it is gone, the meeting is forgotten; if it is present, the orchestrator can pick up exactly where the previous run left off.

## Directory layout

```
/workspace/meetings/<meetingId>/
  status.json              ← current step + meta (always present)
  audio.<ext>               ← the downloaded file (deleted at cleanup)
  raw_transcript.json       ← WhisperX response
  corrected_transcript.json ← only present once meeting-correct lands (future)
  calendar.json             ← match output
  context.json              ← only present once meeting-context lands (future)
  extraction.json           ← proposed drawer list + KG edges (output of meeting-extract)
  written.json              ← written drawer IDs returned by Librarian
```

The orchestrator never writes raw transcripts or extractions itself — those are written by the skill that produced them.

## `status.json` schema

```json
{
  "meeting_id": "<driveFileId>",
  "drive_file_id": "<driveFileId>",
  "original_name": "Meeting_2026-05-11_14-00-00.wav",
  "claimed_at": "2026-05-11T14:35:12+02:00",
  "step": "claimed",
  "calendar_event_id": null,
  "adhoc_dedup_key": null,
  "errors": []
}
```

`step` is the enum below. `errors` is an append-only list of `{ at, step, message }` records — every retryable failure adds an entry, the array never resets.

## Step enum (vertical slice)

```
claimed
  → downloaded
    → transcribed
      → calendar_matched
        → dedup_checked
          → extracted
            → written
              → cleaned
                → done
```

Failure states are terminal-with-recovery: when an exception occurs at step X, set `step: "<x>_failed"` and append to `errors`. The next trigger run picks up from `<x>_failed`, decides whether to retry (re-run X) or surface to the user (after 3 attempts).

There is no separate `processing` step — the orchestrator runs one step per turn and writes the _post_-step status before the next step starts.

## Resume rules

On every orchestrator run, before doing anything else:

1. List `/workspace/meetings/` and pick directories with `step` ∈ `{claimed, downloaded, transcribed, calendar_matched, dedup_checked, extracted, written, cleaned}` (i.e. not `done`, not `*_failed` with `errors.length >= 3`).
2. Process at most **one** meeting per run unless the orchestrator was triggered with `mode: scan_inbox` AND there are zero in-flight meetings — only then claim a new one from the inbox.
3. Advance one step. Update `status.json`. Exit.

Single-step-per-run keeps the `shellExec` 600-second cap from blocking the orchestrator on long WhisperX calls (transcription is its own step).

## Updating status.json atomically

Use `fsWrite` with `mode: "overwrite"` to swap the file in one call. Never edit in place — concurrent runs could partially read it.

When appending to `errors`, read the file first via `fsRead`, append to the in-memory array, then `fsWrite` the whole new object.

## Cleanup

After Librarian acknowledges the write (status `written`), run the cleanup step:

- Delete the original Drive file (`Drive MCP update_file` → trash or `delete_file`).
- Remove the local audio: `rm /workspace/meetings/<meetingId>/audio.*`.
- Keep the rest of the directory (transcripts, calendar.json, extraction.json, status.json) for at least 7 days — useful for debugging.
- Set `step: "cleaned"` then `step: "done"` and exit.

## What this skill is NOT for

- Cross-meeting orchestration. The state machine is per-meeting. Coordination between meetings is the orchestrator's job, not the state machine's.
- Long-term archival. After 7 days, an out-of-scope job sweeps `done` directories.
