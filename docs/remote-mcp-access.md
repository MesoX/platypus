# Remote MCP server access via `*.localhost` trick

## Problem

When the Platypus backend and an MCP server (e.g. `workspace-mcp`) live on a remote host, and you access the UI via SSH port forwarding, you hit an MCP OAuth 2.1 resource validation failure:

```
Protected resource http://localhost:8765/mcp does not match expected http://workspace-mcp:8000/mcp (or origin)
```

The MCP SDK enforces an **origin match** (scheme + host + port) between:

- the URL stored in Platypus DB (`mcp.url`, what the backend container uses to reach the MCP server), and
- the `resource` URL the MCP server advertises in its `/.well-known/oauth-protected-resource` metadata (what the browser must hit during the OAuth dance).

These two URLs are intrinsically asymmetric in a remote-dev setup:

- Backend container reaches the MCP server via the docker network: `http://workspace-mcp:8000`.
- Your browser reaches it via SSH port forwarding: `http://localhost:8765`.

Different origins → MCP SDK rejects.

## Workaround

Use a single URL whose host both ends can resolve to a reachable destination, by abusing the special-cased `.localhost` TLD:

| Endpoint                                           | Resolves to                                                                                                 |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Your browser → `workspace-mcp.localhost:8765`      | `127.0.0.1` (browser auto-resolves `*.localhost` per RFC 6761), then through your SSH tunnel for port 8765. |
| Backend container → `workspace-mcp.localhost:8765` | host gateway (via `extra_hosts`), reaching the host's bound port 8765.                                      |

Both sides see the same origin → MCP SDK validation passes.

## Enabling the workaround

1. **Bind the MCP server's host port to all interfaces** (not just `127.0.0.1`) so the docker host gateway can reach it. Example in the MCP server's compose:

   ```yaml
   ports:
     - "0.0.0.0:8765:8000"
   ```

2. **Set `WORKSPACE_EXTERNAL_URL`** (or the equivalent env var on whatever MCP server you run) to the `.localhost` URL:

   ```
   WORKSPACE_EXTERNAL_URL=http://workspace-mcp.localhost:8765
   ```

   This makes the server advertise that URL in its protected-resource and authorization metadata.

   **Patch required for the MCP Python library.** Upstream `mcp` (the official `modelcontextprotocol` Python SDK that FastMCP-based servers depend on) only allows literal `localhost` or `127.0.0.1` as the host for non-HTTPS issuer URLs. `*.localhost` is rejected with `Issuer URL must be HTTPS`. Patch `mcp/server/auth/routes.py` to also accept hosts ending in `.localhost`. The diff is one line:

   ```python
   # in mcp/server/auth/routes.py, around line 38
   and url.host != "localhost" and not (url.host or "").endswith(".localhost")
   ```

   The workspace-mcp deployment mounts a patched copy of `routes.py` over the venv path; see `patches/routes.py` and the `volumes:` entry in `compose.stateless.yaml`.

3. **Add the backend `extra_hosts` entry** by overlaying `compose.remote-mcp.yaml`:

   ```bash
   docker compose -f compose.yaml -f compose.sandbox.yaml -f compose.remote-mcp.yaml up -d backend
   ```

   This injects `workspace-mcp.localhost:host-gateway` into the backend container's `/etc/hosts`, pointing it at the host gateway IP.

4. **Set the MCP row's URL in the Platypus DB** to match:

   ```sql
   UPDATE mcp SET url = 'http://workspace-mcp.localhost:8765/mcp' WHERE id = '<mcp-id>';
   ```

5. **Add the Google OAuth callback URI** at `console.cloud.google.com/apis/credentials` for the OAuth 2.0 client:

   ```
   http://workspace-mcp.localhost:8765/oauth2callback
   ```

6. **Forward the host port over SSH** as part of your normal tunnel:

   ```
   ssh -L 3010:localhost:3010 -L 4010:localhost:4010 -L 8765:localhost:8765 user@host
   ```

7. **Reauthorize the MCP** in the Platypus UI. The OAuth flow should now complete cleanly.

## Disabling the workaround (when co-located with the server)

When you can reach the server directly on its LAN — no SSH tunnel — switch to a plain LAN URL that both your browser and the backend container can resolve to the same address:

1. **Drop the `-f compose.remote-mcp.yaml` overlay** when bringing the stack up. The `extra_hosts` entry is gone.

2. **Set `WORKSPACE_EXTERNAL_URL`** on the MCP server to the server's LAN IP:

   ```
   WORKSPACE_EXTERNAL_URL=http://192.168.2.174:8765
   ```

3. **Update the MCP row's URL**:

   ```sql
   UPDATE mcp SET url = 'http://192.168.2.174:8765/mcp' WHERE id = '<mcp-id>';
   ```

4. **Replace the Google OAuth callback URI** with the LAN equivalent:

   ```
   http://192.168.2.174:8765/oauth2callback
   ```

   (Keep the `.localhost` one if you still occasionally work remote.)

5. **Reauthorize** in the UI. The remote-dev workaround is now fully disengaged.

## Why this is in a separate branch

The `extra_hosts` line couples the compose file to a specific external service hostname. It belongs in your local remote-dev overlay, not on `main`. If you keep working remote against the same host, leave this branch checked out; otherwise merge it only when convenient and gate the overlay behind your team's deployment docs.
