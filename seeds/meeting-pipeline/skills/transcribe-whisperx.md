---
name: transcribe-whisperx
description: How to send an already-downloaded audio file to the local WhisperX service from inside the sandbox, save the JSON response, and verify it before moving on. Handles the long synchronous request that WhisperX returns once transcription and diarization are done.
---

# How to transcribe an audio file with WhisperX

WhisperX runs on the same host as Platypus and is reachable at `{{whisperx_url}}` from inside the sandbox. The service is sequential FIFO — concurrent requests queue behind whichever one is currently running. A 60-minute meeting typically takes 5–8 minutes.

## Pre-checks

The audio file must already exist on the sandbox volume (see `inbox-claim`). Confirm before submitting:

```bash
ls -la /workspace/meetings/<meetingId>/audio.*
```

If the file is empty or missing, **do not** call WhisperX — re-run the download step.

## The call

```bash
curl -sS -w "\nHTTP=%{http_code} TIME=%{time_total}s\n" \
  -X POST "{{whisperx_url}}/transcribe" \
  -F "file=@/workspace/meetings/<meetingId>/audio.<ext>" \
  -F "language={{language_hint}}" \
  -F "max_speakers=10" \
  -o /workspace/meetings/<meetingId>/raw_transcript.json
```

Field names matter — WhisperX expects exactly `file`, `language`, `min_speakers`, `max_speakers`.

## Long timeouts

`shellExec` has a 60-second default timeout and a 600-second hard cap. For meetings, pass `timeoutMs: 600000` explicitly. If transcription is likely to exceed 10 minutes (long meeting, queue behind another run), see the recovery section below.

## Validate the response

After the curl returns, confirm:

```bash
wc -c /workspace/meetings/<meetingId>/raw_transcript.json
head -c 80 /workspace/meetings/<meetingId>/raw_transcript.json
```

A valid response starts with `{"status":"success","language":"…","segments":[…`. If the body is empty, very short (under ~200 bytes), or starts with `{"error"` or `{"detail"`, treat it as a transcription failure — do not pass it downstream. Surface the error verbatim to the user.

## Recovery — request died but WhisperX is still chewing

If the call timed out from `shellExec` but the WhisperX container is still processing (its logs show `Step 1/2/3:`), do **not** immediately retry — that just queues a second copy of the same file behind it. Wait for the in-flight request to complete (the previous response will be discarded by WhisperX because the client is gone), then re-submit once.

## Output shape (for downstream extract)

The JSON the extract agent consumes:

```
{
  "status": "success",
  "language": "cs",
  "segments": [
    {
      "start": 0.031,
      "end": 17.98,
      "text": "Takže já jsem tady připravil…",
      "speaker": "SPEAKER_01",
      "words": [
        { "word": "Takže", "start": 0.031, "end": 3.533, "score": 0.578, "speaker": "SPEAKER_01" },
        …
      ]
    },
    …
  ]
}
```

Speaker labels are assigned at the word level. Aggregation into per-speaker turns happens later in the pipeline if needed.

## What this skill is NOT for

- Real-time / streaming transcription. WhisperX in this deployment is offline only.
- Translation. WhisperX returns text in the source language; translation to English happens inside the extract step.
