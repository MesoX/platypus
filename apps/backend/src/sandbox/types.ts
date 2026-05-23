import { z } from "zod";

// Context handed to every adapter call. The (orgId, workspaceId) tuple is the
// stable identity key for the Sandbox; adapters use it to find or provision
// their external resource. userId is the Workspace owner and is included for
// audit/identification, not isolation (Workspaces are single-user — see
// CONTEXT.md).
export type SandboxContext = {
  orgId: string;
  workspaceId: string;
  userId: string;
};

// All paths are workspace-root-relative. The workspace root is conventionally
// "/workspace" inside the sandbox; adapters resolve relative paths against it.
const relativePathSchema = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith("/"), {
    message: "path must be relative to the workspace root",
  });

// shell.exec ------------------------------------------------------------------

export const shellExecInputSchema = z.object({
  command: z.string().min(1),
  cwd: relativePathSchema.optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
  env: z.record(z.string(), z.string()).optional(),
});
export type ShellExecInput = z.infer<typeof shellExecInputSchema>;

export type ShellExecOutput = {
  stdout: string;
  stderr: string;
  exitCode: number;
  truncated: boolean;
  durationMs: number;
};

// fs.read ---------------------------------------------------------------------

export const fsReadInputSchema = z.object({
  path: relativePathSchema,
  lineRange: z
    .tuple([z.number().int().min(1), z.number().int().min(1)])
    .optional(),
});
export type FsReadInput = z.infer<typeof fsReadInputSchema>;

export type FsReadOutput = {
  content: string;
  lineCount: number;
  truncated: boolean;
};

// fs.write --------------------------------------------------------------------

export const fsWriteInputSchema = z.object({
  path: relativePathSchema,
  content: z.string(),
  mode: z.enum(["create", "overwrite"]),
});
export type FsWriteInput = z.infer<typeof fsWriteInputSchema>;

export type FsWriteOutput = {
  bytesWritten: number;
};

// fs.edit ---------------------------------------------------------------------

export const fsEditInputSchema = z.object({
  path: relativePathSchema,
  oldString: z.string().min(1),
  newString: z.string(),
});
export type FsEditInput = z.infer<typeof fsEditInputSchema>;

export type FsEditOutput = {
  replacements: 1;
};

// fs.list ---------------------------------------------------------------------

export const fsListInputSchema = z.object({
  path: relativePathSchema.optional(),
  recursive: z.boolean().optional(),
  glob: z.string().optional(),
});
export type FsListInput = z.infer<typeof fsListInputSchema>;

export type FsListEntry = {
  path: string;
  type: "file" | "dir";
  size?: number;
};

export type FsListOutput = {
  entries: FsListEntry[];
  truncated: boolean;
};

// Backend interface -----------------------------------------------------------

// Implemented by every Sandbox adapter. Methods take a SandboxContext plus
// their typed input; they MUST honour the Platypus-defined output bounds from
// ./index.ts and set the `truncated` flag when they apply them.
//
// destroy() MUST be idempotent: safe to call on a resource that's already gone.
// See ADR-0001 for the teardown contract.
export interface SandboxBackend {
  shellExec(
    ctx: SandboxContext,
    input: ShellExecInput,
  ): Promise<ShellExecOutput>;
  fsRead(ctx: SandboxContext, input: FsReadInput): Promise<FsReadOutput>;
  fsWrite(ctx: SandboxContext, input: FsWriteInput): Promise<FsWriteOutput>;
  fsEdit(ctx: SandboxContext, input: FsEditInput): Promise<FsEditOutput>;
  fsList(ctx: SandboxContext, input: FsListInput): Promise<FsListOutput>;
  destroy(ctx: SandboxContext): Promise<void>;
}

// Registered once per backend type. The discriminator string lives in the
// `sandbox.backend` column. configSchema and credentialsSchema validate the
// jsonb columns before an adapter instance is created.
export interface SandboxBackendRegistration<
  TConfig = unknown,
  TCredentials = unknown,
> {
  backend: string;
  name: string;
  configSchema: z.ZodType<TConfig>;
  credentialsSchema: z.ZodType<TCredentials>;
  create(config: TConfig, credentials: TCredentials): SandboxBackend;
}
