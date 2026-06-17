import { afterEach, describe, expect, it } from "bun:test";
import {
  _resetSessionResumeCache,
  getResumeChatId,
} from "../../../src/proxy/session-resume.js";
import {
  buildCursorAgentCommand,
  captureResumeChatIdFromEvent,
  captureResumeChatIdFromOutput,
  resolvePromptForBackend,
} from "../../../src/plugin.js";

describe("plugin resume orchestration", () => {
  afterEach(() => {
    _resetSessionResumeCache();
    delete process.env.CURSOR_ACP_SESSION_RESUME;
  });

  const baseInput = {
    backend: "cursor-agent" as const,
    messages: [{ role: "user", content: "Remember BETA" }],
    tools: [] as any[],
    subagentNames: [] as string[],
    model: "gpt-5",
    workspaceDirectory: "/workspace",
  };

  it("resolvePromptForBackend: disabled → full prompt, no resume", () => {
    const result = resolvePromptForBackend({
      ...baseInput,
      backend: "sdk" as const,
    });
    expect(result.prompt).toBe("USER: Remember BETA");
    expect(result.resumeChatId).toBeUndefined();
    expect(result.usedIncremental).toBe(false);
  });

  it("resolvePromptForBackend: enabled + no chatId → full prompt + sessionKey", () => {
    process.env.CURSOR_ACP_SESSION_RESUME = "1";
    const result = resolvePromptForBackend(baseInput);
    expect(result.prompt).toBe("USER: Remember BETA");
    expect(result.resumeChatId).toBeUndefined();
    expect(result.sessionKey).toMatch(/^\/workspace\0gpt-5\0/);
    expect(result.usedIncremental).toBe(false);
    expect(result.contentPrefix).toBe("Remember BETA");
  });

  it("resolvePromptForBackend: enabled + chatId + incremental → incremental + resume", () => {
    process.env.CURSOR_ACP_SESSION_RESUME = "1";
    const { sessionKey, contentPrefix } = resolvePromptForBackend(baseInput);
    // Seed the cache as if turn 1 produced a session_id.
    const chatId = "chat-abc";
    const entry = getResumeChatId(sessionKey!, contentPrefix!);
    expect(entry).toBeUndefined();
    // Use the exported capture helper to seed.
    captureResumeChatIdFromEvent(
      { type: "system", session_id: chatId } as any,
      sessionKey,
      "gpt-5",
      "/workspace",
      contentPrefix,
    );

    const followUp = resolvePromptForBackend({
      ...baseInput,
      messages: [
        { role: "user", content: "Remember BETA" },
        { role: "assistant", content: "Got it." },
        { role: "user", content: "What was the codeword?" },
      ],
    });
    expect(followUp.resumeChatId).toBe(chatId);
    expect(followUp.prompt).toBe("What was the codeword?");
    expect(followUp.usedIncremental).toBe(true);
  });

  it("resolvePromptForBackend: enabled + chatId + incremental null → full prompt + resume", () => {
    process.env.CURSOR_ACP_SESSION_RESUME = "1";
    const { sessionKey, contentPrefix } = resolvePromptForBackend(baseInput);
    const chatId = "chat-abc";
    captureResumeChatIdFromEvent(
      { type: "system", session_id: chatId } as any,
      sessionKey,
      "gpt-5",
      "/workspace",
      contentPrefix,
    );

    const followUp = resolvePromptForBackend({
      ...baseInput,
      messages: [
        { role: "user", content: "Remember BETA" },
        { role: "assistant", content: "Hi there" },
      ],
    });
    expect(followUp.resumeChatId).toBe(chatId);
    expect(followUp.usedIncremental).toBe(false);
    expect(followUp.prompt).toContain("USER: Remember BETA");
  });

  it("captureResumeChatIdFromEvent records a string session_id", () => {
    process.env.CURSOR_ACP_SESSION_RESUME = "1";
    const key = "/workspace\0gpt-5\0anchor";
    captureResumeChatIdFromEvent(
      { type: "system", session_id: "chat-123" } as any,
      key,
      "gpt-5",
      "/workspace",
      "prefix",
    );
    expect(getResumeChatId(key, "prefix")).toBe("chat-123");
  });

  it("captureResumeChatIdFromEvent ignores non-string or empty session_id", () => {
    process.env.CURSOR_ACP_SESSION_RESUME = "1";
    const key = "/workspace\0gpt-5\0anchor";
    captureResumeChatIdFromEvent({ type: "system" } as any, key, "gpt-5", "/workspace", "prefix");
    captureResumeChatIdFromEvent({ type: "system", session_id: 123 } as any, key, "gpt-5", "/workspace", "prefix");
    captureResumeChatIdFromEvent({ type: "system", session_id: "   " } as any, key, "gpt-5", "/workspace", "prefix");
    expect(getResumeChatId(key, "prefix")).toBeUndefined();
  });

  it("captureResumeChatIdFromEvent no-ops when disabled or no sessionKey", () => {
    const key = "/workspace\0gpt-5\0anchor";
    captureResumeChatIdFromEvent(
      { type: "system", session_id: "chat-123" } as any,
      key,
      "gpt-5",
      "/workspace",
      "prefix",
    );
    expect(getResumeChatId(key, "prefix")).toBeUndefined();

    process.env.CURSOR_ACP_SESSION_RESUME = "1";
    captureResumeChatIdFromEvent(
      { type: "system", session_id: "chat-123" } as any,
      undefined,
      "gpt-5",
      "/workspace",
      "prefix",
    );
    expect(getResumeChatId(key, "prefix")).toBeUndefined();
  });

  it("captureResumeChatIdFromOutput parses NDJSON lines and records session_id", () => {
    process.env.CURSOR_ACP_SESSION_RESUME = "1";
    const key = "/workspace\0gpt-5\0anchor";
    const output = [
      '{"type":"system","session_id":"chat-xyz"}',
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"hi"}]}}',
    ].join("\n");
    captureResumeChatIdFromOutput(output, key, "gpt-5", "/workspace", "prefix");
    expect(getResumeChatId(key, "prefix")).toBe("chat-xyz");
  });

  it("buildCursorAgentCommand includes --resume when chatId provided", () => {
    const cmd = buildCursorAgentCommand("gpt-5", "/workspace", "chat-123");
    const resumeIndex = cmd.indexOf("--resume");
    expect(resumeIndex).toBeGreaterThan(-1);
    expect(cmd[resumeIndex + 1]).toBe("chat-123");
  });

  it("buildCursorAgentCommand omits --resume when no chatId", () => {
    const cmd = buildCursorAgentCommand("gpt-5", "/workspace");
    expect(cmd).not.toContain("--resume");
  });
});
