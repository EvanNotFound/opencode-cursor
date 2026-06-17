import { describe, expect, it } from "bun:test";
import { RESUME_CHAT_ID_SAFE_RE, emitDone, emitEvent } from "../../scripts/cursor-agent-runner.mjs";

describe("cursor-agent-runner protocol helpers", () => {
  it("RESUME_CHAT_ID_SAFE_RE accepts safe ids", () => {
    expect(RESUME_CHAT_ID_SAFE_RE.test("chat-123")).toBe(true);
    expect(RESUME_CHAT_ID_SAFE_RE.test("A1_b2-c3")).toBe(true);
  });

  it("RESUME_CHAT_ID_SAFE_RE rejects unsafe ids", () => {
    expect(RESUME_CHAT_ID_SAFE_RE.test("chat;bad")).toBe(false);
    expect(RESUME_CHAT_ID_SAFE_RE.test("-chat")).toBe(false);
    expect(RESUME_CHAT_ID_SAFE_RE.test("")).toBe(false);
  });

  it("exports emit helpers", () => {
    expect(typeof emitEvent).toBe("function");
    expect(typeof emitDone).toBe("function");
  });
});
