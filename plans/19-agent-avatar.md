# Plan: Agent Avatar Upload

## Context

Users want to personalise agents with an avatar image, making them visually distinguishable. The image must be stored using the existing storage backend (disk or S3-compatible), served through the existing `/files/*` proxy endpoint, and rendered as a rounded square in the UI.

---

## Approach

### Image Processing

Install `sharp` in `apps/backend` to handle server-side image processing:

- Accept JPEG, PNG, WebP, GIF uploads (max 5 MB raw)
- Reject images smaller than 64×64 px
- Center-crop to square, resize to 512×512, output as WebP

Storage key: `{orgId}/{workspaceId}/agents/{agentId}/avatar.webp`
This slots into the existing `/files/*` auth pattern (first two path segments are orgId/workspaceId).

### Data Model

Store only `avatarKey` (the storage key) in the DB. Compute `avatarUrl` (HTTP URL) at read time using the same `STORAGE_PUBLIC_URL` logic already used for chat file URLs. Expose `avatarUrl` in API responses; never expose `avatarKey` to the client.

### Form UX

- Avatar upload is available in both create and edit forms
- User selects a file → stored in component state as a `File` object, previewed locally using `URL.createObjectURL`
- On form save: agent is created/updated first, then the avatar is uploaded in a second request if a file was selected
- In the edit form, the current avatar (from `agent.avatarUrl`) is shown; a new selection overrides the preview
- Clicking the avatar area opens the file picker
- Rendered as a rounded square (Tailwind `rounded-2xl`)

---

## Files to Modify / Create

### Backend

1. **`apps/backend/package.json`** — add `sharp` dependency

2. **`apps/backend/src/db/schema.ts`** — add `avatarKey` column to `agent` table:

   ```ts
   avatarKey: t.text("avatar_key"),
   ```

3. **`packages/schemas/index.ts`** — add `avatarUrl` to `agentSchema` (optional string); do NOT add it to create/update schemas (it's computed server-side):

   ```ts
   avatarUrl: z.string().optional(),
   ```

4. **`apps/backend/src/routes/agent.ts`** — several changes:
   - Add a helper `agentWithAvatarUrl(agent, baseUrl)` that converts `avatarKey` → `avatarUrl` using `STORAGE_PUBLIC_URL` or `{baseUrl}/files/{key}`, then omits `avatarKey` from the response object
   - Wrap all existing GET responses through this helper
   - Add `POST /:agentId/avatar` — multipart upload endpoint:
     - Validate file type (image/jpeg, image/png, image/webp, image/gif) and raw size (≤ 5 MB)
     - Process with `sharp`: center-crop to square, resize to 512×512, output WebP
     - Reject if source image is smaller than 64×64 px
     - Delete old avatar from storage if `avatarKey` already exists
     - Store new file via `getStorage().put(key, buffer, "image/webp")`
     - Update `agent.avatarKey` in DB
     - Return agent with computed `avatarUrl`
   - Add `DELETE /:agentId/avatar` — removes avatar file from storage and clears `avatarKey` on the agent record
   - Modify existing `DELETE /:agentId` — also delete avatar from storage before removing the DB record

### Frontend

5. **`apps/frontend/components/agent-form.tsx`** — add avatar state and UI:
   - Add state: `avatarFile: File | null` (newly selected) and `avatarPreviewUrl: string | null`
   - On file input change: set state, generate object URL for preview (revoke previous object URL to avoid leaks)
   - In the form submit handler: after agent create/update, if `avatarFile` is set, POST to `/:agentId/avatar` as `multipart/form-data`; mutate SWR cache
   - Render avatar area above the Name field: a `~80px` rounded-square (`rounded-2xl`) showing either the preview URL, the current `agent.avatarUrl`, or a placeholder camera/image icon; clicking it triggers a hidden `<input type="file" accept="image/*">`
   - Show a subtle "change avatar" affordance on hover

---

## Constraints

- `sharp` is a native module; compatible with the existing Node.js/Docker build. Run `pnpm install` after adding it.
- The existing `/files/*` auth endpoint already handles `{orgId}/{workspaceId}` prefix — avatar keys follow the same pattern, so no auth changes are needed.
- `pnpm drizzle-kit-push` must be run after the schema change to apply the new `avatar_key` column.

---

## Verification

1. Run `pnpm dev` and `pnpm drizzle-kit-push`
2. Create a new agent, select an avatar, save — confirm avatar appears in the edit form
3. Edit an agent, select a different image, save — confirm old file is replaced
4. Test edge cases:
   - Non-square image → should be centre-cropped
   - Image > 5 MB → rejected with 400
   - Image < 64 px → rejected with 400
   - Unsupported file type (e.g. PDF) → rejected with 400
5. Delete an agent and confirm the avatar file is removed from storage
6. Verify the `/files/{key}` auth still works (authenticated request serves the image)
