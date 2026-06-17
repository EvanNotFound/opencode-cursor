/**
 * Maps OpenCode conversation anchors to cursor-agent chat IDs for --resume.
 *
 * OpenCode does not pass its session ID through the HTTP proxy, so we derive a
 * stable key from workspace + model + first real user message in the request.
 *
 * Limitations:
 * - In-memory, non-persistent cache. Restarting the plugin loses all resume
 *   state and the next turn falls back to a full prompt.
 * - Entries expire after 1 hour (DEFAULT_TTL_MS).
 * - Cache is capped at 64 entries (DEFAULT_MAX_ENTRIES); oldest-untouched entry
 *   is evicted when the cap is exceeded.
 * - Anchor is derived from the first non-meta user message using a heuristic
 *   filter for OpenCode's title-generation prompts. If OpenCode rewords those
 *   prompts, the filter may need updating.
 * - Session resume is only supported for the cursor-agent backend.
 */

import { createHash } from "node:crypto";
import { extractTextContent } from "./incremental-prompt.js";

interface SessionResumeEntry {
  chatId: string;
  /** Stored for diagnostics only; the sessionKey already encodes model/workspace. */
  model: string;
  /** Stored for diagnostics only; the sessionKey already encodes model/workspace. */
  workspace: string;
  /** First-message content prefix used as a collision safety check on lookup. */
  contentPrefix: string;
  updatedAt: number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour
const DEFAULT_MAX_ENTRIES = 64;

const cache = new Map<string, SessionResumeEntry>();

/** 64-bit SHA-256 prefix. Content is tiny so cost is negligible. */
function simpleHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/** Skip OpenCode meta-requests that share the proxy but aren't the main chat.
 *
 * These substrings are observed heuristics, not a stable contract. If OpenCode
 * rewords its title-generation prompt, update this filter.
 */
function isMetaUserMessage(content: string): boolean {
  const lower = content.toLowerCase();
  return (
    lower.includes("title generator") ||
    lower.includes("thread title") ||
    lower.includes("generate a brief title")
  );
}

/**
 * Stable anchor for a conversation: first non-meta user message content.
 * Returns a hash plus the original content prefix for collision detection.
 * Survives `opencode run -c` because the opening user message is preserved.
 * Falls back to the literal anchor "default" when no usable user message exists.
 */
export function deriveConversationAnchor(
  messages: Array<any>,
): { anchor: string; contentPrefix: string } {
  for (const message of messages) {
    if (message?.role !== "user") continue;
    const content = extractTextContent(message.content).trim();
    if (!content || isMetaUserMessage(content)) continue;
    return { anchor: simpleHash(content), contentPrefix: content.slice(0, 80) };
  }
  return { anchor: "default", contentPrefix: "" };
}

export function buildSessionKey(workspace: string, model: string, anchor: string): string {
  return `${workspace}\0${model}\0${anchor}`;
}

export function isSessionResumeEnabled(): boolean {
  const value = process.env.CURSOR_ACP_SESSION_RESUME?.toLowerCase();
  return value === "1" || value === "true" || value === "on" || value === "yes";
}

export function getResumeChatId(
  sessionKey: string,
  expectedPrefix?: string,
): string | undefined {
  const entry = cache.get(sessionKey);
  if (!entry) return undefined;
  if (Date.now() - entry.updatedAt > DEFAULT_TTL_MS) {
    cache.delete(sessionKey);
    return undefined;
  }
  if (expectedPrefix != null && entry.contentPrefix !== expectedPrefix) {
    // Belt-and-suspenders: extremely unlikely after SHA-256, but log and treat as miss.
    return undefined;
  }
  // Refresh LRU order on a successful read.
  cache.delete(sessionKey);
  cache.set(sessionKey, entry);
  return entry.chatId;
}

export function recordResumeChatId(
  sessionKey: string,
  chatId: string,
  model: string,
  workspace: string,
  contentPrefix: string,
): void {
  if (!chatId) return;
  // Delete first so a re-set moves the key to the end (LRU insertion order).
  cache.delete(sessionKey);
  cache.set(sessionKey, {
    chatId,
    model,
    workspace,
    contentPrefix,
    updatedAt: Date.now(),
  });
  while (cache.size > DEFAULT_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function clearResumeChatId(sessionKey: string): void {
  cache.delete(sessionKey);
}

/** @internal Testing only. Gated on NODE_ENV to prevent accidental production wipe. */
export function _resetSessionResumeCache(): void {
  if (process.env.NODE_ENV !== "test") return;
  cache.clear();
}
