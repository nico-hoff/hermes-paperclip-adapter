/**
 * Hermes Agent adapter for Paperclip.
 *
 * Runs Hermes Agent (https://github.com/NousResearch/hermes-agent)
 * as a managed employee in a Paperclip company. Hermes Agent is a
 * full-featured AI agent with 30+ native tools, persistent memory,
 * skills, session persistence, and MCP support.
 *
 * @packageDocumentation
 */

import { ADAPTER_TYPE, ADAPTER_LABEL } from "./shared/constants.js";

export const type = ADAPTER_TYPE;
export const label = ADAPTER_LABEL;

/**
 * Models available through Hermes Agent.
 *
 * This is a curated list of popular models across multiple providers.
 * Users can also enter any model name manually in the model field.
 * The adapter will auto-detect the provider or use the provider field.
 */
export const models: { id: string; label: string }[] = [
  // Anthropic (via anthropic provider)
  { id: "anthropic/claude-sonnet-4", label: "Claude Sonnet 4 (Anthropic)" },
  { id: "anthropic/claude-opus-4", label: "Claude Opus 4 (Anthropic)" },
  { id: "anthropic/claude-3.7-sonnet", label: "Claude 3.7 Sonnet (Anthropic)" },

  // OpenAI (via openai-codex / copilot)
  { id: "gpt-5.4", label: "GPT-5.4 (GitHub Copilot)" },
  { id: "o1", label: "O1 (OpenAI)" },
  { id: "o3-mini", label: "O3-mini (OpenAI)" },
  { id: "gpt-4.5-turbo", label: "GPT-4.5 Turbo (OpenAI)" },

  // OpenCode.go
  { id: "grok-3-turbo", label: "Grok 3 Turbo (xAI via OpenCode)" },
  { id: "gptdoc-5.4-vision", label: "GPTDoc 5.4 Vision (OpenCode)" },

  // Nous Research
  { id: "hermes-4", label: "Hermes 4 (Nous via OpenRouter)" },

  // Google Gemini (auto-routed)
  { id: "gemini-3.5-pro", label: "Gemini 3.5 Pro" },
  { id: "gemini-flash-3.5", label: "Gemini Flash 3.5" },

  // DeepSeek (auto-routed)
  { id: "deepseek-v3", label: "DeepSeek V3" },

  // Z.AI / GLM
  { id: "glm-5-turbo", label: "GLM-5 Turbo (Z.AI)" },

  // Meta Llama (auto-routed)
  { id: "llama-3.4-405b", label: "Llama 3.4 405B" },
];

/**
 * Documentation shown in the Paperclip UI when configuring a Hermes agent.
 */
export const agentConfigurationDoc = `# Hermes Agent Configuration

Hermes Agent is a full-featured AI agent by Nous Research with 30+ native
tools, persistent memory, session persistence, skills, and MCP support.

## Prerequisites

- Python 3.10+ installed
- Hermes Agent installed: \`pip install hermes-agent\`
- At least one LLM API key configured in ~/.hermes/.env

## Core Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| model | string | (Hermes configured default) | Optional explicit model in provider/model format. Leave blank to use Hermes's configured default model. |
| provider | string | (auto) | API provider: auto, openrouter, nous, openai-codex, zai, kimi-coding, minimax, minimax-cn. Usually not needed — Hermes auto-detects from model name. |
| timeoutSec | number | 300 | Execution timeout in seconds |
| graceSec | number | 10 | Grace period after SIGTERM before SIGKILL |

## Tool Configuration

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| toolsets | string | (all) | Comma-separated toolsets to enable (e.g. "terminal,file,web") |

## Session & Workspace

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| persistSession | boolean | true | Resume sessions across heartbeats |
| worktreeMode | boolean | false | Use git worktree for isolated changes |
| checkpoints | boolean | false | Enable filesystem checkpoints |

## Advanced

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| hermesCommand | string | hermes | Path to hermes CLI binary |
| verbose | boolean | false | Enable verbose output |
| extraArgs | string[] | [] | Additional CLI arguments |
| env | object | {} | Extra environment variables |
| promptTemplate | string | (default) | Custom prompt template with {{variable}} placeholders |

## Available Template Variables

- \`{{agentId}}\` — Paperclip agent ID
- \`{{agentName}}\` — Agent display name
- \`{{companyId}}\` — Paperclip company ID
- \`{{companyName}}\` — Company display name
- \`{{runId}}\` — Current heartbeat run ID
- \`{{taskId}}\` — Current task/issue ID (if assigned)
- \`{{taskTitle}}\` — Task title (if assigned)
- \`{{taskBody}}\` — Task description (if assigned)
- \`{{projectName}}\` — Project name (if scoped to a project)
`;
