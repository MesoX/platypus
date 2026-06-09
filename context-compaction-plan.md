# Plan: Chat Context Compaction & Usage Indicator

Status: **chunks 1-2 implemented & reviewed** (spec passed 4 review rounds; code reviewed 2026-06-09 — see Implementation status §) · Branch target: `feature/context-compaction`

> This doc is the spec to implement against, not a proposal. Sections A–J are the
> design. The **Drift log & code-review checklist** at the bottom records every
> flaw found during review and the trap to re-check once code exists — read it
> before coding and again at PR time. Do not re-derive the happy path and skip
> the failure modes; they are written down precisely so we do not drift into them
> twice.

## Implementation status & code review — chunks 1-2 (reviewed 2026-06-09)

Chunks **1** (window resolution + single estimator + schema) and **2** (compaction
module + `writeWatermark` CAS + Tier 1) are landed on `feature/context-compaction`
(post main v1.95.0 merge). Backend tests: 1037 pass; chunk 1-2 unit tests:
context-window 20, token-estimate 14, compaction (CAS/budget/pairing/invalidation)
all green. Source `tsc --noEmit` clean for these files. This section is the
**start point for chunk 3** — read it before coding.

### Solid / verified

- **CAS durable writer (P3 / R1 / T10)** — the hardest part is correct and
  well-tested. Single versioned writer (`commitWatermark`→`casWrite`,
  `compaction.ts:84-160`); all three mutations (advance / dirty-clear / C4 reset)
  route through it; loser decides by **version** not watermark value; one-retry-
  then-skip, no livelock. No field write bypasses it.
- **C2 hysteresis, C3 budget, C4 invalidation, M1 map-reduce primitive, T7
  summarizer fallback** — VERIFIED in `compaction.ts`.
- **C4 wiring** — VERIFIED. By design there is no separate edit/delete/regenerate
  endpoint; the client resubmits the full array, so invalidation is correctly
  detected at submit (`chat-execution.ts` `affectedBelowWatermark`→
  `invalidateCompaction`). The earlier "never invoked" worry does NOT apply.
- **Schema / migration / zod / lazy-rollout** — VERIFIED. Columns additive +
  nullable/defaulted; migration `0047_context_compaction.sql` matches schema;
  `modelMeta` optional in all variants; `contextSummary`/`summaryWatermark` kept
  out of chatSubmit/chatUpdate (server-managed); no eager backfill job.
- **Tier 1 gating (plan M3)** — VERIFIED. `request.id ? applyTier1IfNeeded : skip`;
  triggers (`{agentId,search}`, no id) and sub-agents (bypass `prepareChatTurn`)
  skip Tier 1; best-effort try/catch never breaks a turn (P4).
- **`compactModelMessages` Tier 2 adapter** — fully implemented + tested (NOT a
  stub). Recovery (chunk 3) and Tier 2 (chunk 4) can call it directly.

### Defects to fix (ordered by impact)

1. **C1 — trigger under-counts (HIGH).** `compaction.ts:719`
   `projected = estimate(afterWatermark) + priorSummaryTokens` — omits the prior
   turn's provider `usage.inputTokens` AND the system prompt / tool schemas / skill
   payload sent every turn. `Tier1Input` has no `lastInputTokens` field; the call
   site (`chat-execution.ts:537`) passes none. This is the live-test under-count
   (8888 real vs ~986 estimated) — trigger can silently never fire on tool-bearing
   agents; only recovery (chunk 3) catches the overflow. Same root issue as the
   **§Open trigger-estimator scope** note below.
2. **Empty litellm registry + alias map in prod (HIGH, compounding).**
   `context-window.ts:285,389` — the production singleton injects an empty registry
   loader and empty alias map, so every non-API provider (OpenAI/Anthropic/Bedrock)
   resolves to `DEFAULT_CONTEXT_WINDOW = 8192`. The budget math is therefore
   wrong-defaulted for those providers today. Must vendor litellm
   `model_prices_and_context_window.json` + build the alias map and wire them in.
3. **M2 — first-turn ×1.15 margin absent (MED).** `compaction.ts:719` applies no
   cold-start inflation; a char/4 under-count can keep turn-1 from triggering.
4. **`summarizerWindow` not threaded (MED).** `chat-execution.ts:537` calls
   `applyTier1Compaction` without `summarizerWindow`, so the M1 map-reduce path is
   dead in the wired flow — a large cold-start/imported history can overflow the
   summarizer call itself.
5. **T5 evict not wired (MED).** `routes/provider.ts:126` updates a provider
   (incl. `modelMeta`) without `contextWindowResolver.evict(providerId)`; window
   cache serves stale values until TTL.
6. **Window cache pins transient failures (MED).** `context-window.ts:324` caches
   `source:"default"`/MISS results for the full TTL (1h); one API blip pins 8192.
   Don't cache default-source results (or use a short TTL).
7. **Latent T2 violation (LOW).** `token-estimate.ts:352` `case "content"`
   `stableStringify`s tool-output base64 image bytes into char/4 text. No current
   tool emits this shape; fix before any tool returns `content`-type media.
8. **Latent T1 divergence (LOW).** `token-estimate.ts:318` the UI adapter folds the
   full tool output, but a tool with custom `toModelOutput` (e.g. the sub-agent
   tool) is collapsed on the model side → UI vs Model counts differ. Untested; add
   a `toModelOutput` fixture.
9. **Doc bug.** `token-estimate.ts` header claims "every later turn uses the real
   provider count" — false; char/4 is used every turn (ties to C1). Fix the comment
   when C1 is plumbed.
10. **Observability metrics absent (across both chunks).** No `cas.conflict` (gates
    whether R4 ever needs fixing), `context_window.fell_to_default`,
    `litellm.key_miss`, `compaction.fired`, `summarize.latency_ms`, etc. Logs only.
11. **Low:** litellm family heuristic lacks a key-boundary check
    (`context-window.ts:126`); Bedrock-ARN path not lowercased (`:118`); dead
    `default: return ""` in the output switch (`token-estimate.ts:357`).

### Drift-checklist deltas (vs the table at the bottom)

