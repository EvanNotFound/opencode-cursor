/**
 * Build a delta prompt for cursor-agent --resume sessions.
 * When resuming, cursor-agent already holds conversation state — only send
 * the new turn content instead of replaying the full flattened history.
 */

export function extractTextContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => (part?.type === "text" && typeof part.text === "string" ? part.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Returns prompt text for a resumed session. Falls back to null when delta
 * mode cannot be determined safely (caller should use full prompt builder).
 */
export function buildIncrementalPrompt(messages: Array<any>): string | null {
  if (messages.length === 0) return null;

  const last = messages[messages.length - 1];

  // Tool-loop continuation: last messages are tool results
  if (last?.role === "tool") {
    const lines: string[] = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m?.role !== "tool") break;
      const callId = m.tool_call_id || "unknown";
      const body = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "");
      lines.unshift(`TOOL_RESULT (call_id: ${callId}): ${body}`);
    }
    // Defensive: loop always unshifts at least once, so this is unreachable today.
    if (lines.length === 0) return null;
    lines.push("The above tool calls have been executed. Continue your response based on these results.");
    return lines.join("\n\n");
  }

  // Normal follow-up: latest user message only
  if (last?.role === "user") {
    const text = extractTextContent(last.content);
    if (!text.trim()) return null;
    // Mixed multimodal follow-ups must fall back to the full prompt so image/audio
    // parts are not silently dropped.
    if (
      Array.isArray(last.content) &&
      last.content.some((part: any) => part?.type && part.type !== "text")
    ) {
      return null;
    }
    return text.trim();
  }

  return null;
}
