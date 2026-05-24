---
name: drive-proxy
description: How to fetch the raw bytes of a Google Drive file from the workspace sandbox, using the Platypus internal-resource-proxy with the workspace-scoped OAuth credentials. Use this when the model needs a file's content (audio, document, image) but not its metadata — metadata calls go through the Google Drive MCP tool, never through this proxy.
---

# How to download a Drive file from the sandbox

The Platypus backend exposes an authenticated proxy that streams Drive files using the workspace's stored OAuth token. The sandbox container reaches it via `host.docker.internal:{{backend_port}}`.

## The call

Inside `shellExec`:

```bash
curl -sS \
  -H "Authorization: Bearer $INTERNAL_SECRET" \
  "{{backend_url}}/internal/resources/google-drive/{{workspace_id}}/{{drive_mcp_id}}/<fileId>" \
  -o /workspace/<dest-path>
```

Substitute:

- `<fileId>` — Google Drive file id, e.g. `1aUXhbp6nzXTG7pGHdNsTzJTOqzLhsTLg`.
- `<dest-path>` — workspace-relative path where you want the bytes saved.

`$INTERNAL_SECRET` is set by the workspace's Sandbox env (workspace-default env, never visible in tool args or transcripts).

## Verifying

After the call, check the file exists and is non-empty:

```bash
ls -la /workspace/<dest-path>
file /workspace/<dest-path> 2>/dev/null || head -c 64 /workspace/<dest-path>
```

## Errors

| Curl `%{http_code}` | Meaning                                 | What to do                                                                      |
| ------------------- | --------------------------------------- | ------------------------------------------------------------------------------- |
| 200                 | Success                                 | Continue.                                                                       |
| 401                 | Bad secret or expired/missing MCP token | Stop and surface to the user — the workspace's Drive integration needs re-auth. |
| 400                 | Bad provider or malformed file id       | Recheck the file id (Drive ids are `[A-Za-z0-9_-]{8,128}`).                     |
| 404                 | Workspace/MCP/file id mismatch          | Recheck ids; do not retry blindly.                                              |
| 5xx                 | Backend or Drive transient              | Retry once with a 5 s delay, then surface.                                      |

## What this skill is NOT for

- File **listing** (`files.list`) — use the Drive MCP `list_files` tool.
- File **rename / move** — use the Drive MCP `update_file` tool.
- Anything but byte streaming.