`C1` → **MISSING** (defect 1). `M2` → **MISSING** (defect 3). `T3` → **PARTIAL**
(consumer wired; producer = chunk 3). `R4` → **PARTIAL** (window present & correctly
unfixed, but the gating `cas.conflict` metric is missing). Everything else listed
above → VERIFIED. `T5` → module hook present, **PATCH-handler call missing** (defect 5).

### Chunk 3 (Recovery) — hand-off is clean

`applyTier1Compaction` already honors `state.compactionDirty` as a force-trigger and
clears it inside the same CAS write. Chunk 3 only needs the **producer** in
`agent-runner.ts`: `isContextOverflowError` (per-provider 400/413 body matrix, drift
T9), retry-once via `compactModelMessages` (NOT a bespoke trim, drift T3), and set
`compactionDirty=true` through `commitWatermark`. Recommend folding the **C1 fix**
(thread prior-turn `usage.inputTokens` + system/tool payload into the projection)
into the same chunk or the §H usage-metadata chunk, since recovery makes provider
`usage` available — without C1, recovery is the only thing standing between a
tool-bearing agent and a hard overflow.

### Branch & upstream-PR hygiene

`feature/context-compaction` is the **dev** branch but it sits on the fork/deploy
lineage (off v1.90.0, later merged with main), so it carries non-compaction commits.
It is **NOT** a clean upstream PR base. Workflow:

- **Dev:** here, on `feature/context-compaction`.
- **Test:** merge `feature/context-compaction` → `deploy/fresh` (shared lineage =
  cheap), deploy `deploy/fresh` to the test server as usual.
- **Upstream PR:** a **one-time** branch — cherry-pick the compaction-only commits
  onto current upstream `main`. Do not PR this branch directly.

**EXCLUDE from the upstream PR** (fork/deploy-only or unrelated features — they
predate the compaction work and must not leak into the diff):

- `e3ccf25` — `compose.yaml` deploy local-build edit (pure deploy)
- `d4cd6f2` — backendUrl-from-Host (fork deploy hack)
- `cdef399` — MCP auto-refresh on 401 + scoped quirks (separate feature)
- `7320000`, `5cfb882` — configurable agent-run timeouts (separate feature)
- `b1daa88` — deploy/fresh main(v1.90) merge commit
- `759aae1` — fork docs (PROJECT.md / CLAUDE.md fork refs)
- `b97312f`, `c18c18d`, `d194edc`, `51f69af`, `0737a6a`, `3851da6` — tool-call
  duration / timestamps. **Borderline:** plan §I reuses this. Include ONLY if §I
  (per-message stats) ships in the same PR; otherwise it is a separate feature.

**INCLUDE** (compaction): `68cf725` (foundation+Tier 1), `d1d699e` (migration),
`e19029c` + the chunk-1-2 fix/plan commits from this session, plus chunks 3-9.
Note: the `0047_context_compaction` migration will need **renumbering** to match
upstream `main`'s migration sequence at cherry-pick time.

## Goal

Stop chats from hard-failing when message history exceeds a model's context
window. Three capabilities:

1. **Proactive compaction** — summarize old history before the window fills.
2. **Recovery** — catch context-overflow errors from providers and recover.
3. **Visibility** — a context-usage indicator (ring) next to the model selector.

Applies to top-level chats **and** sub-agents (both run through the shared
`agent-runner` / `ToolLoopAgent`, so implementing once covers both).

---

## Design principles (read first — these are load-bearing)

- **P1 — Compaction is a VIEW, not a DELETE.** The watermark + summary change
  _what is sent to the model_, never _what is stored_. Raw messages stay in the
  DB untouched. Consequences: forced compaction (§J) is **not** data loss — the
  user can still read full history; only the model payload is compacted. A future
  "expand summary" UI is free because originals persist. Never hard-delete a
  summarized message.
- **P2 — One estimator.** Token counting lives in exactly one function over one
  neutral structure (`CountUnit[]`). Tier 1 (UIMessages) and Tier 2
  (ModelMessages) both normalize into it. Divergence is impossible by
  construction, not monitored. (See drift T1.)
- **P3 — One durable writer.** All mutations of compaction state
  (`summaryWatermark`, `contextSummary`, `compactionDirty`) go through a single
  versioned CAS function `writeWatermark`. No other code path writes these
  fields. (See drift R1.)
- **P4 — Recovery is the net, proactive compaction is the plan.** The overflow
  catch (§E) must stay on even if proactive compaction is globally disabled. It
  is the last line, not a risk surface.

---

## Key facts established during research

- AI SDK (`ai@6.0.191`) reports real token usage **after** each call:
  `usage.inputTokens` / `outputTokens` / `totalTokens`
  (`apps/backend/src/runs/agent-runner.ts:148-194`). This is the primary,
  provider-accurate signal driving compaction — no pre-call counting needed
  except on the very first turn.
- AI SDK exposes **no** context-window metadata on the model interface, and
  there is **no** built-in pre-call tokenizer.
- AI SDK `prepareStep` hook (`ai/dist/index.d.ts:960-1023`) runs before each
  step of an in-flight response and can rewrite the `messages` sent to the
  model — this is how we compact _within_ a single response. Receives
  **ModelMessages** (post-`convertToModelMessages`).
- `prepareChatTurn` (`chat-execution.ts:430`) holds **UIMessages**
  (`turn.stream.messages`); conversion to ModelMessages happens later at
  `agent-runner.ts:360` (`await convertToModelMessages(...)`). **Tier 1 and
  Tier 2 therefore operate on different message shapes — see drift T1.**
- Provider context-window availability:
  - Google (`inputTokenLimit`), OpenRouter (`context_length`),
    vLLM/OpenAI-compatible (`max_model_len`) — **available via API**.
  - OpenAI, Anthropic, Bedrock — **not** via API; need lookup table / manual.
- Sub-agents run as tools (`apps/backend/src/tools/sub-agent.ts:56-159`) with
  fresh history (only a `task` string), each its own `ToolLoopAgent`.
- Model call sites: `streamText` `agent-runner.ts:358-397`,
  `generateText` `agent-runner.ts:543-584`.
- Error handling today only covers auth/rate-limit/5xx
  (`agent-runner.ts:636-657`) — no context-overflow handling.
