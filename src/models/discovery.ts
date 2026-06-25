import { execFileSync } from "child_process";
import { stripAnsi } from "../utils/errors.js";
import { resolveCursorAgentBinary } from "../utils/binary.js";

const MODEL_DISCOVERY_TIMEOUT_MS = 5000;

export type DiscoveredModel = {
  id: string;
  name: string;
};

export function parseCursorModelsOutput(output: string): DiscoveredModel[] {
  const clean = stripAnsi(output);
  const models: DiscoveredModel[] = [];
  const seen = new Set<string>();

  for (const line of clean.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(
      /^([a-zA-Z0-9._-]+)\s+-\s+(.+?)(?:\s+\((?:current|default)\))*\s*$/,
    );
    if (!match) continue;

    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: match[2].trim() });
  }

  return models;
}

export function discoverModelsFromCursorAgent(): DiscoveredModel[] {
  const raw = execFileSync(resolveCursorAgentBinary(), ["models"], {
    encoding: "utf8",
    ...(process.platform !== "win32" && { killSignal: "SIGTERM" as const }),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: MODEL_DISCOVERY_TIMEOUT_MS,
  });
  const models = parseCursorModelsOutput(raw);
  if (models.length === 0) {
    throw new Error("No models parsed from cursor-agent output");
  }
  return models;
}
