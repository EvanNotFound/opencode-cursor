import { describe, expect, it } from "bun:test";
import {
  buildIncrementalPrompt,
  extractTextContent,
} from "../../../src/proxy/incremental-prompt.js";

describe("buildIncrementalPrompt", () => {
  it("returns null for empty messages", () => {
    expect(buildIncrementalPrompt([])).toBeNull();
  });

  it("returns latest user message text for follow-up turns", () => {
    const messages = [
      { role: "user", content: "Remember BETA" },
      { role: "assistant", content: "Got it." },
      { role: "user", content: "What was the codeword?" },
    ];
    expect(buildIncrementalPrompt(messages)).toBe("What was the codeword?");
  });

  it("extracts text from array content parts", () => {
    const messages = [
      {
        role: "user",
        content: [{ type: "text", text: "Follow up question" }],
      },
    ];
    expect(buildIncrementalPrompt(messages)).toBe("Follow up question");
  });

  it("builds tool-loop continuation from trailing tool results", () => {
    const messages = [
      { role: "user", content: "Read foo.txt" },
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call_1", function: { name: "read", arguments: "{}" } }],
      },
      { role: "tool", tool_call_id: "call_1", content: "file contents" },
    ];
    const prompt = buildIncrementalPrompt(messages);
    expect(prompt).toContain("TOOL_RESULT (call_id: call_1): file contents");
    expect(prompt).toContain("Continue your response based on these results.");
  });

  it("builds exact multi-result tool-loop continuation", () => {
    const messages = [
      { role: "user", content: "Read files" },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", function: { name: "read", arguments: "{}" } },
          { id: "call_2", function: { name: "read", arguments: "{}" } },
          { id: "call_3", function: { name: "read", arguments: "{}" } },
        ],
      },
      { role: "tool", tool_call_id: "call_1", content: "alpha" },
      { role: "tool", tool_call_id: "call_2", content: "beta" },
      { role: "tool", tool_call_id: "call_3", content: "gamma" },
    ];
    const prompt = buildIncrementalPrompt(messages);
    expect(prompt).toBe(
      [
        "TOOL_RESULT (call_id: call_1): alpha",
        "TOOL_RESULT (call_id: call_2): beta",
        "TOOL_RESULT (call_id: call_3): gamma",
        "The above tool calls have been executed. Continue your response based on these results.",
      ].join("\n\n"),
    );
  });

  it("returns null when last message is assistant without tool results", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ];
    expect(buildIncrementalPrompt(messages)).toBeNull();
  });

  it("returns null for blank user message", () => {
    expect(buildIncrementalPrompt([{ role: "user", content: "   " }])).toBeNull();
  });

  it("returns null for mixed text+image user follow-up", () => {
    const messages = [
      { role: "user", content: "Remember BETA" },
      { role: "assistant", content: "Got it." },
      {
        role: "user",
        content: [
          { type: "text", text: "What do you see?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
        ],
      },
    ];
    expect(buildIncrementalPrompt(messages)).toBeNull();
  });

  it("extractTextContent joins multiple text parts", () => {
    expect(
      extractTextContent([
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ]),
    ).toBe("first\nsecond");
  });

  it("extractTextContent ignores non-text parts", () => {
    expect(
      extractTextContent([
        { type: "text", text: "visible" },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
      ]),
    ).toBe("visible");
  });
});
