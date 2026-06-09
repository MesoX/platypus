/**
 * The single token estimator (context-compaction-plan §B, principle P2).
 *
 * Token counting lives in **exactly one** function — {@link estimateTokens} —
 * over **one** neutral structure ({@link CountUnit}). Tier 1 operates on
 * UIMessages and Tier 2 on ModelMessages; both normalize into `CountUnit[]` via
 * the adapters here, so the two tiers can never diverge on a count (drift T1).
 *
 * Hard rules baked in:
 *  - **char/4 applies to text only.** Tool-call inputs and tool-result outputs
 *    are text-like to the model, so they fold into a unit's `text`. Image /
 *    binary bytes are NEVER char/4'd — they go through the modality table
 *    ({@link nonTextTokens}, drift T2).
 *  - **UI-only parts are excluded on both sides.** `reasoning`, `source-url`,
 *    `source-document`, `step-start`, and `data-*` never reach the model, so
 *    they are dropped by both adapters (drift T1).
 *  - The estimate is content-only — **no per-message role framing overhead** —
 *    so the total is invariant to how messages are grouped. That is what lets
 *    the UIMessage and ModelMessage adapters agree exactly even though
 *    `convertToModelMessages` splits one UI message into several model messages.
 *
 * Used only on the very first turn, before any provider `usage.inputTokens`
 * exists; every later turn uses the real provider count.
 */

import type { ModelMessage, ToolResultPart, DataContent } from "ai";
import type { PlatypusUIMessage } from "../types.ts";

/** Number of characters approximated as one token (text only). */
export const CHARS_PER_TOKEN = 4;

/**
 * Conservative flat cost for a non-text part whose true cost we cannot compute
 * (unknown provider, missing image dimensions, non-image binary file). Over-
 * counting beats overflow (drift T2).
 */
export const DEFAULT_NONTEXT_TOKENS = 1200;

/** OpenAI's flat cost for a `detail: "low"` image, independent of size. */
const OPENAI_LOW_DETAIL_TOKENS = 85;

/**
 * The provider families with a known image-cost formula. Everything else maps
 * to `"default"` and pays the conservative flat cost.
 */
export type ImageProvider = "anthropic" | "openai" | "default";

/**
 * A non-text, model-bound part reduced to what the estimator needs: which
 * provider formula applies, and (when known) the decoded pixel dimensions.
 * `width`/`height` undefined → the provider's missing-dimension fallback.
 */
export type NonTextPart = {
  provider: ImageProvider;
  width?: number;
  height?: number;
  /** OpenAI image detail hint. Unset is treated as `"high"` (over-count). */
  detail?: "low" | "high";
};

/** Message role, neutral across UIMessage and ModelMessage shapes. */
export type CountRole = "system" | "user" | "assistant" | "tool";

/**
 * The neutral counting structure. One per source message. `text` is the
 * char/4'd blob (text parts + serialized tool input/output); `nonText` holds
 * images/binaries counted via the modality table.
 */
export type CountUnit = {
  role: CountRole;
  text: string;
  nonText: NonTextPart[];
};

/**
 * UIMessage part `type`s that reach the model and are therefore counted. Kept
 * as data so the test can assert the UI-only parts are excluded (drift T1).
 * Tool parts are matched separately by the `tool-`/`dynamic-tool` prefix.
 */
export const MODEL_BOUND_UI_PART_TYPES = ["text", "file"] as const;

// ---------------------------------------------------------------------------
// The estimator (the one function — P2)
// ---------------------------------------------------------------------------

function nonTextTokens(part: NonTextPart): number {
  const { provider, width, height, detail } = part;

  if (width == null || height == null) {
    // Dimensions unknown. OpenAI low-detail has a flat cost even without dims;
    // everything else falls to the conservative default.
    if (provider === "openai" && detail === "low")
      return OPENAI_LOW_DETAIL_TOKENS;
    return DEFAULT_NONTEXT_TOKENS;
  }

  switch (provider) {
    case "anthropic":
      // Anthropic's documented approximation: tokens ≈ (w × h) / 750.
      return Math.ceil((width * height) / 750);
    case "openai":
      return detail === "low"
        ? OPENAI_LOW_DETAIL_TOKENS
        : openaiHighDetailTokens(width, height);
    default:
      return DEFAULT_NONTEXT_TOKENS;
  }
}

