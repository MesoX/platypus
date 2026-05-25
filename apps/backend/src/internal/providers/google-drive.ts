import type { McpRow, RefreshedToken, ResourceProvider } from "./types.ts";

const DRIVE_FILE_URL = "https://www.googleapis.com/drive/v3/files";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

export const googleDriveProvider: ResourceProvider = {
  id: "google-drive",

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
