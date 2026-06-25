import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { LineBuffer } from "./streaming/line-buffer.js";
import { MixedDeltaTracker } from "./streaming/delta-tracker.js";
import { StreamToSseConverter, formatSseChunk, formatSseDone } from "./streaming/openai-sse.js";
import { parseStreamJsonLine } from "./streaming/parser.js";
import {
  extractText,
  extractThinking,
  isAssistantText,
  isResult,
  isThinking,
  type StreamJsonEvent,
} from "./streaming/types.js";
import { buildPromptFromMessages, buildToolFingerprint } from "./proxy/prompt-builder.js";
import { buildIncrementalPrompt, type ProxyMessage } from "./proxy/incremental-prompt.js";
import {
  buildSessionKey,
  deriveConversationAnchor,
  deriveConversationResumePrefixes,
  clearResumeChatId,
  getResumeChatId,
  hasResumeChatId,
  isSessionResumeEnabled,
  recordResumeChatId,
  sanitizeSessionKey,
  RESUME_CHAT_ID_SAFE_RE,
} from "./proxy/session-resume.js";
import {
  createToolCallCompletionResponse,
  createToolCallStreamChunks,
  extractAllowedToolNames,
  extractOpenAiToolCall,
  type OpenAiToolCall,
} from "./proxy/tool-loop.js";
import { discoverModelsFromCursorAgent } from "./models/discovery.js";
import { extractOpenAiUsageFromResult, createChatCompletionUsageChunk, type OpenAiUsage } from "./usage.js";
import { formatErrorForUser, isResumeSpecificFailure, parseAgentError } from "./utils/errors.js";
import { createLogger } from "./utils/logger.js";
import { formatShellCommandForPlatform, resolveCursorAgentBinary } from "./utils/binary.js";

const log = createLogger("plugin");

const CURSOR_PROVIDER_ID = "cursor-acp";
const CURSOR_PROVIDER_PREFIX = `${CURSOR_PROVIDER_ID}/`;
const CURSOR_PROXY_HOST = "127.0.0.1";
const CURSOR_PROXY_DEFAULT_PORT = 32124;
const CURSOR_PROXY_DEFAULT_BASE_URL = `http://${CURSOR_PROXY_HOST}:${CURSOR_PROXY_DEFAULT_PORT}/v1`;
const CURSOR_PROXY_HEALTH_TIMEOUT_MS = 3000;
const REUSE_EXISTING_PROXY = process.env.CURSOR_ACP_REUSE_EXISTING_PROXY !== "false";
const FORCE_TOOL_MODE = process.env.CURSOR_ACP_FORCE !== "false";

type Auth = { type?: string; key?: string };

type ProxyRuntimeState = {
  server?: any;
  baseURL: string;
  baseURLByWorkspace: Record<string, string>;
  workspaceDirectory?: string;
};

export interface ResolvedPrompt {
  prompt: string;
  resumeChatId?: string;
  sessionKey?: string;
  usedIncremental: boolean;
  contentPrefix?: string;
  recordContentPrefix?: string;
  toolFingerprint?: string;
  subagentFingerprint?: string;
}

export async function ensurePluginDirectory(): Promise<void> {
  const configHome = process.env.XDG_CONFIG_HOME
    ? resolve(process.env.XDG_CONFIG_HOME)
    : join(homedir(), ".config");
  const pluginDir = join(configHome, "opencode", "plugin");
  try {
    await mkdir(pluginDir, { recursive: true });
    log.debug("Plugin directory ensured", { path: pluginDir });
  } catch (error) {
    log.warn("Failed to create plugin directory", { error: String(error) });
  }
}

export function shouldProcessModel(model: string | undefined): boolean {
  return Boolean(model?.startsWith(CURSOR_PROVIDER_PREFIX));
}

