import { googleDriveProvider } from "./google-drive.ts";
import type { ResourceProvider } from "./types.ts";

/**
 * Registry of resource providers, keyed by their stable `id`.
 *
 * Adding a new provider:
 *  1. Implement `ResourceProvider` in a new file under this directory.
 *  2. Register it in the map below.
 *  3. Callers reach it via `/internal/resources/<id>/...`.
 *
 * Provider IDs are part of the public URL contract — once shipped, do
 * not rename them.
 */
const registry: ReadonlyMap<string, ResourceProvider> = new Map([
  [googleDriveProvider.id, googleDriveProvider],
]);

export function getProvider(id: string): ResourceProvider | undefined {
  return registry.get(id);
}

export type { ResourceProvider } from "./types.ts";