- Frontend selector + `(i)` icon: `apps/frontend/components/chat.tsx:561-593`
  inside `PromptInputTools`. No progress/ring component exists yet. Token usage
  is **not** currently streamed to the client per message.
- `inlineFileUrls` (`chat-execution.ts:524`) fetches file/image bytes and inlines
  them into messages. It does **not** decode image dimensions today (see drift T2).
- `messageMetadata` callback (`agent-runner.ts:408`) fires at message **start**,
  before timing/usage exist — cannot carry stats. Stamp at the
  `applyToolCompletions` point (`:443`) instead (see §I).

---

## Design

### A. Context-window resolution

New module `apps/backend/src/runs/context-window.ts`.

`resolveContextWindow(provider, modelId): Promise<number>` resolution order:

1. **Manual override** — per-model entry in provider config (see schema below).
2. **API auto-detect** by provider type (cached per provider+model):
   - Google: `GET {baseUrl}/v1beta/models/{modelId}` → `inputTokenLimit`.
   - OpenRouter: `GET {baseUrl}/api/v1/models` → match id → `context_length`.
   - OpenAI-type: `GET {baseUrl}/v1/models` → if entry has `max_model_len`
     (vLLM and most OpenAI-compatible servers expose it) use it; official
     OpenAI omits it → fall through.
3. **litellm model registry** (replaces a homegrown table) — vendor/fetch
   litellm's `model_prices_and_context_window.json` (MIT, community-maintained).
   Each entry has `max_input_tokens` / `max_output_tokens`. Covers OpenAI /
   Anthropic / Bedrock families that don't expose the window via API.
   - **Key normalization (drift T4):** registry keys don't match our
     `resolvedModelId` 1:1. Lookup order:
     `exact(modelId) → strip provider prefix ("openai/") → lowercase → alias map → family heuristic → MISS`.
     Maintain a small alias map for Bedrock ARNs, Azure deployment names, vLLM
     custom names. `log.warn` on every MISS (it falls to default — must be visible).
4. **Conservative default** — `DEFAULT_CONTEXT_WINDOW = 8192`. `log.warn` on every
   fall-to-default. When the window is default/unknown the **ring renders neutral**
   (§H), never a guessed green→red ramp.

Detection results cached in-memory (per provider id + model id) with a TTL.
**Cache invalidation (drift T5):** editing a `modelMeta` override must
`cache.evict(providerId)` **immediately** in the provider PATCH handler — do not
wait for TTL. TTL is only a backstop for API-detected drift. Also resolve
`maxOutputTokens` the same way (registry `max_output_tokens` / API) — needed for
the budget math in §C.

#### Schema change (per-model, not per-provider)

A single per-provider number is wrong: one provider serves many models with
different windows. Store a per-model map.

- DB: add `modelMeta` JSONB column to the `provider` table
  (`apps/backend/src/db/schema.ts`), shape:
  `{ "<modelId>": { contextWindow?: number, maxOutputTokens?: number } }`.
- Zod: extend provider schema in `packages/schemas/index.ts` (full / create /
  update variants) with optional `modelMeta`.
- Apply via `pnpm drizzle-kit-push` (DDL only — additive nullable column, safe).
- UI (later): provider edit form shows resolved window per enabled model with an
  editable override field.

### B. Token estimation (cold start only) — the single estimator (P2)

`apps/backend/src/runs/token-estimate.ts`.

One function over one neutral structure — **no per-tier estimator**:

```ts
const MODEL_BOUND: PartType[] = ["text", "tool-call", "tool-result", "file", "image"];
// reasoning / source / step-start / data-* are UI-only — they never reach the
// model and MUST be excluded on both sides (drift T1).

type CountUnit = { role: Role; text: string; nonText: NonTextPart[] };

function toCountUnits(m: UIMessage): CountUnit[]      // Tier 1 adapter
function toCountUnits(m: ModelMessage): CountUnit[]   // Tier 2 adapter
const estimateTokens = (units: CountUnit[]): number   // char/4 text + modality table
```

- char/4 applies to **text parts only**. Never char/4 a base64 image.
- **Modality table (drift T2)** for non-text parts:
  - `anthropic: (w,h) => ceil(w*h/750)`
  - `openai: (w,h,detail) => detail==="low" ? 85 : tile85(w,h)` — **detail is
    usually unset → assume `high`** (over-count beats overflow).
  - `default: () => 1200` (conservative).
  - Dimensions via **cheap header parse** (PNG IHDR / JPEG SOF marker, ~32 bytes —
    no full decode) when bytes are in hand; bare URL or parse failure → `default`
    constant. Not "free": one buffer read per image, cold-start only.
- Used **only** on the first turn before any provider `usage` exists; every later
  turn uses the real `usage.inputTokens`.
- **Tier 1 estimate runs AFTER `inlineFileUrls` (drift T2)** so the payload is
  real, not a pre-inline underestimate.
- **Divergence feedback loop (drift T2):** on turn 2, compare the cold-start
  estimate vs real `usage.inputTokens`; `log.warn` when `|est−real|/real > 0.5`
  with model + part breakdown. That signal tunes the image constants over time.
- (Optional future: Anthropic `/v1/messages/count_tokens` for exact Claude counts.)

### C. Tier 1 — cross-turn compaction (durable)

Runs in `prepareChatTurn` (`chat-execution.ts:524-549`) before a response starts.
Operates on durable chat history (**UIMessages**). Remember **P1: this is a view
over history; raw messages are never deleted.**

**Budget math** (not a raw window ratio — fixes drift C3):

```
inputBudget   = contextWindow − maxOutputReserve − safetyReserve
                (safetyReserve = reserveRatio × contextWindow, default 0.05, per LibreChat;
                 maxOutputReserve from resolved maxOutputTokens)
triggerTokens = triggerRatio × inputBudget   (triggerRatio default 0.8)
targetTokens  = targetRatio  × inputBudget   (targetRatio  default 0.5)
```

**Trigger** (drift C1 — must count what _this_ turn adds, not just the last
response): `projected = lastInputTokens + estimateTokens(messagesSinceWatermarkOrLastTurn)`.
First turn: `projected = estimateTokens(allMessages) × 1.15` (char/4 safety
margin, drift M2). Compact when `projected >= triggerTokens`.

