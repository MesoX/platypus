import type { McpRow, RefreshedToken, ResourceProvider } from "./types.ts";

const DRIVE_FILE_URL = "https://www.googleapis.com/drive/v3/files";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

/**
 * Google Drive file download provider.
 *
 * Maps the proxy's `resourceId` to a Drive file ID and streams the file
 * bytes via the Drive v3 `files.get?alt=media` endpoint.
 */
export const googleDriveProvider: ResourceProvider = {
  id: "google-drive",

  // Drive file IDs are URL-safe base64-ish identifiers. The pattern below
  // accepts the character set Google uses today and rejects everything
  // else, blocking path traversal or URL injection via the resource ID.
  resourceIdPattern: /^[A-Za-z0-9_-]{8,128}$/,

  buildUpstream(record, resourceId) {
    return {
      url: `${DRIVE_FILE_URL}/${encodeURIComponent(resourceId)}?alt=media`,
      headers: {
        Authorization: `Bearer ${record.oauthAccessToken}`,
      },
    };
  },

  async refreshToken(record: McpRow): Promise<RefreshedToken | null> {
    if (
      !record.oauthRefreshToken ||
      !record.oauthClientId ||
      !record.oauthClientSecret
    ) {
      return null;
    }

    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: record.oauthRefreshToken,
      client_id: record.oauthClientId,
      client_secret: record.oauthClientSecret,
    });

    try {
      const res = await fetch(GOOGLE_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body,
      });
      if (!res.ok) return null;
      const payload = (await res.json()) as {
        access_token: string;
        expires_in?: number;
      };
      return {
        accessToken: payload.access_token,
        expiresInSeconds: payload.expires_in,
      };
    } catch {
      return null;
    }
  },
};
