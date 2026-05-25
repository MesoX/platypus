import { googleDriveProvider } from "./google-drive.ts";
import type { ResourceProvider } from "./types.ts";

const registry: ReadonlyMap<string, ResourceProvider> = new Map([
  [googleDriveProvider.id, googleDriveProvider],
]);

export function getProvider(id: string): ResourceProvider | undefined {
  return registry.get(id);
}

export type { ResourceProvider } from "./types.ts";
