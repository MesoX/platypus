---
name: calendar-match
description: How to find the Google Calendar event that a meeting recording belongs to, using the recording's filename timestamp and a priority-ordered match against the user's calendar. Outputs a JSON bundle the downstream extract agent uses to anchor the event.
---

# How to match a meeting recording to a calendar event

## Extract the timestamp from the filename

Recording filenames carry an ISO-ish timestamp, e.g.

```
Meeting_2026-05-11_14-00-00.wav
Hovor_2026-05-11_14-00.m4a
recording-2026-05-11T14-00-00.wav
```

Parse out year, month, day, hour, minute (and second if present). Treat the parsed time as **local** to the workspace's configured timezone unless the filename ends with `Z` or contains an explicit `+HH:MM` offset. If you cannot parse a timestamp, set `recording_timestamp: null` and proceed (the dedup step will handle ad-hoc meetings).

## Query the calendar

Use whichever Google Calendar MCP tool lists events in a time range (likely `list_events`, `search_events`, or similar — inspect available Calendar tools and pick the one whose description fits "list events between two times"). Call it with:

- `timeMin`: recording_timestamp − 15 minutes
- `timeMax`: recording_timestamp + 5 minutes
- `singleEvents: true`
- `orderBy: startTime`

Skip:

- All-day events (`start.date` present, `start.dateTime` absent).
- Events where the user's response status is `declined`.
- Events with no `id` or no attendees and no organizer (most likely calendar artefacts).

## Pick one

Apply this priority when multiple events match:

1. The user is **organizer** (`organizer.self === true`), response `accepted` or unset.
2. The user has explicitly **accepted** (`responseStatus === 'accepted'`).
3. The user is **tentative** (`responseStatus === 'tentative'`).

Within the same priority bucket, prefer the event whose `start.dateTime` is closest to the filename timestamp.

If no event survives the filter, this is an **ad-hoc meeting** — emit `match: null` with the parsed timestamp. The dedup step uses `hash(filename + timestamp)` as the event anchor key instead of an `event_id`.

## Output

Save the result to `/workspace/meetings/<meetingId>/calendar.json`:

```json
{
  "match": {
    "event_id": "abc123…",
    "ical_uid": "…",
    "title": "Customer X — JSM Assets review",
    "start": "2026-05-11T14:00:00+02:00",
    "end": "2026-05-11T15:00:00+02:00",
    "organizer": { "email": "frantisek.spacek@morosystems.cz", "self": true },
    "attendees": [
      { "email": "…", "displayName": "…", "responseStatus": "accepted" },
      …
    ],
    "description": "<original event description, may be empty>",
    "html_link": "https://calendar.google.com/calendar/event?eid=…"
  },
  "recording_timestamp": "2026-05-11T14:00:00+02:00"
}
```

Or, for ad-hoc:

```json
{
  "match": null,
  "recording_timestamp": "2026-05-11T14:00:00+02:00",
  "filename": "Hovor_2026-05-11_14-00.m4a"
}
```

## Edge cases

- **Two adjacent meetings in the window.** Pick by the priority order above; if still tied, take the one whose start ≤ recording_timestamp. Recordings usually start at or just after the scheduled time.
- **Calendar API returns 0 events.** Either the timezone is off, the user hasn't accepted any event, or it's genuinely ad-hoc. Default to `match: null`.
- **Recurring event instance.** Use the specific instance's `id` (not the master id) — that is what's stable per occurrence and what the dedup step expects.

## What this skill is NOT for

- Reading attendees' calendars. Only the user's calendar is queried — never broaden this.
- Creating or modifying calendar events. Read-only.