export function buildCursorAgentCommand(
  model: string,
  workspaceDirectory: string,
  resumeChatId?: string,
): string[] {
  const cmd = [
    resolveCursorAgentBinary(),
    "--print",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--workspace",
    workspaceDirectory,
    "--model",
    model,
  ];
  if (resumeChatId) {
    if (RESUME_CHAT_ID_SAFE_RE.test(resumeChatId)) {
      cmd.push("--resume", resumeChatId);
    } else {
      log.warn("Refusing to pass unsafe resume chat ID to cursor-agent; --resume omitted", {
        resumeChatIdHash: hashForLog(resumeChatId),
        model,
      });
    }
  }
  if (FORCE_TOOL_MODE) cmd.push("--force");
  return cmd;
}

export function resolvePromptForBackend(input: {
  backend: string;
  messages: Array<ProxyMessage>;
  tools: Array<any>;
  subagentNames: string[];
  model: string;
  workspaceDirectory: string;
}): ResolvedPrompt {
  let fullPrompt: string | undefined;
  const getFullPrompt = () =>
    fullPrompt ??= buildPromptFromMessages(input.messages, input.tools, input.subagentNames);

  if (input.backend !== "cursor-agent" || !isSessionResumeEnabled()) {
    return { prompt: getFullPrompt(), usedIncremental: false };
  }

  const anchorResult = deriveConversationAnchor(input.messages);
  if (!anchorResult) {
    log.warn("Session resume enabled but no usable conversation anchor; skipping resume", {
      model: input.model,
      workspaceDirectoryHash: sanitizeSessionKey(input.workspaceDirectory),
    });
    return { prompt: getFullPrompt(), usedIncremental: false };
  }

  const resumePrefixes = deriveConversationResumePrefixes(input.messages);
  const contentPrefix = resumePrefixes?.lookupContentPrefix ?? anchorResult.contentPrefix;
  const recordContentPrefix = resumePrefixes?.recordContentPrefix ?? contentPrefix;
  const sessionKey = buildSessionKey(input.workspaceDirectory, input.model, anchorResult.anchor);
  const toolFingerprint = buildToolFingerprint(input.tools);
  const subagentFingerprint = input.subagentNames.slice().sort().join(",");
  const resumeChatId = getResumeChatId(sessionKey, contentPrefix, toolFingerprint, subagentFingerprint);

  if (!resumeChatId) {
    return { prompt: getFullPrompt(), sessionKey, usedIncremental: false, contentPrefix, recordContentPrefix, toolFingerprint, subagentFingerprint };
  }

  const incremental = buildIncrementalPrompt(input.messages);
  if (incremental) {
    return { prompt: incremental, resumeChatId, sessionKey, usedIncremental: true, contentPrefix, recordContentPrefix, toolFingerprint, subagentFingerprint };
  }

  return { prompt: getFullPrompt(), resumeChatId, sessionKey, usedIncremental: false, contentPrefix, recordContentPrefix, toolFingerprint, subagentFingerprint };
}

export function captureResumeChatIdFromEvent(
  event: StreamJsonEvent,
  sessionKey: string | undefined,
  model: string,
  workspaceDirectory: string,
  contentPrefix?: string,
  toolFingerprint?: string,
  subagentFingerprint?: string,
): void {
  void model;
  void workspaceDirectory;
  if (!sessionKey || !isSessionResumeEnabled()) return;
  const chatId = event.session_id;
  if (typeof chatId === "string" && chatId.trim()) {
    recordResumeChatId(
      sessionKey,
      chatId.trim(),
      contentPrefix ?? "",
      toolFingerprint,
      subagentFingerprint,
    );
    return;
  }
  if (chatId != null) {
    log.warn("cursor-agent emitted invalid session_id", {
      type: typeof chatId,
      length: String(chatId).length,
      sessionKeyHash: sanitizeSessionKey(sessionKey),
    });
  }
}