**Hysteresis** (drift C2 — the Cline #5616 thrash failure): compaction must reduce
the conversation to `<= targetTokens`, well below the trigger, so it does NOT
re-fire next turn. Trigger ratio (0.8) and target ratio (0.5) are deliberately
distinct.

Compaction (`apps/backend/src/runs/compaction.ts`) — staged, cheap-first
(LibreChat pattern). **Two adapters, shared leaf primitives** (P2):
`compactUIMessages` (Tier 1) and `compactModelMessages` (Tier 2 + recovery) both
call `estimateTokens` / `summarizePrefix` / `pickKeepBoundary`. Pairing rule
differs by shape:

- Tier 1 / UIMessage: an assistant message carrying tool-invocation parts is
  **atomic** — never split, never drop its paired result.
- Tier 2 / ModelMessage: keep assistant + following `role:"tool"` messages
  together.

Stages:

- Pin the system prompt.
- Keep the last `keepRecentMessages` (default ~10) verbatim; never split a
  tool-call / tool-result pair across the boundary.
- **Stage 1 — prune (no model call):** in the older prefix, degrade bulky tool /
  RAG results — soft-trim to head+tail, then replace with a placeholder
  (`[tool result elided]`) for results over `minPrunableChars`. Often enough to
  reach `targetTokens` without a summarization call.
- **Stage 2 — summarize:** if still above target, summarize the older prefix
  with the **task model** into one synthetic summary message.
  - **Model fallback (drift T7):** `provider.taskModelId → resolvedModelId (main)`.
    `log` which model summarized + token cost.
  - **Chunked / map-reduce** when the prefix exceeds the summarizer's own window
    (drift M1 — cold-start on a large imported history).
- Output: `[system, summaryMessage, ...pruned/keptRecent]`.
- **Fail loud:** emit a visible transcript event (`context-compacted`,
  "Summarized N earlier messages") rather than silently mutating.

**Persistence + watermark** — all writes through `writeWatermark` (P3, drift R1):

- Add to chat/run record: `contextSummary: text`, `summaryWatermark: int`
  (id/index of last summarized message), `compactionDirty: boolean default false`
  (drift T3), `version: int default 0` (drift R1 — CAS token).
- Each turn, summarize only messages _after_ the watermark and fold into the
  existing summary, then advance the watermark — incremental.
- **The single versioned CAS writer (P3, drift R1):**

  ```ts
  // EVERY mutation — advance | C4 reset | dirty-clear — goes through this.
  async function writeWatermark(
    chatId,
    expectVersion,
    patch /* {watermark?, summary?, dirty?} */,
  ) {
    const res = await db
      .update(chat)
      .set({ ...patch, version: expectVersion + 1 })
      .where(and(eq(chat.id, chatId), eq(chat.version, expectVersion)));
    return res.rowCount === 1; // false = conflict → re-read, decide by VERSION not watermark value
  }
  ```

- **Loser behavior on CAS conflict (drift T10):** re-read the row. If
  `version` moved and the watermark now covers my prefix → **SKIP** (winner
  already compacted; safe no-op) **and clear dirty**. Else retry **once**; second
  conflict → SKIP + `log.warn(contended)`. No recompute-loop, no livelock.
- **Invalidation (drift C4 + R1):** if any message at/below `summaryWatermark` is
  edited/deleted/regenerated, the summary is stale. The edit/delete/regenerate
  handler calls `writeWatermark` to **bump version + clear `contextSummary` +
  reset watermark** to the last unaffected message — all in one CAS write. Because
  the loser compares **version** (not watermark value), a compaction racing an
  invalidation sees a conflict and re-reads the reset state — it can never write a
  stale summary over mutated history. Branch/regenerate that forks below the
  watermark resets it on the new branch.

### D. Tier 2 — intra-turn compaction (in-memory)

For a single response with many tool/sub-agent calls that bloats the window
mid-loop. Uses `prepareStep` on both `streamText` and `generateText`.
Operates on **ModelMessages** via `compactModelMessages`.

`prepareStep({ messages, stepNumber, steps })`:

- Estimate current step tokens (same `estimateTokens`, P2); if `>= threshold`:
  - Summarize **old completed** tool results (steps several back), keep recent
    steps verbatim, preserve call/result pairing.
  - Return `{ messages: compacted }`.
- **Only fire when genuinely near limit** (drift m3 — mid-step summary adds
  latency; don't run it every step).

**Not persisted.** `prepareStep` edits are throwaway per-call — the SDK keeps its
own canonical message list and returns the _full_ messages in
`result.response.messages`, which commit to history as normal. Next turn, Tier 1
folds that finished (still-bloated) turn into the durable summary. Tier 2 only
keeps a heavy response executable; Tier 1 owns durable state.

### E. Recovery — context-overflow error handling (P4)

In `agent-runner.ts` (around `formatStreamError`, `:636-657`):

- `isContextOverflowError(err)` — `APICallError.isInstance(err)` AND
  (`statusCode` in {400, 413}) AND body matches
  `/context length|context_length_exceeded|prompt is too long|too many tokens|maximum context/i`.
- On detect mid-run:
  1. In-memory aggressive trim via **`compactModelMessages`** with a smaller
     `keepRecentMessages` (drift T3 — reuse the Tier 2 adapter, **no bespoke
     trim**, or T1 divergence returns).
  2. Retry the call **once**.
  3. Persist `compactionDirty = true` via `writeWatermark` (a small standalone
     UPDATE, independent of the stream's finalize — drift T3). Recovery **never**
     writes summary/watermark directly; it only flags.
  4. If retry still fails, surface: "Conversation too large even after trimming —
     start a new chat or reduce attachments." (No infinite retry.)
- **Durable compaction happens on the NEXT `prepareChatTurn`** (drift T3 —
  chosen path, not "finalize-or-next"): it sees `compactionDirty`, forces Tier 1
  before building messages, and clears the flag inside the same CAS write that
  advances the watermark. `compactionDirty` is **persisted** so a crashed/swapped
  worker still resumes correctly.

### F. Wiring for sub-agents

`ToolLoopAgent` constructor takes `contextWindow` + `maxOutputTokens` +
compaction config. Sub-agent tool creation (`sub-agent.ts:56-159`) already builds
a `ToolLoopAgent` per sub-agent — resolve each sub-agent model's window and pass
it through.

**Tier 2 only (drift M3):** sub-agents start fresh each invocation (only a `task`
string, no cross-turn history), so there is no durable history for Tier 1 to
compact. Just pass the window so `prepareStep` (Tier 2) fires if a sub-agent's own
tool loop bloats. Recovery (§E) covers them too since `agent-runner` is shared.

### G. Config surface + kill switch

Per-agent (and/or per-workspace) optional fields, with sane defaults:

- `compactionEnabled` (default true)
- `triggerRatio` (default 0.8), `targetRatio` (default 0.5),
  `reserveRatio` (default 0.05), `keepRecentMessages` (default 10),
  `minPrunableChars` (default ~2000)

Add to agent schema (`packages/schemas`, agent table) — optional, defaulted.

**Global kill switch:** env `COMPACTION_ENABLED` (default true) disables all
proactive compaction (Tier 1 + Tier 2) in prod without a deploy. **Recovery (§E)
ignores this flag** — it is the safety net (P4).

### H. Frontend context-usage indicator (the ring)

1. **Backend emits usage to client.** On run finish, include
   `{ inputTokens, contextWindow }` in the streamed message metadata. Today usage
   is run-level only (`types.ts:8-13`); surface last input-token count + resolved
   window per assistant message.
2. **New component** `apps/frontend/components/context-usage-ring.tsx` — small
   SVG/conic-gradient ring, fill = `inputTokens / contextWindow`. Color ramps
   (green → amber ≥0.7 → red ≥0.9). **Neutral grey, no fill %, when the window is
   unknown/default** (drift T6). Wrapped in `Tooltip`.
3. **Placement** — in `PromptInputTools` between the model selector and the `(i)`
   info icon (`chat.tsx:574-575`).
4. **Data source (drift U1):** resolve the window from the **currently selected
   model** (frontend already holds it in `PromptInputTools`; expose via the
   provider/model metadata API / `modelMeta` map), NOT from the last assistant
   message's metadata — else the ring shows the previous model's window after a
   model switch. Fill = `lastInputTokens / selectedModelWindow`.
5. **Tooltip label is REQUIRED, not optional (drift U2/m2):**
   `Last response: N / W (NN%) · current input not yet counted`. The ring reflects
   the last response, not the unsent composer input — say so. (Projected-input arc
   is deferred, see Open.)

### I. Per-message stats popover (next to Regenerate)

An `(i)` action under each assistant response showing input tokens, output
tokens, TTFT, and total generation time. Hover = tooltip, click = popover.

**Reuse the existing tool-call duration mechanism** (commits c18c18d / b97312f) —
`withToolTimestamps` + `applyToolCompletions` (`agent-runner.ts:63-120`),
`useToolDuration` + `formatDurationMs` (`hooks/use-tool-completed-at.ts`,
`lib/utils.ts:29-49`).

Backend (`agent-runner.ts`):

- Capture `startedAt` at run start, `firstTokenAt` at the first text-delta chunk,
  `finishedAt` when the stream finalizes (the `applyToolCompletions` point, `:443`).
- Capture token usage from `onFinish` / `totalUsage` (`:148-194`).
- Stamp onto `message.metadata` **at the `applyToolCompletions` point, NOT the
  `messageMetadata` callback** (which fires at message start before timing/usage
  exist). Shape:
  `metadata.stats = { inputTokens, outputTokens, startedAt, firstTokenAt, finishedAt }`.

Frontend:

- New `MessageAction` info icon in `chat-message.tsx:335-378`, beside Regenerate,
  rendered when `metadata.stats` exists.
- Content: `Input: N · Output: N`, `TTFT: formatDurationMs(firstTokenAt − startedAt)`,
  `Total: formatDurationMs(finishedAt − startedAt)`.
- TTFT/total are **server-measured**. Optional client-observed "Round-trip" line
  from the `useChat` send timestamp. Reuse `formatDurationMs`; mirror the
  client-observed fallback in `useToolDuration` for in-flight messages.

### J. Clickable ring — compact on demand

Make the §H ring actionable. **Remember P1: this compacts the model view, not the
stored history — it is not destructive in the data sense.**

- **Hover** — tooltip with percentage filled (already in H).
- **Click** — request compaction. If a response is generating, defer until the
  current message finishes, then run; if idle, run immediately.

Backend endpoint `POST /chats/:id/compact` (`routes/chat.ts`):

- Runs Tier 1 compaction once **regardless of threshold** (force), persists via
  `writeWatermark`, returns the new resolved usage (`inputTokens` estimate after
  compaction + `contextWindow`) so the ring refreshes immediately.
- Reuses the Tier 1 `compaction.ts` module.

Frontend:

- Ring `onClick` → if `status === "streaming"`, set a pending flag and fire on the
  chat's finish callback; else call now.
- **Pending-while-streaming visual (drift U4):** ring shows a pending badge +
  tooltip "will compact when response finishes", and is **disabled** (no
  re-click). On finish → spinner → updated fill from the response.
- **Confirm default-ON when the drop is significant (drift U3):**
  `messagesDropped > keepRecentMessages` OR estimated reduction `> 30%` of history
  → confirm. Below that → immediate, no prompt. (Confirm is UX courtesy; per P1 no
  data is destroyed regardless.)

---

## File-by-file change list

Backend:

- `apps/backend/src/runs/context-window.ts` — **new**: window resolution + API
  auto-detect + litellm registry w/ key normalization + cache + evict hook.
- `apps/backend/src/runs/token-estimate.ts` — **new**: single `estimateTokens` +
  `toCountUnits` adapters + image modality table + header-parse dims.
- `apps/backend/src/runs/compaction.ts` — **new**: `compactUIMessages` (Tier 1) +
  `compactModelMessages` (Tier 2 + recovery) + shared leaf primitives +
  `writeWatermark` CAS.
- `apps/backend/src/runs/agent-runner.ts` — `prepareStep` (Tier 2) on
  `streamText`/`generateText`; `isContextOverflowError` + retry-once recovery
  (reuses `compactModelMessages`, sets `compactionDirty`); pass `contextWindow`
  through; emit usage metadata; capture `startedAt`/`firstTokenAt`/`finishedAt` +
  usage and stamp `metadata.stats` at the `applyToolCompletions` point (§I).
- `apps/backend/src/services/chat-execution.ts` — Tier 1 in `prepareChatTurn`
  (after `inlineFileUrls`); resolve window; check/clear `compactionDirty`; all
  state writes via `writeWatermark`.
- `apps/backend/src/routes/chat.ts` — `POST /chats/:id/compact` (§J).
- `apps/backend/src/routes/provider.ts` — `cache.evict(providerId)` on modelMeta
  update (drift T5).
- `apps/backend/src/tools/sub-agent.ts` — pass per-sub-agent window/config.
- `apps/backend/src/db/schema.ts` — `provider.modelMeta` JSONB; chat/run
  `contextSummary` + `summaryWatermark` + `compactionDirty` + `version`; agent
  compaction fields.
- message edit/delete/regenerate handlers — call `writeWatermark` to invalidate
  (version bump + clear summary + reset watermark) (drift C4/R1).

Schemas:

- `packages/schemas/index.ts` — provider `modelMeta`; agent compaction fields;
  message-metadata usage + stats shape for the frontend.

Frontend:

- `apps/frontend/components/context-usage-ring.tsx` — **new**: ring (window from
  selected model), hover tooltip, clickable force-compact, pending/disabled state.
- `apps/frontend/components/chat.tsx` — render ring; resolve selected-model window;
  wire `onClick` → compact endpoint (defer while streaming).
- `apps/frontend/components/chat-message.tsx` — `(i)` stats `MessageAction` (§I).
- `apps/frontend/hooks/use-message-stats.ts` — **new** (optional): client-observed
  timing fallback for in-flight messages.

Migration:

- Additive nullable columns via `pnpm drizzle-kit-push` (dev). Prod via
  `scripts/migrate.ts`.
- **Lazy rollout (item 3):** existing chats get `version=0`, null summary,
  `compactionDirty=false`. They do **NOT** eagerly compact on deploy — Tier 1 only
  fires on each chat's next turn. **Do not add a backfill job** "to be safe" — it
  would create a thundering herd of summarize calls that lazy rollout avoids.

---

## Observability (item 4 — the design is only as good as the prod signal)

Emit metrics (not just logs):

- `compaction.fired{tier}`, `tokens_before` / `tokens_after`
- `summarize.latency_ms`, `summarize.model`
- `recovery.overflow_detected`, `recovery.retry`, `recovery.failed`
- `estimate_vs_real.divergence` (drift T2 feedback loop)
- `context_window.fell_to_default` + `litellm.key_miss` (drift T4/T6)
- `cas.conflict` — **decides whether the R4 efficiency note ever needs fixing**.
  Without this counter, contention is a guess.

---

## Tests

- `context-window`: resolution order; API parse for Google / OpenRouter / vLLM;
  litellm hits **incl. key normalization + Bedrock ARN / Azure / MISS→default**
  (drift T4); default fallback; cache evict-on-override (drift T5).
- `token-estimate`: char/4 text-only bounds; **`MODEL_BOUND` filter — UI-only
  parts excluded**; **`estimate(toCountUnits(ui)) === estimate(toCountUnits(convert(ui)))`
  exact on the filtered set** (drift T1); image modality table (constant, not
  char/4) + header-parse dims + missing-dims fallback (drift T2); estimate runs
  after inline.
- `compaction`: preserves tool-call/result pairing **both UIMessage and
  ModelMessage shapes**; respects `keepRecentMessages`; incremental watermark
  folding; prune Stage 1 reaches target without a model call when possible;
  hysteresis — output `<= targetTokens`, does not re-fire next turn; chunked
  summarize over an oversized prefix; **summarizer model fallback** when
  `taskModelId` unset (drift T7).
- `budget`: window − output reserve − safety reserve; trigger counts new
  (unsummarized) messages, not just last response (drift C1).
- `writeWatermark` / CAS (drift R1/T10): concurrent writers — one wins
  (`rowCount===1`), loser re-reads, decides by **version** not watermark value;
  loser SKIPs + clears dirty when winner advanced; one-retry-then-skip, no
  livelock; **invalidation reset bumps version and a racing compaction sees a
  conflict** (never writes stale summary over mutated history).
- `watermark-invalidation`: editing/deleting a message ≤ watermark clears summary,
  resets watermark, bumps version (drift C4).
- `agent-runner`: `prepareStep` trims old tool results only, fires only near limit
  (drift m3); overflow-error detection true/false matrix **across per-provider
  error bodies** (OpenAI / Anthropic / Google-vLLM fixtures, drift T9); retry-once
  **reuses `compactModelMessages`** (drift T3); sets `compactionDirty`; then clean
  failure.
- `recovery-persistence` (drift T3): after recovery, next `prepareChatTurn` sees
  `compactionDirty`, forces Tier 1, clears flag — and the next turn does **not**
  re-overflow; recovery never writes summary directly.
- Integration: synthetic long history → Tier 1 compacts + persists; injected 400
  overflow → recovery retries + succeeds; sub-agent inherits window (Tier 2 only).
- `message-stats`: `startedAt`/`firstTokenAt`/`finishedAt` captured in order;
  metadata stamped at `applyToolCompletions`, not message-start; TTFT/total format.
- `compact-endpoint`: force-compaction advances watermark (via `writeWatermark`)
  and returns refreshed usage; defers/queues while a run is mid-stream.
- Frontend: ring window comes from selected model not last-message metadata
  (drift U1); neutral state on unknown window (drift T6); pending/disabled while
  streaming (drift U4); confirm fires above the §J threshold (drift U3).

---

## Sequencing

1. Window resolution + single estimator + schema (`modelMeta`, `version`,
   `compactionDirty`, summary/watermark) — foundation. **✅ DONE** (open defects:
   empty prod registry, T5 evict, cache-pins-default — see Review §).
2. Compaction module + `writeWatermark` CAS + Tier 1 (cross-turn, persist).
   **✅ DONE** (open defects: C1 trigger under-count, M2 margin, summarizerWindow
   not threaded — see Review §).
3. Recovery (overflow detect + retry-once + dirty flag). **← NEXT** (hand-off ready;
   fold in the C1 fix — see Review §).
4. Tier 2 (`prepareStep`, in-memory).
5. Sub-agent wiring (Tier 2 only).
6. Frontend usage metadata + ring (§H).
7. Per-message stats popover (§I) — depends on metadata stamping from step 6.
8. Clickable ring → compact endpoint (§J) — depends on Tier 1 (step 2).
9. Per-agent config surface + `COMPACTION_ENABLED` kill switch.

Steps 1–3 deliver the core "no more hard fails" value; 4–9 are progressive
enhancement. Each step independently testable.

---

## Open / deferred decisions

- **OpenAI-compatible as a separate provider type** — not required (auto-detect
  probes `max_model_len` regardless of label). Deferred.
- **Persisting Tier 2** — deferred; revisit only if storing tool outputs verbatim
  is itself a problem.
- **Anthropic exact token counting** via `/v1/messages/count_tokens` — optional
  accuracy upgrade; deferred.
- **Projected-input arc on the ring (drift U2)** — char/4 of composer text added
  as a faint arc. Deferred; the honest tooltip label ships instead.
- **CAS contention optimization (drift R4)** — under a contended chat, the
  version is read → summarize (seconds) → CAS write, so the version can be stale
  by write time → wasted summarize (not corruption; loser skips safely). Bounded
  by one-retry-then-skip. **Do NOT fix now.** Gated on the `cas.conflict` metric;
  if it shows repeated waste, move the version read to just-before-write or take a
  short advisory lock for the summarize window.
- **Trigger estimator scope — CONFIRMED bug (drift C1), see Review § defect 1.**
  Originally flagged from live test 2026-06-03; the 2026-06-09 code review confirmed
  it is unfixed in chunk 2 (`compaction.ts:719`, no `lastInputTokens` plumbing).
  Promote from "possible" to a chunk-3 must-fix.
  Tier 1's projection in `compaction.ts` only estimates `messages` (char/4 over
  the stored UIMessages). System prompt, tool schemas, skill prompts, and
  sub-agent context — all sent to the model on every turn — are invisible to the
  trigger. Observed gap on Qwen3.6 / vLLM with a tool-bearing agent: provider
  reported 8888 `inputTokens` while the local estimate was ~986 (≈ 3× under).
  Trigger never fired against the 8192 fallback; only fired after forcing
  `model_meta.contextWindow = 4096` to drop the threshold below the
  under-counted estimate. Two paths to consider, not mutually exclusive:
  1. Extend the estimator (or the projection at the call site) to include the
     system + tool-schema + skill payload that `chat-execution` actually puts on
     the wire — same `CountUnit[]` shape, just more inputs.
  2. Wire the ADR-prescribed "use provider `usage.inputTokens` from the prior
     turn as the corrective baseline for turns ≥2" (ADR §"Char/4 estimate, not
     a real tokenizer"). Chunks 1-2 left this half-implemented — the design
     calls for it; the code uses char/4 every turn.

  Re-verify: a unit test with an agent carrying realistic tool schemas + a
  short message history should show the projection ≥ the provider's reported
  `inputTokens` (within margin), and the trigger should fire **before** the
  provider's count crosses the budget. Currently the asymmetry lets real input
  blow past the trigger silently.

---

## Drift log & code-review checklist

Every issue found across 4 review rounds, the resolution, and **the exact thing
to re-verify once the code exists.** Round trajectory: R1 design holes → R2
second-order effects → R3 a third-order race → R4 zero correctness findings (one
telemetry-gated note). This is the anti-regression list — check it at PR time.

| ID      | Issue                                                                                      | Resolution                                                                                                                                             | ✅ Verify in code                                                                                                                              |
| ------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **C1**  | Trigger only counted last response, not what this turn adds                                | `projected = lastInputTokens + estimate(newMsgs)`                                                                                                      | Trigger sums unsummarized new messages, not just last `usage`                                                                                  |
| **C2**  | Compacting to the trigger ratio re-fires next turn (Cline #5616 thrash)                    | Hysteresis: target 0.5 ≠ trigger 0.8                                                                                                                   | Post-compaction output `<= targetTokens`; a follow-up turn does not re-compact                                                                 |
| **C3**  | Raw window ratio ignored output + safety headroom                                          | `inputBudget = window − maxOutputReserve − safetyReserve`                                                                                              | Budget subtracts both reserves before ratios                                                                                                   |
| **C4**  | Edit/delete/regenerate below watermark → stale summary                                     | Invalidate via `writeWatermark`: version bump + clear summary + reset watermark                                                                        | Every edit/delete/regenerate handler calls `writeWatermark`; forking below watermark resets on new branch                                      |
| **M1**  | Cold-start on huge imported history exceeds summarizer's own window                        | Chunked / map-reduce summarize                                                                                                                         | Prefix larger than summarizer window is chunked, not sent whole                                                                                |
| **M2**  | First-turn char/4 underestimate                                                            | `× 1.15` margin + recovery net                                                                                                                         | First-turn projection applies the margin                                                                                                       |
| **M3**  | "Both tiers apply to sub-agents" was wrong                                                 | Sub-agents = Tier 2 only (no durable history)                                                                                                          | Sub-agent path wires Tier 2 + window only, no Tier 1                                                                                           |
| **T1**  | Tier 1 (UIMessage) and Tier 2 (ModelMessage) measured by different estimators → divergence | **One** `estimateTokens` over `CountUnit[]`, two adapters; `MODEL_BOUND` filter excludes UI-only parts both sides                                      | No second estimator exists; equality test passes exactly on filtered set; UI-only parts (reasoning/source/step/data) never counted             |
| **T2**  | char/4 on base64 images is meaningless; ordering vs inline unclear                         | Modality table (anthropic/openai/default), header-parse dims w/ constant fallback, detail→high; estimate AFTER `inlineFileUrls`; divergence `log.warn` | No char/4 on image bytes; Tier 1 runs post-inline; missing dims → 1200; turn-2 divergence logged                                               |
| **T3**  | Recovery compaction vs "single durable writer"; finalize-mid-error ambiguous               | Recovery does in-memory trim via `compactModelMessages` + sets persisted `compactionDirty`; durable write on NEXT `prepareChatTurn` only               | Recovery never writes summary/watermark directly; `compactionDirty` is a DB column; recovery trim calls the Tier 2 adapter, not a bespoke trim |
| **T4**  | litellm registry keys don't match our model IDs                                            | Normalization chain + alias map + `log.warn` on MISS                                                                                                   | Lookup tries exact→strip-prefix→lower→alias→family; Bedrock ARN / Azure resolve or log a miss                                                  |
| **T5**  | Window cache stale after override edit                                                     | `cache.evict(providerId)` in provider PATCH, immediate                                                                                                 | Editing modelMeta busts cache without waiting TTL                                                                                              |
| **T6**  | 8192 default silently over-compacts                                                        | `log.warn` on default; ring renders **neutral**, no false ramp                                                                                         | Fall-to-default is logged; ring is grey/no-% when window unknown                                                                               |
| **T7**  | `taskModelId` may be unset                                                                 | Fallback `taskModelId → main`; log model + cost                                                                                                        | Summarizer falls back to main model; no crash on unset                                                                                         |
| **T8**  | char/4 underestimates CJK/JSON                                                             | Accepted; margin + real-usage handoff + recovery net                                                                                                   | (No code; documented as text-only heuristic)                                                                                                   |
| **T9**  | One synthetic 400 doesn't cover per-provider error bodies                                  | Fixture set: OpenAI / Anthropic / Google-vLLM                                                                                                          | `isContextOverflowError` matrix tests real per-provider phrasings                                                                              |
| **T10** | CAS rejects stale write but loser behavior undefined → livelock risk                       | Re-read; if winner advanced → SKIP+clear-dirty; else retry once then SKIP                                                                              | Loser never recompute-loops; terminal state is skip; decides by version                                                                        |
| **R1**  | Loser-skip assumed monotonic watermark; C4 reset moves it backward → stale write back door | All writes (advance/reset/dirty) through one versioned CAS; loser compares **version** not watermark value                                             | Single `writeWatermark`; invalidation bumps version; no path mutates these fields outside it                                                   |
| **U1**  | Ring showed previous model's window after a model switch                                   | Resolve window from **selected** model, not last-message metadata                                                                                      | Ring reads selected-model window from `modelMeta`, refreshes on switch                                                                         |
| **U2**  | Ring lags pending composer input                                                           | Required tooltip label "current input not yet counted"; arc deferred                                                                                   | Tooltip text present and unmistakable                                                                                                          |
| **U3**  | Forced-compact confirm too soft                                                            | Confirm default-ON when drop significant (`>keepRecent` or `>30%`)                                                                                     | Threshold confirm wired; (P1: not destructive anyway)                                                                                          |
| **U4**  | No feedback for defer-while-streaming click                                                | Pending badge + disabled ring + "will compact on finish" tooltip                                                                                       | Ring disables + shows pending state between click and finish                                                                                   |
| **R4**  | CAS read→summarize→write window wastes summarize under contention                          | Accepted, **not fixed**; gated on `cas.conflict` metric                                                                                                | `cas.conflict` metric emitted; no premature lock added                                                                                         |
| **P1**  | (principle) compaction misread as data loss                                                | View-not-delete: raw messages persist                                                                                                                  | No code path hard-deletes a summarized message                                                                                                 |

---

## Appendix: prior art & review

### Prior art (open-source tools surveyed)

| Tool                | Strategy                                 | Window source             | Threshold                             | Pitfall                           |
| ------------------- | ---------------------------------------- | ------------------------- | ------------------------------------- | --------------------------------- |
| Open WebUI          | none (BYO filter), errors out            | `num_ctx` (Ollama only)   | n/a                                   | silent overspend on API providers |
| LibreChat           | **both**: prune tool results → summarize | `maxContextTokens` (yaml) | trigger on prune; `reserveRatio` 0.05 | ignored on some endpoints         |
| LangGraph           | `trim_messages` vs `SummarizationNode`   | you supply                | you set                               | trim breaks tool pairs            |
| llama.cpp           | context-shift or HTTP 400                | `--ctx-size`, `--keep N`  | off by default                        | infinite shift loop / hard 400    |
| Ollama              | silent clip                              | `num_ctx` (default 2048)  | clips                                 | silent token loss                 |
| Cline / Claude Code | **summarize at %**                       | reads window, live meter  | `autoCondenseThreshold`               | **thrash (cline #5616)**          |
| OpenRouter          | middle-out truncate (gateway)            | `/models.context_length`  | on overflow                           | drops middle silently             |
| litellm             | `trim_messages` (trim_ratio 0.75)        | **model registry JSON**   | ratio                                 | orphaned tool-call msgs           |

Borrowed: litellm registry (§A), `reserveRatio` headroom (§C), prune-then-summarize
staging (§C), hysteresis vs thrash (§C), fail-loud event (§C), live usage meter (§H).

Sources: Open WebUI context-window docs + discussions #4983/#6402; LibreChat
summarization/model_specs/token_usage docs; LangGraph add-memory docs; llama.cpp
server README + issues #17284/#3969; Cline auto-compact docs + issue #5616;
litellm token_usage/message_trimming docs + `model_prices_and_context_window.json`;
OpenRouter models + message-transforms docs; vLLM engine args.

### Review change log (applied to this doc)

- **C1–C4, M1–M3** — see drift table.
- **A** litellm registry replaces homegrown lookup table.
- **T1–T10, R1, R4, U1–U4** — round 2-4 findings, see drift table.
- **P1–P4** — design principles extracted from the review consensus.
- Added: prune-before-summarize Stage 1, fail-loud `context-compacted` event,
  Observability section, global kill switch, lazy-rollout note, ADR (queued:
  `docs/adr/NNNN-context-compaction.md` capturing the _why_ — two tiers,
  view-not-delete, CAS-on-version, char/4-not-tokenizer).
