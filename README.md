# @tokentop/agent-copilot-cli

[![npm](https://img.shields.io/npm/v/@tokentop/agent-copilot-cli?style=flat-square&color=CB3837&logo=npm)](https://www.npmjs.com/package/@tokentop/agent-copilot-cli)
[![CI](https://img.shields.io/github/actions/workflow/status/tokentopapp/agent-copilot-cli/ci.yml?style=flat-square&label=CI)](https://github.com/tokentopapp/agent-copilot-cli/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)

[tokentop](https://github.com/tokentopapp/tokentop) agent plugin for **GitHub Copilot CLI** (GitHub's terminal coding agent). Parses session data, tracks token usage, and provides real-time activity monitoring.

## Capabilities

| Capability | Status |
|-----------|--------|
| Session parsing | Yes |
| Credential reading | No |
| Real-time tracking | Yes |
| Multi-provider | No |

## How It Works

This plugin reads GitHub Copilot CLI's local session files from `~/.copilot/session-state/` and process logs from `~/.copilot/logs/` to extract:

- Session metadata (start time, project path, summary)
- Token usage per message (estimated from CompactionProcessor deltas in process logs; real `assistant.usage` data when available)
- Model identification from any event's `data.model` field — no hardcoded model list required
- Real-time file watching for live session updates

### Token Estimation

Copilot CLI marks token-bearing events (`assistant.usage`, `session.shutdown`) as **ephemeral** — they're tracked in-memory for the `/usage` command but never written to `events.jsonl` (see [copilot-cli#1152](https://github.com/github/copilot-cli/issues/1152)). To work around this, the plugin parses **CompactionProcessor** entries from process logs (`~/.copilot/logs/process-*.log`), which report the running token count of the conversation context before each model request.

Token estimation uses a priority chain:

1. **Real usage data** — `assistant.usage` events (used automatically if Copilot CLI begins persisting them)
2. **CompactionProcessor deltas** — input tokens from the CP entry, output tokens from the delta between consecutive entries
3. **Content-length fallback** — `content.length / 4` heuristic (last resort when no process log is available)

Each process log maps 1:1 to a session via the `Workspace initialized: {session-uuid}` line. The compaction index is built once and cached for 60 seconds.

### Model Tracking

The plugin identifies models generically by scanning **all** event types for a `data.model` field — no hardcoded model names or event types. This means new models (e.g. `gpt-5.3-codex`) are picked up automatically without code changes. The resolution priority is:

1. `assistant.message` → `data.model`
2. `session.model_change` timeline (timestamp-based)
3. Any event with `data.model` (e.g. `tool.execution_complete`)
4. Process log `Using default model:` line
5. `'unknown'`

If a user switches models mid-session, each model segment appears as a separate entry — matching the behavior of the Claude Code and OpenCode plugins.

## Install

This plugin is **bundled with tokentop** — no separate install needed. If you need it standalone:

```bash
bun add @tokentop/agent-copilot-cli
```

## Requirements

- [GitHub Copilot CLI](https://docs.github.com/en/copilot/using-github-copilot/using-github-copilot-in-the-command-line) installed (`~/.copilot` directory must exist)
- [Bun](https://bun.sh/) >= 1.0.0
- `@tokentop/plugin-sdk` ^1.3.0 (peer dependency)

## Permissions

| Type | Access | Paths |
|------|--------|-------|
| Filesystem | Read | `~/.copilot/session-state/`, `~/.copilot/logs/` |

## Development

```bash
bun install
bun run build
bun test
bun run typecheck
```

## Contributing

See the [Contributing Guide](https://github.com/tokentopapp/.github/blob/main/CONTRIBUTING.md). Issues for this plugin should be [filed on the main tokentop repo](https://github.com/tokentopapp/tokentop/issues/new?template=bug_report.yml&labels=bug,agent-copilot-cli).

## License

MIT