/**
 * OpenAI's high-detail tiling cost (gpt-4o family): fit within 2048×2048, scale
 * the shortest side to 768, then 85 base + 170 per 512px tile.
 */
function openaiHighDetailTokens(w: number, h: number): number {
  let width = w;
  let height = h;
  const longest = Math.max(width, height);
  if (longest > 2048) {
    const scale = 2048 / longest;
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const shortest = Math.min(width, height);
  if (shortest > 768) {
    const scale = 768 / shortest;
    width = Math.round(width * scale);
    height = Math.round(height * scale);
  }
  const tiles = Math.ceil(width / 512) * Math.ceil(height / 512);
  return 85 + 170 * tiles;
}

/**
 * The single estimator. Sums char/4 of each unit's text plus the modality-table
 * cost of each non-text part. Content-only, role-agnostic (see file header).
 */
export const estimateTokens = (units: CountUnit[]): number => {
  let total = 0;
  for (const unit of units) {
    total += Math.ceil(unit.text.length / CHARS_PER_TOKEN);
    for (const part of unit.nonText) total += nonTextTokens(part);
  }
  return total;
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic JSON with sorted keys, so the same value serializes to the same
 * string from either adapter (the UIMessage and ModelMessage shapes must agree
 * exactly — drift T1). Cheaper than guarding key order at every call site.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object")
    return JSON.stringify(value) ?? "";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(",")}}`;
}

function isImageMediaType(mediaType: string | undefined): boolean {
  return typeof mediaType === "string" && mediaType.startsWith("image/");
}

/**
 * Builds a {@link NonTextPart} for an image, parsing pixel dimensions from the
 * bytes when available (drift T2: a cheap header read, no full decode).
 */
function imagePart(
  provider: ImageProvider,
  bytes: Uint8Array | undefined,
  detail?: "low" | "high",
): NonTextPart {
  const dims = bytes ? parseImageDimensions(bytes) : undefined;
  return { provider, width: dims?.width, height: dims?.height, detail };
}

/** A non-image binary file: conservative flat cost, no formula. */
function binaryPart(): NonTextPart {
  return { provider: "default" };
}

// ---------------------------------------------------------------------------
// Image dimension parsing (cheap header parse — PNG IHDR / JPEG SOF)
// ---------------------------------------------------------------------------

/**
 * Reads pixel dimensions from PNG / JPEG headers without decoding the image.
 * Returns undefined for unrecognized formats or truncated data — the caller
 * then falls to the conservative constant (drift T2).
 */
export function parseImageDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | undefined {
  // PNG: 8-byte signature, then IHDR chunk with width@16, height@20 (BE).
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }

  // JPEG: 0xFFD8 start, then walk segment markers to the SOF that carries dims.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = bytes[offset + 1];
      // SOF0..SOF15 carry frame dimensions, excluding DHT(C4)/JPG(C8)/DAC(CC).
      const isSof =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc;
      if (isSof) {
        const view = new DataView(
          bytes.buffer,
          bytes.byteOffset,
          bytes.byteLength,
        );
        const height = view.getUint16(offset + 5);
        const width = view.getUint16(offset + 7);
        return { width, height };
      }
      // Standalone markers (RST, SOI, EOI) have no length; skip 2 bytes.
      if (
        marker === 0xd8 ||
        marker === 0xd9 ||
        (marker >= 0xd0 && marker <= 0xd7)
      ) {
        offset += 2;
        continue;
      }
      const segLength = (bytes[offset + 2] << 8) | bytes[offset + 3];
      if (segLength < 2) return undefined;
      offset += 2 + segLength;
    }
  }

  return undefined;
}

/**
 * Decodes the bytes behind a UIMessage file URL when it is a base64 data URL.
 * Hosted (http/https) URLs return undefined — we have no bytes in hand, so the
 * caller falls to the conservative constant.
 */
function bytesFromUrl(url: string): Uint8Array | undefined {
  const match = /^data:[^;,]*;base64,(.*)$/s.exec(url);
  if (!match) return undefined;
  try {
    return new Uint8Array(Buffer.from(match[1], "base64"));
  } catch {
    return undefined;
  }
}

/** Normalizes the various ModelMessage byte containers into a Uint8Array. */
function bytesFromDataContent(data: DataContent | URL): Uint8Array | undefined {
  if (typeof data === "string") return bytesFromUrl(data);
  if (data instanceof URL) return undefined;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(data)) {
    return new Uint8Array(data);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Tier 1 adapter — UIMessage → CountUnit (one unit per message)
// ---------------------------------------------------------------------------

function uiMessageToCountUnit(
  message: PlatypusUIMessage,
  provider: ImageProvider,
): CountUnit {
  let text = "";
  const nonText: NonTextPart[] = [];

  for (const part of message.parts ?? []) {
    const type = part.type;

    if (type === "text") {
      text += (part as { text: string }).text;
      continue;
    }

    if (type === "file") {
      const file = part as { mediaType?: string; url: string };
      const bytes = bytesFromUrl(file.url);
      if (isImageMediaType(file.mediaType)) {
        nonText.push(imagePart(provider, bytes));
      } else {
        nonText.push(binaryPart());
      }
      continue;
    }

    // Tool invocations (`tool-<name>` and `dynamic-tool`) are model-bound and
    // text-like: fold their input + output into the char/4 blob.
    if (type === "dynamic-tool" || type.startsWith("tool-")) {
      const tool = part as { input?: unknown; output?: unknown };
      if (tool.input !== undefined) text += stableStringify(tool.input);
      if (tool.output !== undefined) text += stableStringify(tool.output);
      continue;
    }

    // Everything else (reasoning, source-url, source-document, step-start,
    // data-*) is UI-only and excluded on both sides (drift T1).
  }

  return { role: message.role, text, nonText };
}

/** Tier 1 adapter: UIMessages → neutral count units. */
export function uiMessagesToCountUnits(
  messages: PlatypusUIMessage[],
  provider: ImageProvider = "default",
): CountUnit[] {
  return messages.map((m) => uiMessageToCountUnit(m, provider));
}

// ---------------------------------------------------------------------------
// Tier 2 adapter — ModelMessage → CountUnit (one unit per message)
// ---------------------------------------------------------------------------

/** Extracts the model-visible string from a tool-result output wrapper. */
function toolResultOutputText(output: ToolResultPart["output"]): string {
  switch (output.type) {
    case "text":
    case "error-text":
      // Mirrors the UI side, which folds the raw string output via
      // stableStringify (JSON.stringify of a string == the quoted string).
      return stableStringify(output.value);
    case "json":
    case "error-json":
      return stableStringify(output.value);
    case "content":
      return stableStringify(output.value);
    case "execution-denied":
      return stableStringify(output.reason ?? "");
    default:
      return "";
  }
}

function modelMessageToCountUnit(
  message: ModelMessage,
  provider: ImageProvider,
): CountUnit {
  const role = message.role;
  let text = "";
  const nonText: NonTextPart[] = [];

  const { content } = message;
  if (typeof content === "string") {
    return { role, text: content, nonText };
  }

  for (const part of content) {
    switch (part.type) {
      case "text":
        text += part.text;
        break;
      case "tool-call":
        text += stableStringify(part.input);
        break;
      case "tool-result":
        text += toolResultOutputText(part.output);
        break;
      case "image": {
        const img = part;
        nonText.push(imagePart(provider, bytesFromDataContent(img.image)));
        break;
      }
      case "file": {
        const file = part;
        if (isImageMediaType(file.mediaType)) {
          nonText.push(imagePart(provider, bytesFromDataContent(file.data)));
        } else {
          nonText.push(binaryPart());
        }
        break;
      }
      // reasoning / tool-approval-* are UI-only or control parts — excluded.
      default:
        break;
    }
  }

  return { role, text, nonText };
}

/** Tier 2 adapter: ModelMessages → neutral count units. */
export function modelMessagesToCountUnits(
  messages: ModelMessage[],
  provider: ImageProvider = "default",
): CountUnit[] {
  return messages.map((m) => modelMessageToCountUnit(m, provider));
}

/**
 * Maps a provider `providerType` (as stored on the provider row) to the image
 * cost family. Bedrock most commonly serves Anthropic models, so it maps to
 * `anthropic`; OpenRouter is heterogeneous and maps to `default`.
 */
export function imageProviderFor(providerType: string): ImageProvider {
  switch (providerType) {
    case "Anthropic":
    case "Bedrock":
      return "anthropic";
    case "OpenAI":
      return "openai";
    default:
      return "default";
  }
}
