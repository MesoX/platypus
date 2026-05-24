---
name: notify-user
description: How to send a Platypus notification to the workspace owner at key pipeline milestones — meeting claimed, transcription complete, MemPalace write complete, or any failure. Notifications are short, structured, and link to the meeting's state directory for follow-up.
---

# When and how to notify the user

The orchestrator pings the workspace owner at four moments. Notifications are short (one line summary + a couple of structured fields). The user reads them in the Platypus notifications panel and in any configured push channel.

Use the `notifications` tool set's `createNotification` (or equivalent) tool. Pass:

- `title` — under 80 chars, no trailing punctuation
- `body` — 1–3 sentences, concrete facts only
- `severity` — `"info"` for successes, `"error"` for failures
- `metadata` — JSON with structured fields the panel can show

## Trigger points

### 1. Claimed — a new meeting picked up

Severity: `info`

```
title: "New meeting picked up: <folderName>"
body:  "Started processing meeting <folderName> (id <meetingId>). Audio file: <audioFilename>, size <human-size>."
metadata: { event: "claimed", meeting_id, drive_folder_id }
```

Fire exactly once, right after the audio download succeeds (`downloaded` state).

### 2. Transcribed — WhisperX returned

Severity: `info`

```
title: "Transcript ready: <folderName>"
body:  "WhisperX finished in <duration> seconds. <segment-count> segments, <speaker-count> speakers, language <detected-lang>."
metadata: { event: "transcribed", meeting_id, duration_s, segments, speakers, language }
```

Fire once, after `raw_transcript.json` is validated.

### 3. Written — drawers landed in MemPalace

Severity: `info`

```
title: "Meeting saved to MemPalace: <folderName>"
body:  "<N> drawers written, <M> KG edges, <K> resolved action items. Wing: <wing>. View notes in the archived folder."
metadata: {
  event: "written",
  meeting_id,
  event_anchor_drawer_id,
  drawer_count, edge_count, resolved_count,
  primary_wing
}
```

Fire after the `meeting-write` sub-agent returns and `written.json` is saved.

### 4. Failed — any `*_failed` transition

Severity: `error`

```
title: "Meeting pipeline failed at <step>: <folderName>"
body:  "<one-sentence error from errors[-1].message>. Retry count: <errors.length>/3. State dir: /workspace/meetings/<meetingId>/."
metadata: {
  event: "failed",
  meeting_id,
  step,
  retry_count,
  last_error_message
}
```

Fire **once per transition into `*_failed`**, not on every retry. If `errors.length` is already 3 after this run, change the title to `"Meeting pipeline gave up at <step>: <folderName>"` and add `give_up: true` to metadata — the user needs to intervene.

## Rules

- One notification per event. Never duplicate.
- Never include secrets, tokens, OAuth ids, or full transcript text in body or metadata.
- Body must be parseable by a human glancing at a phone notification — pack the most useful fact first.
- If the notification tool call itself fails, log the failure and continue — do not let it block the pipeline step.

## What this skill is NOT for

- Chat messages back to the invoking user when the orchestrator was started from chat. Those go through the agent's normal chat response, not via notifications.
- Status spam at every step transition. Four events only.
