# Deployment Notes — Custom Patches

This file documents every change that lives on top of upstream
`willdady/platypus` (`origin/main`). Whenever you rebase, upgrade, or
rebuild the stack, apply or verify each section below.

Run `git log --oneline origin/main..HEAD` to see which commits are custom.

---

## 0. compose.yaml — port remaps

**Applied on server only** (not committed to this branch — server's `/srv/platypus` has a local commit for this).

The upstream `compose.yaml` maps backend→`4000:4000` and frontend→`3000:3000`. The deployed stack remaps them:

```yaml
# backend
ports:
  - "4010:4000"

# frontend
ports:
  - "3010:3000"
```

**Why:** Port 4010 and 3010 are used as the host-side ports to avoid conflicts with other services and to match the SSH tunnel config. If you ever run `docker compose up` fresh from upstream compose.yaml, apply these remaps before starting.

---

## 1. Frontend — SSH-tunnel / dynamic backend URL

**Commit:** `e26d95b`  
**File:** `apps/frontend/app/layout.tsx`

**What it does:** When `BACKEND_URL` is not set but `BACKEND_PORT` is, the
layout reads the incoming request's `Host` header at runtime and derives the
backend URL as `http://<hostname>:<BACKEND_PORT>`. This makes the app work
from any network (LAN IP, SSH tunnel, ngrok) without baking in an IP address
at build time.

**Why it is needed:** The DGX Spark is accessed over an SSH tunnel
(`ssh -L 3010:localhost:3010 ...`). The browser uses `localhost:3010`, so
the backend must be referenced as `localhost:4010`, not the LAN IP
`192.168.x.x:4010`. With only a static `BACKEND_URL` in the image the app
breaks the moment the access method changes.

**Deploy config:**

```
# apps/frontend .env or compose env block — do NOT set BACKEND_URL
BACKEND_PORT=4010
```

**Rebase note:** The upstream `fork/feature/internal-resource-proxy` branch
reverts this change back to a static `BACKEND_URL`. Do NOT merge that file's
`layout.tsx` diff.

---

## 2. MCP OAuth — skip strict resource-origin check

**Commit:** `852a54a`  
**File:** `apps/backend/src/services/mcp-oauth-provider.ts`

**What it does:** Overrides `validateResourceURL()` in
`DatabaseOAuthClientProvider` to trust whatever resource URL the server
advertises, instead of requiring it to match the URL we used to reach the
server.

**Why it is needed:** The Google Workspace MCP container
(`workspace-mcp:8000`) advertises `http://localhost:8765/mcp` as its
resource URL (the `WORKSPACE_EXTERNAL_URL`). The backend reaches it at
`http://workspace-mcp:8000/mcp`. Without this override `@ai-sdk/mcp` throws:
> Protected resource http://localhost:8765/mcp does not match expected
> http://workspace-mcp:8000/mcp (or origin)

---

## 3. MCP OAuth — `MCP_OAUTH_HOST_REWRITES` URL rewriting

**Commit:** `b24f623`  
**File:** `apps/backend/src/services/mcp-oauth-provider.ts`

**What it does:** Adds `parseHostRewrites()`, `rewriteUrl()`, and applies URL
rewriting inside `oauthFetchFn`. The rewrite list is read from the env var
`MCP_OAUTH_HOST_REWRITES` as comma-separated `from=to` pairs.

**Why it is needed:** OAuth discovery (`/.well-known/...`) and token exchange
are initiated by the backend, which cannot reach `localhost:8765` (that is a
browser-facing URL). The rewrite redirects those backend calls to the
internal Docker hostname.

**Deploy config:**

```
MCP_OAUTH_HOST_REWRITES=http://localhost:8765=http://workspace-mcp:8000
```

**Rebase note:** The upstream `fork/feature/internal-resource-proxy` branch
removes this entire feature from `mcp-oauth-provider.ts`. Do NOT merge that
file's diff without re-adding these functions.

---

## 4. MCP OAuth — force `client_secret_post` token-endpoint auth

**Commit:** `455a390` (+ `b9e0172` bind fix + `5c2fd38` sync fix)  
**File:** `apps/backend/src/services/mcp-oauth-provider.ts`

**What it does:** Adds `addClientAuthentication()` to
`DatabaseOAuthClientProvider`. This method injects `client_id` /
`client_secret` as POST body parameters and removes the `Authorization:
Basic` header, forcing the `client_secret_post` auth method.

**Why it is needed:** Some FastMCP-based servers (including the Google
Workspace MCP) advertise `client_secret_basic` support but do not actually
parse the `Authorization: Basic` header, returning a misleading
`invalid_client / Missing client_id` 401.

---

## 5. MCP OAuth — wire `oauthFetchFn` into transport config

**Commit:** `9ad424b`  
**File:** `apps/backend/src/services/mcp-oauth-provider.ts`

**What it does:** Sets `config.fetch = oauthFetchFn` inside
`buildMcpTransportConfig()` for OAuth-authenticated MCPs.

**Why it is needed:** `oauthFetchFn` (added in commit `b24f623`) rewrites
URLs and reconstructs `Response` objects. Without this line it was only
called during the OAuth authorize flow, not during actual MCP requests in
chat. The result was that the transport fell back to the raw `localhost:8765`
URL which the backend cannot reach.

---

## 6. Backend — internal Drive resource proxy

**Commit:** `c74f5ee`  
**Files:** `apps/backend/src/internal/proxy.ts`,
`apps/backend/src/internal/providers/{types,index,google-drive}.ts`,
`apps/backend/src/server.ts`

**What it does:** Adds a `/internal/resources/:provider/:workspaceId/:mcpId/:resourceId`
GET endpoint. The sandbox container calls it with a Bearer `INTERNAL_SECRET`
token to download Drive files (or future providers) using the workspace's
stored OAuth credentials. The proxy handles token refresh automatically.

**Why it is needed:** The sandbox container has no Google OAuth token. The
meeting pipeline needs to download audio files from Google Drive to
`/workspace/meetings/<id>/audio.*` before WhisperX transcription. This proxy
lets the sandbox call the backend, which holds the token, to stream the file.

**Deploy config:**

The `INTERNAL_SECRET` env var must be the same value in:
- the backend container (`INTERNAL_SECRET=<secret>`)
- the workspace sandbox env (`INTERNAL_SECRET=<secret>`, stored in the
  `sandbox.env` DB column — set via the Platypus UI Sandbox settings page)

The sandbox curl call looks like:
```bash
curl -sS \
  -H "Authorization: Bearer $INTERNAL_SECRET" \
  "http://host.docker.internal:4010/internal/resources/google-drive/<workspaceId>/<mcpId>/<fileId>" \
  -o /workspace/meetings/<meetingId>/audio.wav
```

---

## Sandbox — enable Docker backend

The sandbox tool set (`shellExec`, `fsRead`, `fsWrite`, `fsList`) requires
the Docker backend to be active. This is not a code change — it is a
compose overlay.

**Deploy with:**

```bash
cd /srv/platypus
docker compose -f compose.yaml -f compose.sandbox.yaml up -d
```

The overlay (`compose.sandbox.yaml`) adds:
- `PLATYPUS_SANDBOX_DOCKER_ENABLED=true` to the backend container
- `/var/run/docker.sock` bind-mount into the backend container

**Never** start with `compose.yaml` alone — the sandbox tools will silently
disappear and agents will fail with `shellExec unavailable`.

---

## SSH tunnel ports

The full tunnel command for working from another machine:

```bash
ssh -L 3010:localhost:3010 \
    -L 4010:localhost:4010 \
    -L 8765:localhost:8765 \
    -p 1240 franazbrna@potatoes-citations.with.playit.plus
```

| Local port | Maps to | Service |
|---|---|---|
| 3010 | server:3010 | Platypus frontend (Next.js) |
| 4010 | server:4010 | Platypus backend (Hono) |
| 8765 | server:8765 | Google Workspace MCP (OAuth popup) |

Port 8765 is only needed when (re-)authorizing the Google Workspace MCP in
the browser. The popup opens `http://localhost:8765/authorize?...`.

---

## Rebuild checklist

After pulling a new upstream version:

1. `git fetch origin && git rebase origin/main` — rebase our 8 commits
2. Resolve any conflicts; priority files: `mcp-oauth-provider.ts`,
   `layout.tsx`, `server.ts`
3. Re-check the **Rebase notes** in sections 1 and 3 above
4. On the server: `cd /srv/platypus && git pull`
5. Rebuild backend image:
   ```bash
   docker build -f apps/backend/Dockerfile -t willdady/platypus-backend:latest .
   ```
6. Restart with sandbox overlay:
   ```bash
   docker rm -f platypus-backend-1
   docker compose -f compose.yaml -f compose.sandbox.yaml up -d backend
   ```
7. Verify in backend logs: `"Docker sandbox backend registered"` appears on startup