export function captureResumeChatIdFromOutput(
  output: string,
  sessionKey: string | undefined,
  model: string,
  workspaceDirectory: string,
  contentPrefix?: string,
  toolFingerprint?: string,
  subagentFingerprint?: string,
): void {
  if (!sessionKey || !isSessionResumeEnabled() || !output) return;
  for (const line of output.split(/\r?\n/)) {
    const event = parseStreamJsonLine(line);
    if (!event) continue;
    captureResumeChatIdFromEvent(event, sessionKey, model, workspaceDirectory, contentPrefix, toolFingerprint, subagentFingerprint);
  }
}

export function maybeEvictResumeChatId(
  stderr: string,
  _chatIdOrSessionKey: string | undefined,
  sessionKeyOrExpectedPrefix?: string,
  optionsOrToolFingerprint?: { code?: number | null } | string,
  subagentFingerprint?: string,
): boolean {
  const sessionKey = typeof optionsOrToolFingerprint === "object"
    ? sessionKeyOrExpectedPrefix
    : _chatIdOrSessionKey;
  const expectedPrefix = typeof optionsOrToolFingerprint === "object"
    ? undefined
    : sessionKeyOrExpectedPrefix;
  const toolFingerprint = typeof optionsOrToolFingerprint === "string"
    ? optionsOrToolFingerprint
    : undefined;
  if (!sessionKey || !isSessionResumeEnabled()) return false;
  if (!hasResumeChatId(sessionKey, expectedPrefix, toolFingerprint, subagentFingerprint)) return false;
  if (isResumeSpecificFailure(stderr)) {
    clearResumeChatId(sessionKey);
    return true;
  }
  return false;
}

export function isRootPath(pathValue: string): boolean {
  const resolved = resolve(pathValue);
  return resolved === resolve(resolved, "..");
}

export function resolveWorkspaceDirectory(
  worktree: string | undefined,
  directory: string | undefined,
): string {
  const candidates = [
    process.env.CURSOR_ACP_WORKSPACE,
    process.env.OPENCODE_CURSOR_PROJECT_DIR,
    worktree,
    directory,
    process.cwd(),
    homedir(),
  ].filter((value): value is string => Boolean(value));
  for (const candidate of candidates) {
    const resolved = resolve(candidate);
    if (isConfigPath(resolved)) continue;
    if (!isRootPath(resolved)) return resolved;
  }
  return homedir();
}

function isConfigPath(pathValue: string): boolean {
  const configHome = process.env.XDG_CONFIG_HOME
    ? resolve(process.env.XDG_CONFIG_HOME)
    : join(homedir(), ".config");
  const opencodeDir = join(configHome, "opencode");
  return normalizeWorkspaceForCompare(pathValue).startsWith(normalizeWorkspaceForCompare(opencodeDir));
}

export function normalizeWorkspaceForCompare(pathValue: string): string {
  try {
    const normalized = realpathSync(resolve(pathValue));
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  } catch {
    const normalized = resolve(pathValue);
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
  }
}

export function isReusableProxyHealthPayload(payload: any, workspaceDirectory: string): boolean {
  if (!payload || typeof payload !== "object") return false;
  if (payload.ok !== true) return false;
  if (typeof payload.workspaceDirectory !== "string" || !payload.workspaceDirectory) return false;
  return normalizeWorkspaceForCompare(payload.workspaceDirectory) === normalizeWorkspaceForCompare(workspaceDirectory);
}

export async function fetchProxyHealthWithTimeout(
  url: string,
  timeoutMs: number = CURSOR_PROXY_HEALTH_TIMEOUT_MS,
): Promise<Response | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  if (typeof (timeout as any).unref === "function") (timeout as any).unref();
  try {
    return await fetch(url, { signal: controller.signal }).catch(() => null);
  } finally {
    clearTimeout(timeout);
  }
}

