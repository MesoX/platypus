---
name: notify-user
description: How to send a Platypus notification to the workspace at key pipeline milestones — meeting claimed, transcription complete, MemPalace write complete, or any failure. Uses the createNotification tool (title + body only — no severity field, no metadata field).
---

# When and how to notify the user

The orchestrator pings the workspace at four moments. Each notification is short. Use the `createNotification` tool from the `notifications` tool set. The tool accepts exactly two fields:

- `title` — optional, max 200 chars
- `body` — required, max 2000 chars, supports minimal markdown

There is no `severity`, `metadata`, `link`, or any other field. Do not pass them.

## Convention

Encode severity and structured fields by prefixing the title and using markdown lists in the body:

- Success titles start with the action: `"Claimed:"`, `"Transcribed:"`, `"Saved:"`.
- Failure titles start with `"FAILED:"` in uppercase. That is the only signal of error severity.

## Trigger points

### 1. Claimed — a new meeting picked up

```
title: "Claimed: <folderName>"
body: |
  Started processing meeting **<folderName>**.

  - Meeting id: `<meetingId>`
  - Audio file: `<audioFilename>` (<human-size>)
```

Fire exactly once, right after the audio download succeeds (`downloaded` state).

### 2. Transcribed — WhisperX returned

```
title: "Transcribed: <folderName>"
body: |
  WhisperX finished in <duration> seconds.

  - Segments: <segment-count>
  - Speakers: <speaker-count>
  - Detected language: <detected-lang>
```

Fire once, after `raw_transcript.json` is validated.

### 3. Written — drawers landed in MemPalace

```
title: "Saved: <folderName>"
body: |
  Meeting saved to MemPalace.

  - Wing: **<primary-wing>**
  - Drawers written: <N>
  - KG edges: <M>
  - Resolved action items: <K>
  - Event anchor: `<event_anchor_drawer_id>`

  Notes attached to the archived Drive folder.
```

Fire after `meeting-write` returns and `written.json` is saved.

### 4. Failed — any `*_failed` transition

```
title: "FAILED: <step> — <folderName>"
body: |
  <verbatim tool error message from errors[-1].message>

  - Step: `<step>`
  - Retry count: <errors.length>/3
  - State dir: `/workspace/meetings/<meetingId>/`
```

Fire **once per transition into `*_failed`**, not on every retry. If `errors.length` is already 3, change the title to `"GIVE-UP: <step> — <folderName>"` — the user needs to intervene.

## Hard rule: failures need real evidence

You may only send a `FAILED:` / `GIVE-UP:` notification when you have **the verbatim error string returned by a failed tool call** in the current run. Do not diagnose. Do not infer. Do not extrapolate from an empty result, a missing folder, or a successful "no work to do" exit.

If a tool succeeded and returned an empty list, that is **not** an error — it is normal "nothing to process" state. Silent-exit, do not notify.

If you are tempted to write text like "API disabled", "permission denied", "service down", or any other diagnosis: stop. Either you have the literal HTTP/error text from a tool, or you have nothing. Without a verbatim error string, do not send the notification.

When you do send a `FAILED:` notification, the body's first paragraph quotes the verbatim tool error. No paraphrase, no improvement, no extra interpretation.

## Rules

- One notification per event. Never duplicate.
- Never include secrets, tokens, OAuth ids, or full transcript text.
- If the notification tool call itself fails, log the failure and continue — do not let it block the pipeline step.

## What this skill is NOT for

- Chat messages back to the invoking user when the orchestrator was started from chat. Those go through the agent's normal chat response, not via notifications.
- Status spam at every step transition. Four events only.
