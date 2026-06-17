import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type PackageJson = {
  scripts?: Record<string, string>;
};

const root = process.cwd();
const packageJson = JSON.parse(
  readFileSync(resolve(root, "package.json"), "utf8"),
) as PackageJson;

describe("issue #92 verification wiring", () => {
  it("exposes a focused perf test script and repo-level verification command", () => {
    expect(packageJson.scripts?.["test:perf"]).toBeString();
    expect(packageJson.scripts?.["verify:issue-92"]).toBe(
      "bash scripts/verify-issue-92.sh",
    );
  });

  it("does not let the issue #92 verification script call undefined npm scripts", () => {
    const scriptPath = resolve(root, "scripts/verify-issue-92.sh");
    expect(existsSync(scriptPath)).toBe(true);

    const script = readFileSync(scriptPath, "utf8");
    const referencedScripts = [...script.matchAll(/npm run ([\w:-]+)/g)].map(
      (match) => match[1],
    );

    expect(referencedScripts).toContain("build");
    expect(referencedScripts).toContain("test:perf");

    for (const name of referencedScripts) {
      expect(packageJson.scripts?.[name]).toBeString();
    }
  });
});
