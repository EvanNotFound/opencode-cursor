# open-cursor

Use Cursor subscription models in OpenCode.

This is a small OpenCode provider plugin. It runs Cursor's official `cursor-agent` CLI behind a local OpenAI-compatible proxy, so OpenCode can use models like:

- `cursor-acp/auto`
- `cursor-acp/sonnet-4.5`
- `cursor-acp/gpt-5.5`

## Why this exists

This project is a spinoff of [Nomadcxx/opencode-cursor](https://github.com/Nomadcxx/opencode-cursor).

Credit to that project for the original Cursor/OpenCode integration work.

I am building this because I want the smallest useful version of the idea:

- Cursor subscription models inside OpenCode
- native OpenCode tools
- native OpenCode patch previews
- no custom `oc_*` tool bridge
- no SDK backend
- no MCP bridge
- no extra compatibility layers

The previous project became too broad and bloated for my use case. This one is intentionally narrower.

## Requirements

- OpenCode
- Bun
- Cursor CLI / `cursor-agent`
- Cursor account logged in with:

```bash
cursor-agent login
```

## Install

```bash
npm install -g @evanovation/open-cursor
open-cursor install
```

Verify:

```bash
opencode models | grep cursor-acp
```

## Use

```bash
opencode run "hello" --model cursor-acp/auto
opencode run "write a small script" --model cursor-acp/sonnet-4.5
```

## Sync models

```bash
open-cursor sync-models
```

Optional compact model list:

```bash
open-cursor sync-models --variants --compact
```

## How it works

OpenCode talks to a local OpenAI-compatible proxy at:

```txt
http://127.0.0.1:32124/v1
```

The proxy starts `cursor-agent`, converts Cursor stream-json output into OpenAI-compatible responses, and sends tool calls back to OpenCode.

OpenCode executes its own tools. This keeps edit/write/apply_patch behavior native, including patch previews and permissions.

## Troubleshooting

Check setup:

```bash
open-cursor doctor
```

Common fixes:

```bash
cursor-agent login
open-cursor install
open-cursor sync-models
```

Enable debug logs:

```bash
CURSOR_ACP_LOG_LEVEL=debug opencode run "test" --model cursor-acp/auto
```

## Development

```bash
git clone https://github.com/EvanNotFound/opencode-cursor.git
cd opencode-cursor
bun install
bun run build
bun test tests/unit
```

## License

BSD-3-Clause
