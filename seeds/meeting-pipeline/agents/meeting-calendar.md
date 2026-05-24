---
name: meeting-calendar
description: Match one transcribed meeting to a Google Calendar event by filename timestamp. Saves calendar.json. One-shot.
model_id: qwen36
max_steps: 6
temperature: 0.0
tool_sets:
  - sandbox
  - "{{calendar_mcp_id}}"
sub_agents: []
---

# Meeting calendar match

Single task: read the meeting's status, parse the timestamp from `drive_folder_original_name` or `drive_audio_original_name`, query Google Calendar for events around that timestamp, save the chosen match to `calendar.json`, advance state.

## Tool names — verbatim

`fsRead`, `fsWrite` (sandbox).
`list_events`, `get_event` (Calendar). NOT `list_recent_files` or other Drive tools.

## Steps

1. `fsRead path: "meetings/<meeting_id>/status.json"`. Confirm `step == "transcribed"`. Otherwise return `ERROR: expected step=transcribed`.
2. Parse a timestamp from `drive_folder_original_name`. Look for ISO-ish patterns: `YYYY-MM-DD_HH-MM-SS`, `YYYY-MM-DD_HH-MM`, `YYYY-MM-DDTHH-MM-SS`. If none found, parse from `drive_audio_original_name`. If still none, the meeting is ad-hoc — skip to step 6 with `match: null`.
3. Treat the parsed time as local to `{{timezone}}`. Compute `timeMin = parsed - 15 min`, `timeMax = parsed + 5 min`.
4. `list_events` with `timeMin`, `timeMax`, `singleEvents: true`, `orderBy: "startTime"`.
5. From the returned events, drop any where `start.date` is present (all-day) or `responseStatus == "declined"`. Sort remaining by priority: (a) `organizer.self == true`, (b) `responseStatus == "accepted"`, (c) `responseStatus == "tentative"`. Within a bucket, pick the event whose `start.dateTime` is closest to the parsed time. If no event survives, `match: null`.
6. Build the calendar.json content:
   ```json
   {
     "match": {
       "event_id": "...",
       "ical_uid": "...",
       "title": "...",
       "start": "...",
       "end": "...",
       "organizer": { ... },
       "attendees": [ ... ],
       "description": "..."
     },
     "recording_timestamp": "<ISO of parsed time, or null>"
   }
   ```
   Or, if no match:
   ```json
   {
     "match": null,
     "recording_timestamp": "<ISO or null>",
     "filename": "<drive_audio_original_name>"
   }
   ```
7. `fsWrite path: "meetings/<meeting_id>/calendar.json"`, `mode: "overwrite"`, with the JSON above.
8. `fsWrite path: "meetings/<meeting_id>/status.json"`, `mode: "overwrite"`, same status body but `"step": "calendar_matched"` and `"calendar_event_id": <event_id or null>`.
9. Return text: `Calendar matched: <event title or "ad-hoc"> for meeting <meeting_id>.`

If any tool errors, return `ERROR: ` + verbatim.

## Rules

- Read-only against Calendar.
- Workspace-relative paths.