export function extractCompletionFromStream(output: string): {
  assistantText: string;
  reasoningText: string;
  usage?: OpenAiUsage;
} {
  const assistant = new MixedDeltaTracker();
  let assistantText = "";
  let reasoningText = "";
  let usage: OpenAiUsage | undefined;

  for (const line of output.split(/\r?\n/)) {
    const event = parseStreamJsonLine(line);
    if (!event) continue;
    if (isAssistantText(event)) {
      assistantText += assistant.nextText(extractText(event)) ?? "";
    } else if (isThinking(event)) {
      reasoningText += assistant.nextThinking(extractThinking(event)) ?? "";
    } else if (isResult(event)) {
      usage = extractOpenAiUsageFromResult(event) ?? usage;
    }
  }

  return { assistantText, reasoningText, usage };
}

function createChatCompletionResponse(model: string, content: string, usage?: OpenAiUsage) {
  return {
    id: `cursor-acp-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: `${CURSOR_PROVIDER_ID}/${model}`,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    ...(usage ? { usage } : {}),
  };
}

function normalizeModel(model: unknown): string {
  const raw = typeof model === "string" ? model.trim() : "";
  if (!raw) return "auto";
  return raw.startsWith(CURSOR_PROVIDER_PREFIX) ? raw.slice(CURSOR_PROVIDER_PREFIX.length) || "auto" : raw;
}

function hashForLog(value: string): string {
  return sanitizeSessionKey(value).slice(0, 12);
}

function getGlobalKey(): string {
  return "__opencode_cursor_proxy_server__";
}

function getState(): ProxyRuntimeState {
  const globalState = globalThis as any;
  const key = getGlobalKey();
  globalState[key] = globalState[key] ?? { baseURL: "", baseURLByWorkspace: {} };
  globalState[key].baseURLByWorkspace = globalState[key].baseURLByWorkspace ?? {};
  return globalState[key];
}

async function tryReuseExistingProxy(workspaceDirectory: string): Promise<string | undefined> {
  if (!REUSE_EXISTING_PROXY) return undefined;
  const healthUrl = CURSOR_PROXY_DEFAULT_BASE_URL.replace(/\/v1$/, "/health");
  const response = await fetchProxyHealthWithTimeout(healthUrl);
  if (!response?.ok) return undefined;
  const payload = await response.json().catch(() => null);
  if (!isReusableProxyHealthPayload(payload, workspaceDirectory)) return undefined;
  log.debug("Reusing existing cursor proxy", { baseURL: CURSOR_PROXY_DEFAULT_BASE_URL });
  return CURSOR_PROXY_DEFAULT_BASE_URL;
}

async function ensureCursorProxyServer(workspaceDirectory: string): Promise<string> {
  const state = getState();
  const normalizedWorkspace = normalizeWorkspaceForCompare(workspaceDirectory);
  const existing = state.baseURLByWorkspace[normalizedWorkspace];
  if (state.server && existing) return existing;

  const reused = await tryReuseExistingProxy(workspaceDirectory);
  if (reused) {
    state.baseURL = reused;
    state.baseURLByWorkspace[normalizedWorkspace] = reused;
    state.workspaceDirectory = workspaceDirectory;
    return reused;
  }

  const bun = (globalThis as any).Bun;
  if (!bun?.serve) {
    throw new Error("cursor-acp proxy requires Bun runtime");
  }

  state.server?.stop?.(true);
  const server = bun.serve({
    hostname: CURSOR_PROXY_HOST,
    port: CURSOR_PROXY_DEFAULT_PORT,
    fetch: (request: Request) => handleProxyRequest(request, workspaceDirectory),
  });
  const baseURL = `http://${CURSOR_PROXY_HOST}:${server.port}/v1`;
  state.server = server;
  state.baseURL = baseURL;
  state.baseURLByWorkspace[normalizedWorkspace] = baseURL;
  state.workspaceDirectory = workspaceDirectory;
  return baseURL;
}

async function handleProxyRequest(request: Request, workspaceDirectory: string): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/health") {
    return Response.json({ ok: true, provider: CURSOR_PROVIDER_ID, workspaceDirectory });
  }
  if (url.pathname === "/v1/models" || url.pathname === "/models") {
    const data = discoverModelsFromCursorAgent().map((model) => ({ id: `${CURSOR_PROVIDER_ID}/${model.id}`, object: "model", owned_by: CURSOR_PROVIDER_ID }));
    return Response.json({ object: "list", data });
  }
  if (url.pathname !== "/v1/chat/completions" && url.pathname !== "/chat/completions") {
    return new Response("Not Found", { status: 404 });
  }
  if (request.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const body = await request.json().catch(() => ({}));
  return await handleChatCompletion(body, workspaceDirectory);
}

