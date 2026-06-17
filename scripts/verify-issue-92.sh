#!/usr/bin/env bash
# Issue #92 regression gate: build, perf-focused tests, production import, logger smoke.
set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> build"
npm run build

echo "==> perf-focused tests"
npm run test:perf

echo "==> Node ESM import smoke"
node -e "import('./dist/plugin-entry.js').then(()=>console.log('import ok')).catch(e=>{console.error(e.stack||e.message); process.exit(1)})"

echo "==> async logger smoke"
bun -e "
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const fakeHome = mkdtempSync(join(tmpdir(), 'verify-issue-92-home-'));
process.env.CURSOR_ACP_LOG_DIR = join(fakeHome, '.opencode-cursor');
const { createLogger, _resetLoggerState } = await import('./src/utils/logger.ts');
const logFile = join(fakeHome, '.opencode-cursor', 'plugin.log');
const marker = 'verify-issue-92-' + Date.now();
delete process.env.CURSOR_ACP_LOG_SILENT;
process.env.CURSOR_ACP_LOG_LEVEL = 'info';
_resetLoggerState();
const log = createLogger('verify-issue-92');
log.info(marker);
await new Promise((resolve) => setTimeout(resolve, 250));
if (!existsSync(logFile)) throw new Error('plugin.log not created');
const contents = readFileSync(logFile, 'utf8');
if (!contents.includes(marker)) throw new Error('marker not found in plugin.log');
console.log('logger ok');
rmSync(fakeHome, { recursive: true, force: true });
"

echo ""
echo "All issue #92 regression checks passed."
