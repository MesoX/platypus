import { describe, it, expect, vi } from "vitest";
import { createSandboxTools } from "./tools.ts";
import type { SandboxBackend, SandboxContext } from "./types.ts";

const ctx: SandboxContext = {
  orgId: "org-1",
  workspaceId: "ws-1",
  userId: "user-1",
};

const makeBackend = (): SandboxBackend => ({
  shellExec: vi.fn().mockResolvedValue({
    stdout: "ok",
    stderr: "",
    exitCode: 0,
    truncated: false,
    durationMs: 5,
  }),
  fsRead: vi
    .fn()
    .mockResolvedValue({ content: "hello", lineCount: 1, truncated: false }),
  fsWrite: vi.fn().mockResolvedValue({ bytesWritten: 5 }),
  fsEdit: vi.fn().mockResolvedValue({ replacements: 1 }),
  fsList: vi.fn().mockResolvedValue({ entries: [], truncated: false }),
  destroy: vi.fn().mockResolvedValue(undefined),
});

describe("createSandboxTools", () => {
  it("returns the five fixed-core tools", () => {
    const tools = createSandboxTools(makeBackend(), ctx);
    expect(Object.keys(tools).sort()).toEqual([
      "fsEdit",
      "fsList",
      "fsRead",
      "fsWrite",
      "shellExec",
    ]);
  });

  it("delegates shellExec to the backend with the sandbox context", async () => {
    const backend = makeBackend();
    const tools = createSandboxTools(backend, ctx);
    const result = await (tools.shellExec.execute as any)({ command: "ls" });
    expect(backend.shellExec).toHaveBeenCalledWith(ctx, { command: "ls" });
    expect(result.stdout).toBe("ok");
  });

  it("delegates fsRead to the backend with the sandbox context", async () => {
    const backend = makeBackend();
    const tools = createSandboxTools(backend, ctx);
    const result = await (tools.fsRead.execute as any)({ path: "README.md" });
    expect(backend.fsRead).toHaveBeenCalledWith(ctx, { path: "README.md" });
    expect(result.content).toBe("hello");
  });

  it("delegates fsWrite to the backend with the sandbox context", async () => {
    const backend = makeBackend();
    const tools = createSandboxTools(backend, ctx);
    await (tools.fsWrite.execute as any)({
      path: "a.txt",
      content: "hi",
      mode: "create",
    });
    expect(backend.fsWrite).toHaveBeenCalledWith(ctx, {
      path: "a.txt",
      content: "hi",
      mode: "create",
    });
  });

  it("delegates fsEdit to the backend with the sandbox context", async () => {
    const backend = makeBackend();
    const tools = createSandboxTools(backend, ctx);
    await (tools.fsEdit.execute as any)({
      path: "a.txt",
      oldString: "foo",
      newString: "bar",
    });
    expect(backend.fsEdit).toHaveBeenCalledWith(ctx, {
      path: "a.txt",
      oldString: "foo",
      newString: "bar",
    });
  });

  it("delegates fsList to the backend with the sandbox context", async () => {
    const backend = makeBackend();
    const tools = createSandboxTools(backend, ctx);
    await (tools.fsList.execute as any)({ recursive: true });
    expect(backend.fsList).toHaveBeenCalledWith(ctx, { recursive: true });
  });
});
