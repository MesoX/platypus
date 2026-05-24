/**
 * Seed (or update) the meeting-pipeline skills, agents, and triggers in a
 * target Platypus workspace.
 *
 * Usage:
 *   pnpm tsx seeds/meeting-pipeline/seed.ts \
 *     --backend=http://localhost:4010 \
 *     --org=<orgId> \
 *     --workspace=<workspaceId> \
 *     --provider=<providerId> \
 *     --model=qwen36 \
 *     --drive-mcp=<driveMcpId> \
 *     --calendar-mcp=<calendarMcpId> \
 *     --librarian-agent=<librarianAgentId> \
 *     --backend-url=http://host.docker.internal:4010 \
 *     --whisperx-url=http://host.docker.internal:9000 \
 *     --inbox-folder="Meeting Recordings/inbox" \
 *     --timezone=Europe/Prague \
 *     --language-hint=cs
 *
 * Requires PLATYPUS_SESSION_COOKIE in the environment — copy from the
 * browser after logging in (Application → Cookies → better-auth.session_token).
 *
 * Idempotent: existing rows matched by name are updated in place. Sub-agent
 * references in front-matter are resolved by name and substituted with the
 * actual agent IDs the first pass writes.
 */

import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// -- arg parsing -------------------------------------------------------------

type Args = {
  backend: string;
  org: string;
  workspace: string;
  provider: string;
  model: string;
  driveMcp: string;
  calendarMcp: string;
  librarianAgent: string;
  backendUrl: string;
  whisperxUrl: string;
  inboxFolder: string;
  timezone: string;
  languageHint: string;
};

function parseArgs(): Args {
  const out: Record<string, string> = {};
  for (const arg of process.argv.slice(2)) {
    const m = arg.match(/^--([^=]+)=(.*)$/);
    if (!m) continue;
    out[m[1]] = m[2];
  }
  const required = [
    "backend",
    "org",
    "workspace",
    "provider",
    "model",
    "drive-mcp",
    "calendar-mcp",
    "librarian-agent",
    "backend-url",
    "whisperx-url",
    "inbox-folder",
  ];
  const missing = required.filter((k) => !out[k]);
  if (missing.length) {
    console.error(`Missing required args: ${missing.join(", ")}`);
    process.exit(2);
  }
  return {
    backend: out.backend.replace(/\/$/, ""),
    org: out.org,
    workspace: out.workspace,
    provider: out.provider,
    model: out.model,
    driveMcp: out["drive-mcp"],
    calendarMcp: out["calendar-mcp"],
    librarianAgent: out["librarian-agent"],
    backendUrl: out["backend-url"].replace(/\/$/, ""),
    whisperxUrl: out["whisperx-url"].replace(/\/$/, ""),
    inboxFolder: out["inbox-folder"],
    timezone: out.timezone ?? "UTC",
    languageHint: out["language-hint"] ?? "cs",
  };
}

// -- front-matter parser -----------------------------------------------------

/**
 * Parse the YAML-ish front-matter at the top of a markdown file. Supports
 * top-level scalar values and one-level YAML lists ("- item"). Anything
 * fancier is rejected on purpose — keep front-matter boring.
 */
function parseFrontMatter(text: string): {
  meta: Record<string, string | number | string[]>;
  body: string;
} {
  if (!text.startsWith("---\n")) {
    throw new Error("front-matter block missing");
  }
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("front-matter block not closed");
  const header = text.slice(4, end);
  const body = text.slice(end + 5);
  const meta: Record<string, string | number | string[]> = {};
  let currentList: string[] | null = null;
  let currentKey = "";
  for (const rawLine of header.split("\n")) {
    if (!rawLine.trim()) {
      currentList = null;
      continue;
    }
    const listMatch = rawLine.match(/^\s+-\s+(.+)$/);
    if (listMatch && currentList) {
      currentList.push(stripQuotes(listMatch[1]));
      continue;
    }
    const kvMatch = rawLine.match(/^([A-Za-z0-9_]+):\s*(.*)$/);
    if (!kvMatch) {
      throw new Error(`malformed front-matter line: ${rawLine}`);
    }
    currentKey = kvMatch[1];
    const value = kvMatch[2].trim();
    if (value === "") {
      currentList = [];
      meta[currentKey] = currentList;
    } else {
      currentList = null;
      const stripped = stripQuotes(value);
      const asNumber = Number(stripped);
      meta[currentKey] =
        stripped !== "" &&
        !Number.isNaN(asNumber) &&
        /^-?[0-9.]+$/.test(stripped)
          ? asNumber
          : stripped;
    }
  }
  return { meta, body };
}

