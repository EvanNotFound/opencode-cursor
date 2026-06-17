import { afterEach, describe, expect, it } from "bun:test";
import {
  _resetSessionResumeCache,
  buildSessionKey,
  clearResumeChatId,
  deriveConversationAnchor,
  getResumeChatId,
  isSessionResumeEnabled,
  recordResumeChatId,
} from "../../../src/proxy/session-resume.js";

describe("session-resume", () => {
  afterEach(() => {
    _resetSessionResumeCache();
    delete process.env.CURSOR_ACP_SESSION_RESUME;
  });

  it("is disabled by default", () => {
    expect(isSessionResumeEnabled()).toBe(false);
  });

  it.each([
    ["1", true],
    ["true", true],
    ["TRUE", true],
    ["on", true],
    ["yes", true],
    ["0", false],
    ["false", false],
    ["", false],
    [undefined, false],
  ])("isSessionResumeEnabled(%p) === %p", (value, expected) => {
    if (value !== undefined) {
      process.env.CURSOR_ACP_SESSION_RESUME = value;
    } else {
      delete process.env.CURSOR_ACP_SESSION_RESUME;
    }
    expect(isSessionResumeEnabled()).toBe(expected);
  });

  it("derives anchor from first real user message", () => {
    const messages = [
      { role: "user", content: "Title generator: make a brief title" },
      { role: "user", content: "Remember the codeword BETA" },
    ];
    const { anchor: anchorA, contentPrefix: prefixA } = deriveConversationAnchor(messages);
    const { anchor: anchorB, contentPrefix: prefixB } = deriveConversationAnchor([
      { role: "user", content: "Remember the codeword BETA" },
    ]);
    expect(anchorA).toBe(anchorB);
    expect(prefixA).toBe(prefixB);
  });

  it("handles array-content first user message", () => {
    const { anchor: stringAnchor } = deriveConversationAnchor([
      { role: "user", content: "Remember BETA" },
    ]);
    const { anchor: arrayAnchor } = deriveConversationAnchor([
      { role: "user", content: [{ type: "text", text: "Remember BETA" }] },
    ]);
    expect(arrayAnchor).toBe(stringAnchor);
    expect(arrayAnchor).not.toBe("default");
  });

  it("falls back to default anchor when no usable user message", () => {
    const { anchor, contentPrefix } = deriveConversationAnchor([
      { role: "system", content: "You are helpful" },
      { role: "assistant", content: "Hi" },
    ]);
    expect(anchor).toBe("default");
    expect(contentPrefix).toBe("");
  });

  it("falls back to default when all user messages are meta", () => {
    const { anchor } = deriveConversationAnchor([
      { role: "user", content: "Generate a brief title for this thread" },
    ]);
    expect(anchor).toBe("default");
  });

  it("documents that meta substring filter can misclassify real messages", () => {
    // The substring heuristic for title-generation prompts is not precise: a real
    // user message that contains "title generator" is currently treated as meta.
    const { anchor } = deriveConversationAnchor([
      { role: "user", content: "I tried the title generator but it failed; remember BETA" },
    ]);
    expect(anchor).toBe("default");
  });

  it("stores and retrieves chat IDs by session key", () => {
    const key = buildSessionKey("/workspace", "gpt-5", "abc123");
    expect(getResumeChatId(key)).toBeUndefined();

    recordResumeChatId(key, "chat-uuid-1", "gpt-5", "/workspace", "hello");
    expect(getResumeChatId(key)).toBe("chat-uuid-1");
  });

  it("clears a stored chat ID", () => {
    const key = buildSessionKey("/workspace", "gpt-5", "abc123");
    recordResumeChatId(key, "chat-uuid-1", "gpt-5", "/workspace", "hello");
    clearResumeChatId(key);
    expect(getResumeChatId(key)).toBeUndefined();
  });

  it("builds distinct keys for different workspaces and models", () => {
    const { anchor } = deriveConversationAnchor([{ role: "user", content: "hello" }]);
    const keyA = buildSessionKey("/a", "model-1", anchor);
    const keyB = buildSessionKey("/b", "model-1", anchor);
    const keyC = buildSessionKey("/a", "model-2", anchor);
    expect(keyA).not.toBe(keyB);
    expect(keyA).not.toBe(keyC);
  });

  it("ignores recordResumeChatId with empty chatId", () => {
    const key = buildSessionKey("/workspace", "gpt-5", "abc123");
    recordResumeChatId(key, "", "gpt-5", "/workspace", "hello");
    expect(getResumeChatId(key)).toBeUndefined();
  });

  it("evicts oldest entry when max entries exceeded", () => {
    for (let i = 0; i < 64; i++) {
      const key = buildSessionKey("/ws", "model", `anchor-${i}`);
      recordResumeChatId(key, `chat-${i}`, "model", "/ws", `prefix-${i}`);
    }
    const firstKey = buildSessionKey("/ws", "model", "anchor-0");
    const secondKey = buildSessionKey("/ws", "model", "anchor-1");

    // Add one more; oldest untouched entry should be evicted.
    const extraKey = buildSessionKey("/ws", "model", "anchor-64");
    recordResumeChatId(extraKey, "chat-64", "model", "/ws", "prefix-64");
    expect(getResumeChatId(firstKey)).toBeUndefined();
    expect(getResumeChatId(secondKey)).toBe("chat-1");
    expect(getResumeChatId(extraKey)).toBe("chat-64");
  });

  it("refreshes insertion order on update so recently-updated entry survives eviction", () => {
    for (let i = 0; i < 64; i++) {
      const key = buildSessionKey("/ws", "model", `anchor-${i}`);
      recordResumeChatId(key, `chat-${i}`, "model", "/ws", `prefix-${i}`);
    }
    const firstKey = buildSessionKey("/ws", "model", "anchor-0");
    // Touch the first entry to refresh its LRU position.
    getResumeChatId(firstKey);
    recordResumeChatId(firstKey, "chat-0-updated", "model", "/ws", "prefix-0");

    const extraKey = buildSessionKey("/ws", "model", "anchor-64");
    recordResumeChatId(extraKey, "chat-64", "model", "/ws", "prefix-64");
    // anchor-1 (not touched) should be evicted instead of anchor-0.
    const secondKey = buildSessionKey("/ws", "model", "anchor-1");
    expect(getResumeChatId(secondKey)).toBeUndefined();
    expect(getResumeChatId(firstKey)).toBe("chat-0-updated");
  });

  it("expires entries after TTL", () => {
    const originalNow = Date.now;
    const key = buildSessionKey("/workspace", "gpt-5", "abc123");
    const now = 1_000_000_000_000;
    Date.now = () => now;
    recordResumeChatId(key, "chat-uuid-1", "gpt-5", "/workspace", "hello");
    expect(getResumeChatId(key)).toBe("chat-uuid-1");

    // Just over 1 hour later.
    Date.now = () => now + 60 * 60 * 1000 + 1;
    expect(getResumeChatId(key)).toBeUndefined();

    Date.now = originalNow;
  });

  it("treats prefix mismatch as a cache miss", () => {
    const key = buildSessionKey("/workspace", "gpt-5", "abc123");
    recordResumeChatId(key, "chat-uuid-1", "gpt-5", "/workspace", "hello");
    expect(getResumeChatId(key, "different")).toBeUndefined();
    expect(getResumeChatId(key, "hello")).toBe("chat-uuid-1");
    expect(getResumeChatId(key)).toBe("chat-uuid-1");
  });
});
