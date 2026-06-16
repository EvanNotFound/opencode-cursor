// src/utils/logger.ts

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

type LogLevel = "debug" | "info" | "warn" | "error";

const LOG_DIR = path.join(os.homedir(), ".opencode-cursor");
const LOG_FILE = path.join(LOG_DIR, "plugin.log");
const MAX_LOG_SIZE = 5 * 1024 * 1024;

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

function getConfiguredLevel(): LogLevel {
  const env = process.env.CURSOR_ACP_LOG_LEVEL?.toLowerCase();
  if (env && env in LEVEL_PRIORITY) {
    return env as LogLevel;
  }
  return "info";
}

function isSilent(): boolean {
  return process.env.CURSOR_ACP_LOG_SILENT === "1" ||
         process.env.CURSOR_ACP_LOG_SILENT === "true";
}

function shouldLog(level: LogLevel): boolean {
  if (isSilent()) return false;
  const configured = getConfiguredLevel();
  return LEVEL_PRIORITY[level] >= LEVEL_PRIORITY[configured];
}

function formatMessage(level: LogLevel, component: string, message: string, data?: unknown): string {
  const prefix = `[cursor-acp:${component}]`;
  const levelTag = level.toUpperCase().padEnd(5);

  let formatted = `${prefix} ${levelTag} ${message}`;

  if (data !== undefined) {
    if (typeof data === "object") {
      formatted += ` ${JSON.stringify(data)}`;
    } else {
      formatted += ` ${data}`;
    }
  }

  return formatted;
}

function isConsoleEnabled(): boolean {
  const consoleEnv = process.env.CURSOR_ACP_LOG_CONSOLE;
  return consoleEnv === "1" || consoleEnv === "true";
}

let logDirEnsured = false;
let logFileError = false;
let logStream: fs.WriteStream | null = null;
let logBytesWritten = 0;

/** Reset internal state (for testing only) */
export function _resetLoggerState(): void {
  logDirEnsured = false;
  logFileError = false;
  if (logStream) {
    logStream.end();
    logStream = null;
  }
  logBytesWritten = 0;
}

function ensureLogDir(): void {
  if (logDirEnsured) return;
  try {
    if (!fs.existsSync(LOG_DIR)) {
      fs.mkdirSync(LOG_DIR, { recursive: true });
    }
    logDirEnsured = true;
  } catch {
    logFileError = true;
  }
}

function openLogStream(): void {
  if (logStream || logFileError) return;
  ensureLogDir();
  if (logFileError) return;

  try {
    // Seed byte counter from existing file size
    try {
      logBytesWritten = fs.statSync(LOG_FILE).size;
    } catch {
      logBytesWritten = 0;
    }
    logStream = fs.createWriteStream(LOG_FILE, { flags: "a" });
    logStream.on("error", () => {
      if (!logFileError) {
        logFileError = true;
        console.error(`[cursor-acp] Failed to write logs. Using: ${LOG_FILE}`);
      }
      logStream = null;
    });
  } catch {
    logFileError = true;
  }
}

function rotateIfNeeded(): void {
  if (logBytesWritten < MAX_LOG_SIZE) return;
  try {
    if (logStream) {
      logStream.end();
      logStream = null;
    }
    fs.renameSync(LOG_FILE, LOG_FILE + ".1");
    logBytesWritten = 0;
    openLogStream();
  } catch {
    // Rotation failed — keep writing to current file
  }
}

function writeToFile(message: string): void {
  if (logFileError) return;

  if (!logStream) openLogStream();
  if (logFileError || !logStream) return;

  rotateIfNeeded();

  const timestamp = new Date().toISOString();
  const line = `${timestamp} ${message}\n`;
  logStream.write(line);
  logBytesWritten += Buffer.byteLength(line);
}

export interface Logger {
  debug: (message: string, data?: unknown) => void;
  info: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
  error: (message: string, data?: unknown) => void;
}

export function createLogger(component: string): Logger {
  return {
    debug: (message: string, data?: unknown) => {
      if (!shouldLog("debug")) return;
      const formatted = formatMessage("debug", component, message, data);
      writeToFile(formatted);
      if (isConsoleEnabled()) console.error(formatted);
    },
    info: (message: string, data?: unknown) => {
      if (!shouldLog("info")) return;
      const formatted = formatMessage("info", component, message, data);
      writeToFile(formatted);
      if (isConsoleEnabled()) console.error(formatted);
    },
    warn: (message: string, data?: unknown) => {
      if (!shouldLog("warn")) return;
      const formatted = formatMessage("warn", component, message, data);
      writeToFile(formatted);
      if (isConsoleEnabled()) console.error(formatted);
    },
    error: (message: string, data?: unknown) => {
      if (!shouldLog("error")) return;
      const formatted = formatMessage("error", component, message, data);
      writeToFile(formatted);
      if (isConsoleEnabled()) console.error(formatted);
    },
  };
}