function stripQuotes(s: string): string {
  return s.replace(/^["'](.*)["']$/, "$1");
}

// -- template substitution ---------------------------------------------------

function substitute(
  text: string,
  args: Args,
  subAgentIds: Record<string, string>,
): string {
  const inboxName = args.inboxFolder.split("/").pop() ?? args.inboxFolder;
  const backendPort = (() => {
    const m = args.backendUrl.match(/:(\d+)/);
    return m ? m[1] : "4010";
  })();
  const replacements: Record<string, string> = {
    workspace_id: args.workspace,
    drive_mcp_id: args.driveMcp,
    calendar_mcp_id: args.calendarMcp,
    librarian_agent_id: args.librarianAgent,
    backend_url: args.backendUrl,
    backend_port: backendPort,
    whisperx_url: args.whisperxUrl,
    inbox_folder: args.inboxFolder,
    inbox_folder_name: inboxName,
    timezone: args.timezone,
    language_hint: args.languageHint,
    ...subAgentIds,
  };
  return text.replace(/\{\{([a-z0-9_]+)\}\}/g, (whole, key) => {
    const v = replacements[key];
    if (v === undefined) {
      throw new Error(`unresolved placeholder: {{${key}}}`);
    }
    return v;
  });
}

// -- API client --------------------------------------------------------------

const cookie = process.env.PLATYPUS_SESSION_COOKIE;
if (!cookie) {
  console.error(
    "Set PLATYPUS_SESSION_COOKIE to your better-auth session cookie value.",
  );
  process.exit(2);
}

async function api(
  args: Args,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: unknown,
): Promise<any> {
  const res = await fetch(`${args.backend}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Cookie: `better-auth.session_token=${cookie}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(
      `${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`,
    );
  }
  if (res.status === 404) return null;
  return res.json();
}

const wsPath = (args: Args) =>
  `/organizations/${args.org}/workspaces/${args.workspace}`;

// -- skill upsert ------------------------------------------------------------

async function listSkills(
  args: Args,
): Promise<Array<{ id: string; name: string }>> {
  const res = await api(args, "GET", `${wsPath(args)}/skills`);
  return (res?.results ?? []) as Array<{ id: string; name: string }>;
}

async function upsertSkill(
  args: Args,
  payload: { name: string; description: string; body: string },
): Promise<string> {
  const existing = await listSkills(args);
  const match = existing.find((s) => s.name === payload.name);
  if (match) {
    await api(args, "PUT", `${wsPath(args)}/skills/${match.id}`, payload);
    return match.id;
  }
  const created = await api(args, "POST", `${wsPath(args)}/skills`, {
    workspaceId: args.workspace,
    ...payload,
  });
  return created.id;
}

// -- agent upsert ------------------------------------------------------------

type AgentSpec = {
  name: string;
  description: string;
  systemPrompt: string;
  modelId: string;
  maxSteps?: number;
  temperature?: number;
  toolSetIds: string[];
  skillIds: string[];
  subAgentIds: string[];
  inputPlaceholder?: string;
};

async function listAgents(
  args: Args,
): Promise<Array<{ id: string; name: string }>> {
  const res = await api(args, "GET", `${wsPath(args)}/agents`);
  return (res?.results ?? []) as Array<{ id: string; name: string }>;
}

async function upsertAgent(args: Args, spec: AgentSpec): Promise<string> {
  const existing = await listAgents(args);
  const match = existing.find((a) => a.name === spec.name);
  const body = {
    workspaceId: args.workspace,
    providerId: args.provider,
    ...spec,
  };
  if (match) {
    await api(args, "PUT", `${wsPath(args)}/agents/${match.id}`, body);
    return match.id;
  }
  const created = await api(args, "POST", `${wsPath(args)}/agents`, body);
  return created.id;
}

// -- trigger upsert ----------------------------------------------------------

async function listTriggers(
  args: Args,
): Promise<Array<{ id: string; name: string }>> {
  const res = await api(args, "GET", `${wsPath(args)}/triggers`);
  return (res?.results ?? []) as Array<{ id: string; name: string }>;
}

async function upsertTrigger(args: Args, payload: any): Promise<string> {
  const existing = await listTriggers(args);
  const match = existing.find((t) => t.name === payload.name);
  const body = { workspaceId: args.workspace, ...payload };
  if (match) {
    await api(args, "PUT", `${wsPath(args)}/triggers/${match.id}`, body);
    return match.id;
  }
  const created = await api(args, "POST", `${wsPath(args)}/triggers`, body);
  return created.id;
}

// -- helpers -----------------------------------------------------------------

async function loadMarkdown(file: string): Promise<{
  meta: Record<string, string | number | string[]>;
  body: string;
}> {
  const text = await readFile(file, "utf8");
  return parseFrontMatter(text);
}

async function listFiles(dir: string, ext: string): Promise<string[]> {
  const entries = await readdir(dir).catch(() => []);
  return entries.filter((f) => f.endsWith(ext)).map((f) => join(dir, f));
}

function asArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  return [];
}

// -- main --------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  const seedRoot = __dirname;

  // 1) Skills (no inter-dependencies)
  const skillFiles = await listFiles(join(seedRoot, "skills"), ".md");
  const skillIdByName: Record<string, string> = {};
  for (const f of skillFiles) {
    const { meta, body } = await loadMarkdown(f);
    const rendered = substitute(body, args, {});
    const payload = {
      name: String(meta.name),
      description: String(meta.description),
      body: rendered,
    };
    const id = await upsertSkill(args, payload);
    skillIdByName[payload.name] = id;
    console.log(`skill  ${payload.name}  ${id}`);
  }

  // 2) Sub-agents first (so the orchestrator can reference them)
  const agentFiles = await listFiles(join(seedRoot, "agents"), ".md");
  const agentIdByName: Record<string, string> = {};
  // Pass 1: agents that don't reference other meeting-* agents
  const subFiles = agentFiles.filter((f) => !f.endsWith("meeting-pipeline.md"));
  for (const f of subFiles) {
    const { meta, body } = await loadMarkdown(f);
    const spec = await buildAgentSpec(
      args,
      meta,
      body,
      skillIdByName,
      agentIdByName,
    );
    const id = await upsertAgent(args, spec);
    agentIdByName[spec.name] = id;
    console.log(`agent  ${spec.name}  ${id}`);
  }
  // Pass 2: orchestrator (depends on sub-agents)
  const orchFile = agentFiles.find((f) => f.endsWith("meeting-pipeline.md"));
  if (!orchFile) throw new Error("meeting-pipeline.md missing from agents/");
  {
    const { meta, body } = await loadMarkdown(orchFile);
    const spec = await buildAgentSpec(
      args,
      meta,
      body,
      skillIdByName,
      agentIdByName,
    );
    const id = await upsertAgent(args, spec);
    agentIdByName[spec.name] = id;
    console.log(`agent  ${spec.name}  ${id}`);
  }

  // 3) Triggers (depend on orchestrator agent)
  const triggerFiles = await listFiles(join(seedRoot, "triggers"), ".json");
  for (const f of triggerFiles) {
    const raw = await readFile(f, "utf8");
    const rendered = substitute(raw, args, {});
    const spec = JSON.parse(rendered);
    const agentId = agentIdByName[spec.agentRef];
    if (!agentId) {
      throw new Error(`trigger references unknown agent: ${spec.agentRef}`);
    }
    delete spec.agentRef;
    spec.agentId = agentId;
    const id = await upsertTrigger(args, spec);
    console.log(`trig   ${spec.name}  ${id}`);
  }

  console.log("\nDone. Drop a file into the Drive inbox to test.");
}

