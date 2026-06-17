#!/usr/bin/env node
/**
 * cursor-agent-runner.mjs
 *
 * Persistent Node runner for cursor-agent --print invocations.
 * Reads NDJSON from stdin:
 *   {"id":"<string>","model":"...","cwd":"...","prompt":"...","resumeChatId?":"...","force?":bool,"cursorAgent?":"..."}
 * Emits wrapped NDJSON to stdout:
 *   {"id":"<id>","event":{...StreamJsonEvent...}}
 *   {"id":"<id>","done":true,"exitCode":0|1}
 *
 * Requests are processed serially (one cursor-agent child at a time).
 * Diagnostics go to stderr only.
 */

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const RESUME_CHAT_ID_SAFE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const RUNNING_AS_MAIN = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

const protocolWrite = process.stdout.write.bind(process.stdout);
if (RUNNING_AS_MAIN) {
  process.stdout.write = (chunk, ...args) => process.stderr.write(chunk, ...args);
}

function writeProtocolLine(line) {
  return protocolWrite(line);
}

function emitEvent(id, event) {
  writeProtocolLine(JSON.stringify({ id, event }) + "\n");
}

function emitDone(id, exitCode) {
  writeProtocolLine(JSON.stringify({ id, done: true, exitCode }) + "\n");
}

function emitErrorEvent(id, message) {
  emitEvent(id, { type: "error", message });
}

async function handleRequest(request) {
  const { id, model, cwd, prompt, resumeChatId, force, cursorAgent } = request;

  if (!id || !model || !cwd || prompt == null) {
    console.error(`[cursor-agent-runner] Invalid request missing fields:`, request);
    emitErrorEvent(id || "unknown", "Missing required fields: id, model, cwd, prompt");
    emitDone(id || "unknown", 1);
    return;
  }

  const binary = typeof cursorAgent === "string" && cursorAgent.trim() ? cursorAgent.trim() : "cursor-agent";
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--workspace",
    cwd,
    "--model",
    model,
  ];

  if (typeof resumeChatId === "string" && resumeChatId.trim() && RESUME_CHAT_ID_SAFE_RE.test(resumeChatId.trim())) {
    args.push("--resume", resumeChatId.trim());
  }

  if (force) {
    args.push("--force");
  }

  console.error(`[cursor-agent-runner] Request ${id}: model=${model}, cwd=${cwd}, resume=${!!resumeChatId}`);

  await new Promise((resolve) => {
    const shell = process.platform === "win32";
    const cmd = shell && binary.includes(" ") ? `"${binary}"` : binary;
    const child = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell,
    });

    let stderrText = "";
    child.stderr?.on("data", (chunk) => {
      stderrText += chunk.toString("utf8");
    });

    child.stdin.write(typeof prompt === "string" ? prompt : String(prompt));
    child.stdin.end();

    let buffer = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      buffer += chunk;
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const line of parts) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          emitEvent(id, event);
        } catch {
          emitEvent(id, { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: line }] } });
        }
      }
    });

    child.on("close", (code) => {
      if (buffer.trim()) {
        try {
          emitEvent(id, JSON.parse(buffer));
        } catch {
          // ignore trailing garbage
        }
      }
      if (code !== 0 && stderrText.trim()) {
        console.error(`[cursor-agent-runner] Request ${id} stderr: ${stderrText.trim().slice(0, 500)}`);
      }
      console.error(`[cursor-agent-runner] Request ${id} complete exitCode=${code ?? 1}`);
      emitDone(id, code ?? 1);
      resolve();
    });

    child.on("error", (err) => {
      console.error(`[cursor-agent-runner] Request ${id} spawn error: ${err.message}`);
      emitErrorEvent(id, err.message);
      emitDone(id, 1);
      resolve();
    });
  });
}

async function main() {
  console.error("[cursor-agent-runner] Waiting for requests on stdin...");

  const queue = [];
  let processing = false;

  const pump = async () => {
    if (processing) return;
    processing = true;
    try {
      while (queue.length > 0) {
        const request = queue.shift();
        try {
          await handleRequest(request);
        } catch (err) {
          const id = request?.id || "unknown";
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[cursor-agent-runner] Unhandled error in request ${id}: ${message}`);
          emitErrorEvent(id, message);
          emitDone(id, 1);
        }
      }
    } finally {
      processing = false;
    }
  };

  const enqueue = (request) => {
    queue.push(request);
    void pump();
  };

  let buffer = "";
  await new Promise((resolveEnd, rejectEnd) => {
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      buffer += chunk;
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        if (!part.trim()) continue;
        try {
          enqueue(JSON.parse(part));
        } catch (err) {
          console.error(`[cursor-agent-runner] Failed to parse NDJSON line: ${err.message}`);
        }
      }
    });
    process.stdin.on("end", () => {
      if (buffer.trim()) {
        try {
          enqueue(JSON.parse(buffer));
        } catch (err) {
          console.error(`[cursor-agent-runner] Failed to parse trailing NDJSON: ${err.message}`);
        }
      }
      resolveEnd();
    });
    process.stdin.on("error", rejectEnd);
  });

  while (queue.length > 0 || processing) {
    await pump();
    if (queue.length > 0 || processing) {
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  console.error("[cursor-agent-runner] Shutting down");
  await new Promise((resolve) => protocolWrite("", resolve));
  process.exit(0);
}

if (RUNNING_AS_MAIN) {
  main().catch((err) => {
    console.error(`[cursor-agent-runner] Fatal: ${err.message}`);
    process.exit(1);
  });
}

export { RESUME_CHAT_ID_SAFE_RE, emitDone, emitEvent, emitErrorEvent };
