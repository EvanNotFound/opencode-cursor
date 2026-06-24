import { describe, it, expect } from "bun:test";
import { CursorPlugin } from "../../src/plugin";
import type { PluginInput } from "@opencode-ai/plugin";

function createMockInput(directory: string, worktree: string = directory): PluginInput {
  return {
    directory,
    worktree,
    serverUrl: new URL("http://localhost:8080"),
    client: {
      tool: {
        list: async () => [],
      },
    } as any,
    project: {} as any,
    $: {} as any,
  };
}

describe("Plugin tool hook", () => {
  it("does not register local tool aliases in native OpenCode mode", async () => {
    const hooks = await CursorPlugin(createMockInput("/test/dir"));
    const toolNames = Object.keys(hooks.tool || {});

    expect(toolNames).not.toContain("edit");
    expect(toolNames).not.toContain("write");
    expect(toolNames).not.toContain("oc_edit");
    expect(toolNames).not.toContain("oc_write");
    expect(toolNames).not.toContain("bash");
    expect(toolNames).not.toContain("oc_bash");
  });
});
