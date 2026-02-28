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

This plugin reads GitHub Copilot CLI's local session files from `~/.copilot/session-state/` to extract:

- Session metadata (start time, project path, summary)
- Token usage per message (estimated from content length; real data when available)
- Model information per conversation turn via `session.model_change` timeline
- Real-time file watching for live session updates

### Token Data Limitations

Copilot CLI currently marks all token-bearing events (`assistant.usage`, `session.shutdown`) as **ephemeral**, meaning they are tracked in-memory for the `/usage` command but never written to `events.jsonl`. As a result, token counts are **estimated** from response content length (~4 chars/token). The plugin is structured to automatically use real token data (including cache read/write breakdown) when Copilot CLI begins persisting `assistant.usage` events. See [copilot-cli#1152](https://github.com/github/copilot-cli/issues/1152).

### Model Tracking

The plugin builds a timeline from `session.model_change` events and resolves the correct model for each message based on its timestamp. If a user switches models mid-session, each model appears as a separate entry — matching the behavior of the Claude Code and OpenCode plugins.

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
| Filesystem | Read | `~/.copilot` |

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
