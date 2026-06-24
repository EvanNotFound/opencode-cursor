import { describe, expect, it } from "bun:test";
import { resolveChatParamTools } from "../../src/plugin";

describe("resolveChatParamTools", () => {
  it("preserves existing tools in opencode mode", () => {
    const existing = [{ function: { name: "external_tool" } }];
    const resolved = resolveChatParamTools("opencode", existing, []);

    expect(resolved.action).toBe("preserve");
    expect(resolved.tools).toBe(existing);
  });

  it("does not fallback to local tools in opencode mode when missing", () => {
    const fallback = [{ function: { name: "oc_bash" } }];
    const resolved = resolveChatParamTools("opencode", undefined, fallback);

    expect(resolved.action).toBe("none");
    expect(resolved.tools).toBeUndefined();
  });

  it("overrides with refreshed tools in proxy-exec mode", () => {
    const existing = [{ function: { name: "legacy" } }];
    const refreshed = [{ function: { name: "oc_new" } }];
    const resolved = resolveChatParamTools("proxy-exec", existing, refreshed);

    expect(resolved.action).toBe("override");
    expect(resolved.tools).toBe(refreshed);
  });

  it("returns none when off mode has no changes", () => {
    const existing = [{ function: { name: "keep_me" } }];
    const resolved = resolveChatParamTools("off", existing, [{ function: { name: "ignored" } }]);

    expect(resolved.action).toBe("none");
    expect(resolved.tools).toBe(existing);
  });
});