async function buildAgentSpec(
  args: Args,
  meta: Record<string, string | number | string[]>,
  body: string,
  skillIdByName: Record<string, string>,
  agentIdByName: Record<string, string>,
): Promise<AgentSpec> {
  // Resolve tool_sets entries to real tool-set ids.
  // `sandbox` is a built-in tool set keyed by name; `mcp:<mcpId>` is already
  // a literal id once the placeholder substitution is done.
  const rendered = substitute(body, args, agentIdByName);
  const toolSets = asArray(meta.tool_sets).map((t) =>
    substitute(t, args, agentIdByName),
  );
  const skills = asArray(meta.skills).map((s) => {
    const id = skillIdByName[s];
    if (!id)
      throw new Error(`agent ${meta.name} references unknown skill: ${s}`);
    return id;
  });
  const subAgents = asArray(meta.sub_agents).map((ref) => {
    const renderedRef = substitute(ref, args, agentIdByName);
    if (agentIdByName[renderedRef]) return agentIdByName[renderedRef];
    return renderedRef;
  });
  return {
    name: String(meta.name),
    description: String(meta.description),
    systemPrompt: rendered,
    modelId: String(meta.model_id ?? args.model),
    maxSteps: meta.max_steps as number | undefined,
    temperature: meta.temperature as number | undefined,
    toolSetIds: toolSets,
    skillIds: skills,
    subAgentIds: subAgents,
    inputPlaceholder: meta.input_placeholder as string | undefined,
  };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
