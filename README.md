# NanoClaw (OpenCode Edition)

Personal AI assistant powered by [OpenCode](https://opencode.ai). Lightweight, secure, customizable.

A fork/rewrite of [NanoClaw](https://github.com/qwibitai/nanoclaw) — replacing the Claude Code engine with OpenCode for multi-provider LLM support (75+ models).

## How It Works

```
Channels (WhatsApp, Telegram, Slack, Discord, Gmail)
    ↓
  SQLite (messages, groups, sessions)
    ↓
  Polling Loop
    ↓
  Docker Container (OpenCode agent)
    ↓
  Response → Channel
```

A single Node.js process orchestrates everything. Agents run in isolated Docker containers with filesystem sandboxing. Each group gets its own working directory, instructions file, and OpenCode config.

## Key Differences from Original NanoClaw

| | Original (CC) | This Fork (OpenCode) |
|---|---|---|
| Agent Engine | Claude Code CLI | OpenCode CLI |
| Instructions | `CLAUDE.md` | `AGENTS.md` |
| Config | Claude Code settings | `opencode.json` |
| SDK | `@anthropic-ai/claude-code` | `@opencode-ai/sdk` |
| Models | Claude only | 75+ models (Claude, GPT, Gemini, local, etc.) |
| Database | `better-sqlite3` (native) | `node:sqlite` (built-in, zero native deps) |
| Node.js | >=20 | >=22.5 |

## Quick Start

```bash
# 1. Clone
git clone https://github.com/yoyogo96/nanoclaw-opencode.git
cd nanoclaw-opencode

# 2. Install
npm install

# 3. Configure
cp .env.example .env
# Edit .env — add at least one API key (ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.)

# 4. Build the agent container
./container/build.sh

# 5. Run
npm run dev
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | — | Anthropic API key |
| `OPENAI_API_KEY` | — | OpenAI API key |
| `GOOGLE_API_KEY` | — | Google AI API key |
| `ASSISTANT_NAME` | `Andy` | Assistant trigger name |
| `OPENCODE_MODEL` | `anthropic/claude-sonnet-4-20250514` | Default model |
| `CONTAINER_IMAGE` | `nanoclaw-agent:latest` | Docker image name |
| `CONTAINER_TIMEOUT` | `1800000` | Container timeout (ms) |
| `MAX_CONCURRENT_CONTAINERS` | `5` | Max parallel agents |

### Per-Group Customization

Each group in `groups/<name>/` has:
- `AGENTS.md` — Natural language instructions for the agent
- `opencode.json` — OpenCode configuration (model, tools, permissions)
- `.opencode/` — OpenCode state directory

## Architecture

```
src/
├── index.ts              # Main orchestrator
├── config.ts             # Configuration constants
├── types.ts              # TypeScript interfaces
├── db.ts                 # SQLite via node:sqlite
├── env.ts                # Secure .env parsing (no process.env leakage)
├── logger.ts             # Pino structured logging
├── router.ts             # Message formatting & channel routing
├── container-runner.ts   # OpenCode container execution
├── container-runtime.ts  # Docker runtime abstraction
├── group-queue.ts        # Per-group concurrency control
├── group-folder.ts       # Group directory management
├── ipc.ts                # File-based inter-process communication
├── task-scheduler.ts     # Cron/interval/once task scheduling
├── mount-security.ts     # Volume mount validation
├── sender-allowlist.ts   # Sender authorization
└── channels/
    ├── index.ts
    └── registry.ts       # Channel factory pattern
```

### Security

- Agents run in **isolated Docker containers**
- Project root is mounted **read-only**
- `.env` is shadowed with `/dev/null` — secrets passed via environment variables, never files
- Per-group filesystem isolation prevents cross-group data access
- Sender allowlist restricts who can interact
- Mount allowlist controls what host paths containers can access

### Channels

Channels are added as skills (same as original NanoClaw):
- WhatsApp, Telegram, Discord, Slack, Gmail
- Self-registering factory pattern — add new channels by implementing the `Channel` interface

### Scheduled Tasks

Agents can schedule recurring jobs via IPC:
- **Cron**: `"0 9 * * 1-5"` (weekdays at 9am)
- **Interval**: `3600000` (every hour)
- **Once**: ISO timestamp for one-time execution

## Development

```bash
npm run dev          # Run with hot reload (tsx)
npm run build        # Compile TypeScript
npm run typecheck    # Type-check without emitting
npm run test         # Run tests (vitest)
```

## Requirements

- Node.js >= 22.5
- Docker
- At least one LLM API key

## License

MIT
