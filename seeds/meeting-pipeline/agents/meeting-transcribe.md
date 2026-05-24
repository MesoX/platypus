---
name: meeting-transcribe
description: Transcribe one already-downloaded meeting audio via local WhisperX. Reads status.json, runs curl, validates JSON, advances state. One-shot.
model_id: qwen36
max_steps: 8
temperature: 0.0
tool_sets:
  - sandbox
sub_agents: []
---

# Meeting transcribe

Single task: take a meeting whose `step` is `downloaded` (the audio file is already on disk) and run WhisperX over it. Save the response JSON. Advance state.

The orchestrator passes you a JSON message with `{ "meeting_id": "<id>" }`. That id is the workspace-relative directory name under `meetings/`.

## Tool names — verbatim

`shellExec`, `fsRead`, `fsWrite` (sandbox).

## Steps

1. `fsRead path: "meetings/<meeting_id>/status.json"`. Confirm `step == "downloaded"`. If not, return `ERROR: expected step=downloaded, got step=<actual>` and stop.
2. The status JSON has `drive_audio_original_name` (e.g. `meeting.wav`). The extension is the part after the last `.`. The audio is at `meetings/<meeting_id>/audio.<ext>`.
3. `shellExec` with `command: "curl -sS --fail-with-body -X POST '{{whisperx_url}}/transcribe' -F 'file=@meetings/<meeting_id>/audio.<ext>' -F 'language={{language_hint}}' -F 'max_speakers=10' -o 'meetings/<meeting_id>/raw_transcript.json'"` and `timeoutMs: 600000` (10 min hard cap).
4. `fsRead path: "meetings/<meeting_id>/raw_transcript.json"` with `lineRange: [1, 1]` — just peek at the first line to validate. The content must contain `"status":"success"`. If it contains `"error"`, `"detail"`, or anything not starting with `{`, return `ERROR: WhisperX returned: <first 200 chars>` and stop.
5. `fsRead` the full transcript again (no lineRange) just to count segments — actually skip this; we trust the validation in step 4. Just compute segment count later if needed.
6. `fsWrite path: "meetings/<meeting_id>/status.json"`, `mode: "overwrite"`, with the same JSON body you read in step 1 but `"step": "transcribed"`.
7. Return text: `Transcribed: meeting <meeting_id>. raw_transcript.json saved.`

If `shellExec` returns exit_code != 0, OR stderr contains "curl:" or "Failed", treat it as an error and return `ERROR: ` + the verbatim error.

## Rules

- Workspace-relative paths.
- `timeoutMs: 600000` is mandatory on the curl call. Transcription of a 60-min meeting takes 5-8 min.
- Do not retry. One call. If it fails, return the error.
