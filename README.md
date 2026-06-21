# hermes-paperclip-adapter-pow

> [!WARNING]
> **This fork is no longer maintained.**
> The community has converged on **[HenkDz/hermes-paperclip-adapter](https://github.com/HenkDz/hermes-paperclip-adapter)** (`@henkey/hermes-paperclip-adapter`) as the canonical maintained fork.
> HenkDz is the author of the Paperclip external adapter/plugin system and his fork is architecturally aligned with the current Paperclip loader/runtime contract.
> Please use that instead — this repo will not receive further updates.

> **Community PoW (Proof of Work) fork** of [NousResearch/hermes-paperclip-adapter](https://github.com/NousResearch/hermes-paperclip-adapter).
> The upstream repo has 56 open issues and 86 open PRs with zero maintainer activity since March 2026.
> This fork cherry-picks all high-quality community PRs, adds P2 features, and publishes under a distinct npm name.

A [Paperclip](https://paperclip.ing) adapter that lets you run [Hermes Agent](https://github.com/NousResearch/hermes-agent) as a managed employee in a Paperclip company.

## Install

```bash
npm install hermes-paperclip-adapter-pow
```

## What's Different From Upstream

This fork applies 3 sprints of fixes and features that upstream has not merged:

### Sprint 1 — P0 fixes (make it work at all)
| Fix | Upstream issue |
|-----|---------------|
| Forward `ctx.onSpawn` so orphan reaper doesn't kill all runs | #106 |
| Add `createServerAdapter()` export required by adapter loader | — |
| Read wake context from `ctx.context.*` not `ctx.config.*` | #132 |
| `sanitizeUserEnv()`: skip unresolved `secret_ref` descriptors | — |
| Validate session IDs before `--resume` to prevent death-loops | — |
| Always inject `ctx.authToken` as `PAPERCLIP_API_KEY` | #53, #93 |
| Drop `VALID_PROVIDERS` gate — custom/plugin providers now work | #158, #157 |

### Sprint 2 — P1 reliability fixes
| Fix | Upstream issue |
|-----|---------------|
| Tighten `SESSION_ID_REGEX` to `YYYYMMDD_HHMMSS_<hex>` format | #131, #142 |
| Skip Hermes run when issue is already `done`/`cancelled` | #92 |
| POST usage data to Paperclip heartbeat-runs API | #145 |
| Keepalive ping every 25s during long silent syntheses | #89 |
| Inject `PAPERCLIP_API_URL` into spawned Hermes env | #117 |
| Consume fetch response body to prevent `CLOSE_WAIT` socket leak | #89 |
| `IN_FLIGHT_AGENTS` concurrency guard prevents retry storms | #90 |

### Sprint 3 — P2 features
| Feature | Upstream issue |
|---------|---------------|
| Inject agent persona files (AGENTS.md / SOUL.md) via `supportsInstructionsBundle` | #124 |
| `latestCommentBody` template variable — body inline in prompt | #130 |
| `requiresMaterializedRuntimeSkills` — Paperclip skills on disk before run | #162 |
| Artifact upload — files in `artifacts/` uploaded as Paperclip attachments | #170 |
| Tool-transcript fallback for silent completions | #121 |
| Classify `ClosedResourceError` as benign so MCP shutdown isn't shown as error | #104 |
| ESM-safe `getHermesPython()` — no `require()` in ESM module body | #105 |

## Key Features

- **8 inference providers** — Anthropic, OpenRouter, OpenAI Codex, Nous, ZAI, Kimi, MiniMax, GitHub Copilot
- **Persona injection** — Agent's AGENTS.md / SOUL.md prepended to every prompt
- **Comment-driven wakes** — `latestCommentBody` delivered inline so Hermes sees the comment without a curl round-trip
- **Artifact upload** — Files saved to `artifacts/` during a run are automatically uploaded as Paperclip attachments
- **Skills integration** — Unified snapshot of Paperclip-managed + Hermes-native skills from `~/.hermes/skills/`
- **Session persistence** — `--resume` across heartbeats; strict session ID validation prevents death-loops
- **Silent completion recovery** — Tool-transcript fallback when agent produces no final text response
- **Concurrency guard** — One run per agent at a time; concurrent duplicate runs return immediately
- **Wake-loop protection** — Skips spawning Hermes for done/cancelled issues
- **MCP clean shutdown** — `ClosedResourceError` reclassified as benign stdout

## Quick Start

### Prerequisites

- [Hermes Agent](https://github.com/NousResearch/hermes-agent) installed: `pip install hermes-agent`
- Python 3.10+
- At least one LLM API key

### Register the adapter

```typescript
import { createServerAdapter } from "hermes-paperclip-adapter-pow/server";

// In your Paperclip adapter registry:
registry.set("hermes_local", createServerAdapter());
```

Or use named exports:

```typescript
import {
  execute,
  testEnvironment,
  listSkills,
  syncSkills,
  sessionCodec,
  getHermesPython,
} from "hermes-paperclip-adapter-pow/server";
```

### Create a Hermes agent

```json
{
  "name": "Hermes Engineer",
  "adapterType": "hermes_local",
  "adapterConfig": {
    "model": "anthropic/claude-sonnet-4",
    "timeoutSec": 1800,
    "persistSession": true,
    "toolsets": "terminal,file,web"
  }
}
```

## Configuration Reference

### Core

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | string | *(Hermes default)* | Model in `provider/model` format. Leave blank to use `~/.hermes/config.yaml` default. |
| `provider` | string | *(auto-detected)* | API provider. Usually not needed — inferred from model name. |
| `timeoutSec` | number | `1800` | Execution timeout in seconds |
| `graceSec` | number | `10` | Grace period before SIGKILL |

### Tools

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `toolsets` | string | *(all)* | Comma-separated toolsets: `terminal,file,web,browser,mcp,...` |

### Session & Workspace

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `persistSession` | boolean | `true` | Resume sessions across heartbeats via `--resume` |
| `worktreeMode` | boolean | `false` | Git worktree isolation |
| `checkpoints` | boolean | `false` | Filesystem checkpoints for rollback |

### Advanced

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `hermesCommand` | string | `hermes` | Custom CLI binary path |
| `verbose` | boolean | `false` | Verbose output |
| `quiet` | boolean | `true` | Quiet mode — clean output, no banner |
| `extraArgs` | string[] | `[]` | Extra CLI arguments |
| `env` | object | `{}` | Extra environment variables |
| `promptTemplate` | string | *(built-in)* | Custom Mustache-style prompt template |
| `paperclipApiUrl` | string | `http://127.0.0.1:3100` | Paperclip API base URL |
| `instructionsFilePath` | string | *(set by Paperclip)* | Path to AGENTS.md/SOUL.md bundle (auto-injected when `supportsInstructionsBundle`) |

### Prompt Template Variables

| Variable | Description |
|----------|-------------|
| `{{agentId}}` | Paperclip agent ID |
| `{{agentName}}` | Agent display name |
| `{{companyId}}` | Company ID |
| `{{taskId}}` | Assigned task/issue ID |
| `{{taskTitle}}` | Task title |
| `{{taskBody}}` | Task description |
| `{{commentId}}` | Wake comment ID |
| `{{latestCommentBody}}` | Body text of the wake comment (inline, no curl needed) |
| `{{personaContent}}` | Agent persona from AGENTS.md / SOUL.md |
| `{{paperclipApiUrl}}` | Paperclip API base URL |
| `{{wakeReason}}` | Why this run was triggered |

Conditional sections:

- `{{#taskId}}...{{/taskId}}` — when task assigned
- `{{#noTask}}...{{/noTask}}` — when no task (heartbeat check)
- `{{#commentId}}...{{/commentId}}` — when woken by a comment
- `{{#latestCommentBody}}...{{/latestCommentBody}}` — when comment body is available
- `{{^latestCommentBody}}...{{/latestCommentBody}}` — when comment body is NOT available
- `{{#personaContent}}...{{/personaContent}}` — when persona file is loaded

### Artifact Upload

Any file saved to the `artifacts/` directory inside the working directory during a run is automatically uploaded to Paperclip as an issue attachment after execution completes. Instruct Hermes agents to save deliverables there:

```
Save your output to ./artifacts/report.pdf
```

## Architecture

```
Paperclip                          Hermes Agent
┌──────────────────┐               ┌──────────────────┐
│  Heartbeat       │               │                  │
│  Scheduler       │───execute()──▶│  hermes chat -q  │
│                  │               │                  │
│  Issue System    │               │  30+ Tools       │
│  Comment Wakes   │◀──results─────│  Memory System   │
│                  │               │  Session DB      │
│  Cost Tracking   │               │  Skills          │
│  Artifact Store  │◀──artifacts───│  MCP Client      │
│  Skill Sync      │◀──snapshot────│  ~/.hermes/skills│
│  Persona Bundle  │──AGENTS.md───▶│                  │
└──────────────────┘               └──────────────────┘
```

## Development

```bash
# Clone this fork (not the upstream)
git clone https://github.com/nico-hoff/hermes-paperclip-adapter
cd hermes-paperclip-adapter
npm install
npm test        # 33 tests
npm run build
```

### Key differences from upstream

- Package name: `hermes-paperclip-adapter-pow` (not `hermes-paperclip-adapter`)
- All community PRs cherry-picked and tested
- Additional P2 features not in any open PR
- No `VALID_PROVIDERS` gate — any provider string is passed through to Hermes
- Session IDs validated with strict regex before `--resume` (prevents death-loops)
- `ctx.context.*` is the authoritative source for wake context (not `ctx.config.*`)

## License

MIT — see [LICENSE](LICENSE)

## Links

- [Upstream repo](https://github.com/NousResearch/hermes-paperclip-adapter) — original (unmaintained)
- [This fork](https://github.com/nico-hoff/hermes-paperclip-adapter) — community PoW
- [Hermes Agent](https://github.com/NousResearch/hermes-agent) — the AI agent this adapter runs
- [Paperclip](https://paperclip.ing) — the orchestration platform