async function handleChatCompletion(body: any, workspaceDirectory: string): Promise<Response> {
  const model = normalizeModel(body?.model);
  const messages: Array<ProxyMessage> = Array.isArray(body?.messages) ? body.messages : [];
  const tools: Array<any> = Array.isArray(body?.tools) ? body.tools : [];
  const subagentNames: string[] = [];
  const resolved = resolvePromptForBackend({ backend: "cursor-agent", messages, tools, subagentNames, model, workspaceDirectory });
  return body?.stream
    ? streamChatCompletion({ model, workspaceDirectory, tools, resolved })
    : await completeChatCompletion({ model, workspaceDirectory, tools, resolved });
}

function spawnCursorAgent(input: { model: string; workspaceDirectory: string; prompt: string; resumeChatId?: string }) {
  const cmd = buildCursorAgentCommand(input.model, input.workspaceDirectory, input.resumeChatId);
  const child = spawn(formatShellCommandForPlatform(cmd[0]), cmd.slice(1), {
    cwd: input.workspaceDirectory,
    shell: process.platform === "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.write(input.prompt);
  child.stdin.end();
  return child;
}

async function completeChatCompletion(input: {
  model: string;
  workspaceDirectory: string;
  tools: Array<any>;
  resolved: ResolvedPrompt;
}): Promise<Response> {
  return new Response(JSON.stringify(await createCompletionPromise(input)), {
    headers: { "Content-Type": "application/json" },
  });
}

async function createCompletionPromise(input: {
  model: string;
  workspaceDirectory: string;
  tools: Array<any>;
  resolved: ResolvedPrompt;
}) {
  const child = spawnCursorAgent({
    model: input.model,
    workspaceDirectory: input.workspaceDirectory,
    prompt: input.resolved.prompt,
    resumeChatId: input.resolved.resumeChatId,
  });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
  const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
  const out = Buffer.concat(stdout).toString("utf8");
  const err = Buffer.concat(stderr).toString("utf8");

  captureResumeChatIdFromOutput(out, input.resolved.sessionKey, input.model, input.workspaceDirectory, input.resolved.recordContentPrefix, input.resolved.toolFingerprint, input.resolved.subagentFingerprint);

  const toolCall = firstToolCall(out, input.tools);
  if (toolCall) {
    return createToolCallCompletionResponse({ id: `cursor-acp-${Date.now()}`, created: Math.floor(Date.now() / 1000), model: `${CURSOR_PROVIDER_ID}/${input.model}` }, toolCall);
  }

  if (code !== 0) {
    maybeEvictResumeChatId(err || out, input.resolved.sessionKey, input.resolved.contentPrefix, input.resolved.toolFingerprint, input.resolved.subagentFingerprint);
    return createChatCompletionResponse(input.model, formatErrorForUser(parseAgentError(err || out || `cursor-agent exited with code ${code}`)));
  }

  const completion = extractCompletionFromStream(out);
  return createChatCompletionResponse(input.model, completion.assistantText || completion.reasoningText, completion.usage);
}

function firstToolCall(output: string, tools: Array<any>): OpenAiToolCall | undefined {
  const allowed = extractAllowedToolNames(tools);
  for (const line of output.split(/\r?\n/)) {
    const event = parseStreamJsonLine(line);
    if (!event || event.type !== "tool_call") continue;
    const extracted = extractOpenAiToolCall(event, allowed);
    if (extracted.action === "intercept") return extracted.toolCall;
  }
  return undefined;
}

function streamChatCompletion(input: {
  model: string;
  workspaceDirectory: string;
  tools: Array<any>;
  resolved: ResolvedPrompt;
}): Response {
  const encoder = new TextEncoder();
  const id = `cursor-acp-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const responseModel = `${CURSOR_PROVIDER_ID}/${input.model}`;
  const allowed = extractAllowedToolNames(input.tools);

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const child = spawnCursorAgent({
        model: input.model,
        workspaceDirectory: input.workspaceDirectory,
        prompt: input.resolved.prompt,
        resumeChatId: input.resolved.resumeChatId,
      });
      const stdout = new LineBuffer();
      const stderr: Buffer[] = [];
      const converter = new StreamToSseConverter(responseModel, { id, created });
      let emittedToolCall = false;

      const enqueue = (value: string) => controller.enqueue(encoder.encode(value));
      const handleLine = (line: string) => {
        const event = parseStreamJsonLine(line);
        if (!event || emittedToolCall) return;
        captureResumeChatIdFromEvent(event, input.resolved.sessionKey, input.model, input.workspaceDirectory, input.resolved.recordContentPrefix, input.resolved.toolFingerprint, input.resolved.subagentFingerprint);
        if (event.type === "tool_call") {
          const extracted = extractOpenAiToolCall(event, allowed);
          if (extracted.action === "intercept" && extracted.toolCall) {
            for (const chunk of createToolCallStreamChunks({ id, created, model: responseModel }, extracted.toolCall)) {
              enqueue(formatSseChunk(chunk));
            }
            emittedToolCall = true;
            child.kill("SIGTERM");
          }
          return;
        }
        if (isResult(event)) {
          const usage = extractOpenAiUsageFromResult(event);
          if (usage) enqueue(formatSseChunk(createChatCompletionUsageChunk(id, created, responseModel, usage)));
        }
        for (const chunk of converter.handleEvent(event)) enqueue(chunk);
      };

      child.stdout.on("data", (chunk) => {
        for (const line of stdout.push(chunk)) handleLine(line);
      });
      child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
      child.on("error", (error) => controller.error(error));
      child.on("close", (code) => {
        for (const line of stdout.flush()) handleLine(line);
        if (code !== 0 && !emittedToolCall) {
          const errorText = Buffer.concat(stderr).toString("utf8");
          maybeEvictResumeChatId(errorText, input.resolved.sessionKey, input.resolved.contentPrefix, input.resolved.toolFingerprint, input.resolved.subagentFingerprint);
          enqueue(formatSseChunk({ id, object: "chat.completion.chunk", created, model: responseModel, choices: [{ index: 0, delta: { content: formatErrorForUser(parseAgentError(errorText || `cursor-agent exited with code ${code}`)) }, finish_reason: "stop" }] }));
        }
        enqueue(formatSseDone());
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}

export const CursorPlugin: Plugin = async ({ directory, worktree }: PluginInput) => {
  const workspaceDirectory = resolveWorkspaceDirectory(worktree, directory);
  log.debug("Plugin initializing", { directory, worktree, workspaceDirectory, cwd: process.cwd() });
  await ensurePluginDirectory();
  const proxyBaseURL = await ensureCursorProxyServer(workspaceDirectory);

  return {
    auth: {
      provider: CURSOR_PROVIDER_ID,
      async loader(getAuth: () => Promise<Auth>) {
        await getAuth().catch(() => undefined);
        return {};
      },
      methods: [
        {
          type: "api" as const,
          label: "Cursor API Key (unused in cursor-agent mode; use cursor-agent login)",
        },
      ],
    },
    async "chat.params"(input: any, output: any) {
      const providerID = input?.model?.providerID ?? input?.model?.providerId ?? input?.model?.provider;
      if (providerID !== CURSOR_PROVIDER_ID) return;
      output.options = output.options || {};
      output.options.baseURL = proxyBaseURL;
      output.options.apiKey = output.options.apiKey || "cursor-agent";
    },
  };
};

export default CursorPlugin;
