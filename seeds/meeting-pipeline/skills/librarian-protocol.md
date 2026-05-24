---
name: librarian-protocol
description: The contract for talking to the Librarian sub-agent — Librarian is the sole reader and writer of MemPalace. Meeting agents must never touch the MemPalace MCP directly; every read and write goes through this protocol. Covers dedup, context gathering, drawer writes, KG edges, and resolved action items.
---

# Talking to the Librarian sub-agent

Librarian owns MemPalace. The meeting agents (orchestrator, extract, write) must call Librarian as a sub-agent for every MemPalace read or write — no exceptions.

Each request is a JSON object passed as the user message to Librarian. Librarian responds with a JSON object on the same schema as below. Wrap natural-language prose around the JSON when necessary, but the JSON block must be parseable.

## Request types

### 1. `find_event_anchor` — dedup check before processing

```json
{
  "type": "find_event_anchor",
  "calendar_event_id": "abc123…",
  "adhoc_dedup_key": null
}
```

For ad-hoc meetings: pass `calendar_event_id: null` and `adhoc_dedup_key: "<sha256-hex-of-filename-plus-timestamp>"`.

Librarian returns:

```json
{
  "type": "find_event_anchor",
  "found": true,
  "drawer_id": "drw_…",
  "wing": "[Customer]",
  "room": "<stream-room-or-meetings>"
}
```

or `{ "type": "find_event_anchor", "found": false }`.

If `found: true`, the pipeline stops processing this recording — it has already been ingested. Cleanup runs as normal.

### 2. `search_context` — gather palace context for extract

```json
{
  "type": "search_context",
  "calendar": {
    /* the calendar.json content */
  },
  "transcript_excerpt": "<first 2000 chars of the corrected transcript>",
  "include": [
    "customer_wing",
    "open_action_items",
    "stream_definitions",
    "terminology"
  ]
}
```

Librarian returns the relevant slices from MemPalace, scoped to what the extract step needs:

```json
{
  "type": "search_context",
  "customer_wing": {
    "wing_name": "Orange",
    "rooms": ["context", "jsm-assets", "cmdb-migration"]
  },
  "open_action_items": [
    {
      "drawer_id": "drw_…",
      "action": "Prepare JSM Assets CMDB migration plan for Orange",
      "owner": "frantisek",
      "due": "2026-05-30"
    }
  ],
  "stream_definitions": [ /* … */ ],
  "terminology": [
    { "wrong": "JSM esets", "right": "JSM Assets" },
    …
  ]
}
```

Empty arrays are valid responses — just means MemPalace has nothing relevant yet.

### 3. `write_extraction` — apply approved extraction

```json
{
  "type": "write_extraction",
  "event_anchor": {
    /* drawer body */
  },
  "drawers": [
    /* additional drawers: facts, insights, methods */
  ],
  "kg_edges": [
    /* event → produced-knowledge links */
  ],
  "resolved_action_items": [
    {
      "drawer_id": "drw_…",
      "resolved_at": "2026-05-11T15:00:00+02:00",
      "resolved_note": "Migration plan delivered in this meeting"
    }
  ]
}
```

All drawer bodies must be in **English** (translation happens in the extract step, before the call). Action item language must include both product/system name and customer name (e.g. "Prepare JSM Assets CMDB migration plan for Orange").

Librarian returns:

```json
{
  "type": "write_extraction",
  "written": {
    "event_anchor_drawer_id": "drw_…",
    "additional_drawer_ids": ["drw_…", …],
    "kg_edge_ids": ["edge_…", …],
    "resolved_action_items": [ /* same shape as input */ ]
  }
}
```

If Librarian refuses any item (e.g. confidentiality flag mismatch, drawer schema violation), the response contains a `refused` array — relay refusals back up to the orchestrator, do not silently drop.

## Rules

- **Never** attach the MemPalace MCP directly to a meeting agent — only to Librarian.
- **Never** send drawer bodies containing untranslated source-language text. English in, English out.
- **Never** pass full transcripts to Librarian — only the excerpt needed for context search. Token budget matters.
- **Always** include `calendar_event_id` on writes, on both the event anchor drawer and the KG edges. This is the dedup key.
- If Librarian's response is not parseable JSON, treat it as a hard error — surface to user, do not retry without a different prompt.

## What this skill is NOT for

- Direct MemPalace MCP usage.
- Cross-wing search outside the explicit `include` list — that lives in the future `meeting-connect` agent.
