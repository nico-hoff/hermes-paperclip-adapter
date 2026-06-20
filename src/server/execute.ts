/**
 * Server-side execution logic for the Hermes Agent adapter.
 *
 * Spawns `hermes chat -q "..." -Q` as a child process, streams output,
 * and returns structured results to Paperclip.
 *
 * Verified CLI flags (hermes chat):
 *   -q/--query         single query (non-interactive)
 *   -Q/--quiet         quiet mode (no banner/spinner, only response + session_id)
 *   -m/--model         model name (e.g. anthropic/claude-sonnet-4)
 *   -t/--toolsets      comma-separated toolsets to enable
 *   --provider         inference provider (auto, openrouter, nous, etc.)
 *   -r/--resume        resume session by ID
 *   -w/--worktree      isolated git worktree
 *   -v/--verbose       verbose output
 *   --checkpoints      filesystem checkpoints
 *   --yolo             bypass dangerous-command approval prompts (agents have no TTY)
 *   --source           session source tag for filtering
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  UsageSummary,
} from "@paperclipai/adapter-utils";

import {
  runChildProcess,
  buildPaperclipEnv,
  renderTemplate,
  ensureAbsoluteDirectory,
} from "@paperclipai/adapter-utils/server-utils";

import {
  HERMES_CLI,
  DEFAULT_TIMEOUT_SEC,
  DEFAULT_GRACE_SEC,
  DEFAULT_MODEL,
} from "../shared/constants.js";

import {
  detectModel,
  resolveProvider,
} from "./detect-model.js";

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

function cfgString(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function cfgNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}
function cfgBoolean(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}
function cfgStringArray(v: unknown): string[] | undefined {
  return Array.isArray(v) && v.every((i) => typeof i === "string")
    ? (v as string[])
    : undefined;
}

// ---------------------------------------------------------------------------
// Wake-up prompt builder
// ---------------------------------------------------------------------------

const DEFAULT_PROMPT_TEMPLATE = `{{#personaContent}}{{personaContent}}

---

{{/personaContent}}You are "{{agentName}}", an AI agent employee in a Paperclip-managed company.

IMPORTANT: Use \`terminal\` tool with \`curl\` for ALL Paperclip API calls (web_extract and browser cannot access localhost).

## Paperclip API authentication

Paperclip injects the credentials you need into the Hermes process environment:
  - PAPERCLIP_API_KEY: bearer token for Paperclip API calls
  - PAPERCLIP_RUN_ID: current heartbeat/run id for audit logging

Every Paperclip API curl MUST include both headers:
  \`-H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID"\`

Your Paperclip identity:
  Agent ID: {{agentId}}
  Company ID: {{companyId}}
  API Base: {{paperclipApiUrl}}

{{#taskId}}
## Assigned Task

Issue ID: {{taskId}}
Title: {{taskTitle}}

{{taskBody}}

## Workflow

1. Work on the task using your tools
2. When done, mark the issue as completed:
   \`curl -s -X PATCH -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" "{{paperclipApiUrl}}/issues/{{taskId}}" -H "Content-Type: application/json" -d '{"status":"done"}'\`
3. Post a completion comment on the issue summarizing what you did:
   \`curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" "{{paperclipApiUrl}}/issues/{{taskId}}/comments" -H "Content-Type: application/json" -d '{"body":"DONE: <your summary here>"}'\`
4. If you produced any output files (reports, code, data files), save them into the \`artifacts/\` directory in your working directory so they are automatically uploaded to Paperclip as run artifacts.
5. If this issue has a parent (check the issue body or comments for references like TRA-XX), post a brief notification on the parent issue so the parent owner knows:
   \`curl -s -X POST -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" "{{paperclipApiUrl}}/issues/PARENT_ISSUE_ID/comments" -H "Content-Type: application/json" -d '{"body":"{{agentName}} completed {{taskId}}. Summary: <brief>"}'\`
{{/taskId}}

{{#commentId}}
## Comment on This Issue

Someone commented on your task.

{{#latestCommentBody}}Comment content:
> {{latestCommentBody}}

{{/latestCommentBody}}{{^latestCommentBody}}Fetch the full comment:
   \`curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" "{{paperclipApiUrl}}/issues/{{taskId}}/comments/{{commentId}}" | python3 -m json.tool\`

{{/latestCommentBody}}Address the comment, POST a reply if needed, then continue working.
{{/commentId}}

{{#noTask}}
## Heartbeat Wake — Check for Work

1. List ALL open issues assigned to you (todo, backlog, in_progress):
   \`curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" "{{paperclipApiUrl}}/companies/{{companyId}}/issues?assigneeAgentId={{agentId}}" | python3 -c "import sys,json;issues=json.loads(sys.stdin.read());[print(f'{i[\"identifier\"]} {i[\"status\"]:>12} {i[\"priority\"]:>6} {i[\"title\"]}') for i in issues if i['status'] not in ('done','cancelled')]" \`

2. If issues found, pick the highest priority one that is not done/cancelled and work on it:
   - Read the issue details: \`curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" "{{paperclipApiUrl}}/issues/ISSUE_ID"\`
   - Do the work in the project directory: {{projectName}}
   - When done, mark complete and post a comment (see Workflow steps 2-4 above)

3. If no issues assigned to you, check for unassigned issues:
   \`curl -s -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" "{{paperclipApiUrl}}/companies/{{companyId}}/issues?status=backlog" | python3 -c "import sys,json;issues=json.loads(sys.stdin.read());[print(f'{i[\"identifier\"]} {i[\"title\"]}') for i in issues if not i.get('assigneeAgentId')]" \`
   If you find a relevant issue, assign it to yourself:
   \`curl -s -X PATCH -H "Authorization: Bearer $PAPERCLIP_API_KEY" -H "X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID" "{{paperclipApiUrl}}/issues/ISSUE_ID" -H "Content-Type: application/json" -d '{"assigneeAgentId":"{{agentId}}","status":"todo"}'\`

4. If truly nothing to do, report briefly what you checked.
{{/noTask}}`;

function buildPrompt(
  ctx: AdapterExecutionContext,
  config: Record<string, unknown>,
  personaContent: string,
): string {
  const template = cfgString(config.promptTemplate) || DEFAULT_PROMPT_TEMPLATE;

  // Paperclip places wake context on ctx.context (the contextSnapshot), not on
  // ctx.config (the resolved runtimeConfig: workspace + skills + env). Read task
  // fields from ctx.context, with fallbacks to paperclipIssue / paperclipWake.issue
  // (current Paperclip nests them there; the flat fields exist on older builds) and
  // ctx.config last for backward-compat. Fixes #68.
  const wakeCtx = (ctx.context ?? {}) as {
    taskId?: unknown;
    issueId?: unknown;
    taskTitle?: unknown;
    taskBody?: unknown;
    commentId?: unknown;
    wakeCommentId?: unknown;
    wakeReason?: unknown;
    companyName?: unknown;
    projectName?: unknown;
    paperclipTaskMarkdown?: unknown;
    latestCommentBody?: unknown;
    wakeCommentBody?: unknown;
    paperclipIssue?: { id?: unknown; title?: unknown; description?: unknown };
    paperclipWake?: { reason?: unknown; issue?: { id?: unknown; title?: unknown }; commentBody?: unknown };
  };
  const wakeIssue = wakeCtx.paperclipWake?.issue ?? {};
  const ctxIssue = wakeCtx.paperclipIssue ?? {};

  const taskId =
    cfgString(wakeCtx.taskId) ||
    cfgString(wakeCtx.issueId) ||
    cfgString(wakeIssue.id) ||
    cfgString(ctxIssue.id) ||
    cfgString(ctx.config?.taskId);
  const taskTitle =
    cfgString(ctxIssue.title) ||
    cfgString(wakeIssue.title) ||
    cfgString(wakeCtx.taskTitle) ||
    cfgString(ctx.config?.taskTitle) ||
    "";
  const taskBody =
    cfgString(ctxIssue.description) ||
    cfgString(wakeCtx.paperclipTaskMarkdown) ||
    cfgString(wakeCtx.taskBody) ||
    cfgString(ctx.config?.taskBody) ||
    "";
  const commentId =
    cfgString(wakeCtx.commentId) ||
    cfgString(wakeCtx.wakeCommentId) ||
    cfgString(ctx.config?.commentId) ||
    "";
  // latestCommentBody: the body text of the wake-triggering comment (#130)
  const latestCommentBody =
    cfgString(wakeCtx.latestCommentBody) ||
    cfgString(wakeCtx.wakeCommentBody) ||
    cfgString(wakeCtx.paperclipWake?.commentBody) ||
    cfgString(ctx.config?.latestCommentBody) ||
    "";
  const wakeReason =
    cfgString(wakeCtx.wakeReason) ||
    cfgString(wakeCtx.paperclipWake?.reason) ||
    cfgString(ctx.config?.wakeReason) ||
    "";
  const agentName = ctx.agent?.name || "Hermes Agent";
  const companyName =
    cfgString(wakeCtx.companyName) || cfgString(ctx.config?.companyName) || "";
  const projectName =
    cfgString(wakeCtx.projectName) || cfgString(ctx.config?.projectName) || "";

  // Build API URL — ensure it has the /api path
  let paperclipApiUrl =
    cfgString(config.paperclipApiUrl) ||
    process.env.PAPERCLIP_API_URL ||
    "http://127.0.0.1:3100/api";
  // Ensure /api suffix
  if (!paperclipApiUrl.endsWith("/api")) {
    paperclipApiUrl = paperclipApiUrl.replace(/\/+$/, "") + "/api";
  }

  const vars: Record<string, unknown> = {
    agentId: ctx.agent?.id || "",
    agentName,
    companyId: ctx.agent?.companyId || "",
    companyName,
    runId: ctx.runId || "",
    taskId: taskId || "",
    taskTitle,
    taskBody,
    commentId,
    latestCommentBody,
    wakeReason,
    projectName,
    paperclipApiUrl,
    personaContent,
  };

  // Handle conditional sections: {{#key}}...{{/key}} and {{^key}}...{{/key}}
  let rendered = template;

  // {{#personaContent}}...{{/personaContent}} — include if persona loaded
  rendered = rendered.replace(
    /\{\{#personaContent\}\}([\s\S]*?)\{\{\/personaContent\}\}/g,
    personaContent ? "$1" : "",
  );

  // {{#taskId}}...{{/taskId}} — include if task is assigned
  rendered = rendered.replace(
    /\{\{#taskId\}\}([\s\S]*?)\{\{\/taskId\}\}/g,
    taskId ? "$1" : "",
  );

  // {{#noTask}}...{{/noTask}} — include if no task
  rendered = rendered.replace(
    /\{\{#noTask\}\}([\s\S]*?)\{\{\/noTask\}\}/g,
    taskId ? "" : "$1",
  );

  // {{#commentId}}...{{/commentId}} — include if comment exists
  rendered = rendered.replace(
    /\{\{#commentId\}\}([\s\S]*?)\{\{\/commentId\}\}/g,
    commentId ? "$1" : "",
  );

  // {{#latestCommentBody}}...{{/latestCommentBody}} — include if body available
  rendered = rendered.replace(
    /\{\{#latestCommentBody\}\}([\s\S]*?)\{\{\/latestCommentBody\}\}/g,
    latestCommentBody ? "$1" : "",
  );

  // {{^latestCommentBody}}...{{/latestCommentBody}} — include if body NOT available
  rendered = rendered.replace(
    /\{\{\^latestCommentBody\}\}([\s\S]*?)\{\{\/latestCommentBody\}\}/g,
    latestCommentBody ? "" : "$1",
  );

  // Replace remaining {{variable}} placeholders
  return renderTemplate(rendered, vars);
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

/**
 * Regex to extract session ID from Hermes quiet-mode output: "session_id: <id>"
 *
 * Hermes session IDs follow the format: YYYYMMDD_HHMMSS_<hex>
 * Example: 20260612_143022_a3b8f4c
 *
 * This strict format prevents accidentally parsing error messages like
 * "Use a session ID from a previous run" → capturing "from" as the session ID.
 *
 * Fixes #75, #142, #131
 */
const SESSION_ID_REGEX = /^session_id:\s*(\d{8}_\d{6}_[a-f0-9]+)\s*$/m;

/**
 * Shape of a real Hermes session ID (YYYYMMDD_HHMMSS_<hex>).
 * Exported so tests and the isValidSessionId guard can validate stored IDs,
 * allowing an already-poisoned agent to self-heal by starting a fresh session.
 */
const SESSION_ID_SHAPE = /^\d{8}_\d{6}_[0-9a-z]+$/i;
export function isValidSessionId(id: unknown): id is string {
  return typeof id === "string" && SESSION_ID_SHAPE.test(id);
}

/**
 * Sanitize the agent-configured `env` map before it is merged into the child
 * process environment.
 *
 * The Paperclip server is expected to resolve `secret_ref` bindings into plain
 * strings before invoking the adapter (see test.ts). This is a defensive guard
 * for when that has not happened: a bare `Object.assign` of an unresolved
 * `secret_ref` descriptor object would coerce to the literal string
 * "[object Object]" when the child is spawned, silently replacing the
 * credential and breaking any agent (notably delegated sub-agents) whose task
 * depends on that secret. Only string values are kept; anything else is
 * reported as a warning so the problem is visible instead of corrupting the env.
 */
export function sanitizeUserEnv(userEnv: unknown): {
  env: Record<string, string>;
  warnings: string[];
} {
  const env: Record<string, string> = {};
  const warnings: string[] = [];
  if (userEnv && typeof userEnv === "object") {
    for (const [key, value] of Object.entries(userEnv as Record<string, unknown>)) {
      if (typeof value === "string") {
        env[key] = value;
      } else if (
        value !== null &&
        typeof value === "object" &&
        (value as { type?: unknown }).type === "secret_ref"
      ) {
        warnings.push(
          `env var ${key} is an unresolved secret_ref and was skipped (the server is expected to resolve it to a string). Running without it instead of injecting "[object Object]".`,
        );
      } else if (value !== null && value !== undefined) {
        warnings.push(
          `env var ${key} has a non-string value (${typeof value}) and was skipped to avoid coercion to "[object Object]".`,
        );
      }
    }
  }
  return { env, warnings };
}

/** Regex to extract token usage from Hermes output. */
const TOKEN_USAGE_REGEX =
  /tokens?[:\s]+(\d+)\s*(?:input|in)\b.*?(\d+)\s*(?:output|out)\b/i;

/** Regex to extract cost from Hermes output. */
const COST_REGEX = /(?:cost|spent)[:\s]*\$?([\d.]+)/i;

interface ParsedOutput {
  sessionId?: string;
  response?: string;
  usage?: UsageSummary;
  costUsd?: number;
  errorMessage?: string;
}

// ---------------------------------------------------------------------------
// Response cleaning
// ---------------------------------------------------------------------------

/** Strip noise lines from a Hermes response (tool output, system messages, etc.) */
function cleanResponse(raw: string): string {
  return raw
    .split("\n")
    .filter((line) => {
      const t = line.trim();
      if (!t) return true; // keep blank lines for paragraph separation
      if (t.startsWith("[tool]") || t.startsWith("[hermes]") || t.startsWith("[paperclip]")) return false;
      if (t.startsWith("session_id:")) return false;
      if (/^\[\d{4}-\d{2}-\d{2}T/.test(t)) return false;
      if (/^\[done\]\s*┊/.test(t)) return false;
      if (/^┊\s*[\p{Emoji_Presentation}]/u.test(t) && !/^┊\s*💬/.test(t)) return false;
      if (/^\p{Emoji_Presentation}\s*(Completed|Running|Error)?\s*$/u.test(t)) return false;
      return true;
    })
    .map((line) => {
      let t = line.replace(/^[\s]*┊\s*💬\s*/, "").trim();
      t = t.replace(/^\[done\]\s*/, "").trim();
      return t;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------
// Output parsing
// ---------------------------------------------------------------------------

export function parseHermesOutput(stdout: string, stderr: string): ParsedOutput {
  const combined = stdout + "\n" + stderr;
  const result: ParsedOutput = {};

  // In quiet mode, Hermes outputs:
  //   <response text>
  //
  //   session_id: <id>
  const sessionMatch = stdout.match(SESSION_ID_REGEX);
  if (sessionMatch?.[1]) {
    result.sessionId = sessionMatch?.[1] ?? null;
    // The response is everything before the session_id line
    const sessionLineIdx = stdout.lastIndexOf("\nsession_id:");
    if (sessionLineIdx > 0) {
      result.response = cleanResponse(stdout.slice(0, sessionLineIdx));
    }
  } else {
    // Legacy format (non-quiet mode) — only accept structured session IDs in
    // Hermes format (YYYYMMDD_HHMMSS_<hex>) to prevent prose like
    // "session ID from a previous run" from being captured as a session ID.
    const legacyMatch = combined.match(/\n(?:session[_ ](?:id|saved)|Session[_ ]ID)[:\s]+(\d{8}_\d{6}_[a-f0-9]+)/i);
    if (legacyMatch?.[1]) {
      result.sessionId = legacyMatch[1];
    }
    // In non-quiet mode, extract clean response from stdout by
    // filtering out tool lines, system messages, and noise
    const cleaned = cleanResponse(stdout);
    if (cleaned.length > 0) {
      result.response = cleaned;
    }
  }

  // Extract token usage
  const usageMatch = combined.match(TOKEN_USAGE_REGEX);
  if (usageMatch) {
    result.usage = {
      inputTokens: parseInt(usageMatch[1], 10) || 0,
      outputTokens: parseInt(usageMatch[2], 10) || 0,
    };
  }

  // Extract cost
  const costMatch = combined.match(COST_REGEX);
  if (costMatch?.[1]) {
    result.costUsd = parseFloat(costMatch[1]);
  }

  // Check for error patterns in stderr
  if (stderr.trim()) {
    const errorLines = stderr
      .split("\n")
      .filter((line) => /error|exception|traceback|failed/i.test(line))
      .filter((line) => !/INFO|DEBUG|warn/i.test(line)); // skip log-level noise
    if (errorLines.length > 0) {
      result.errorMessage = errorLines.slice(0, 5).join("\n");
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Tool-transcript fallback (#121)
// ---------------------------------------------------------------------------

/**
 * When Hermes produces no final text response (silent completion), construct a
 * minimal summary from the tool-call lines in stdout so the run viewer shows
 * something meaningful instead of an empty transcript entry.
 */
export function buildToolTranscriptFallback(stdout: string): string {
  const lines = stdout.split("\n").filter(Boolean);

  // Collect the last few meaningful non-noise lines for a terse summary
  const toolLines = lines
    .filter((l) => l.includes("[tool]") || /^╊/.test(l)) // ┊ prefix
    .map((l) => l.replace(/^╊\s*/, "").replace(/^\[tool\]\s*/, "").trim())
    .filter(Boolean)
    .slice(-5);

  if (toolLines.length > 0) {
    return `Run completed (tools used):\n${toolLines.join("\n")}`;
  }

  // Check for any non-noise stdout content
  const contentLines = lines.filter(
    (l) =>
      !l.startsWith("[hermes]") &&
      !l.startsWith("[tool]") &&
      !l.startsWith("[paperclip]") &&
      !l.match(/^\[\d{4}-\d{2}-\d{2}/) &&
      !l.startsWith("session_id:"),
  );
  if (contentLines.length > 0) {
    return contentLines.slice(-10).join("\n").trim();
  }

  return "Run completed (no text response produced).";
}

// ---------------------------------------------------------------------------
// Persona file loading (#124)
// ---------------------------------------------------------------------------

/**
 * Load agent persona content from the instructions file path configured by
 * Paperclip (supportsInstructionsBundle). Returns empty string on any error
 * so a missing file never blocks execution.
 */
export async function loadPersonaFile(filePath: string): Promise<string> {
  try {
    const content = await readFile(filePath, "utf8");
    return content.trim();
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Artifact upload (#170)
// ---------------------------------------------------------------------------

/**
 * After Hermes execution, scan for files in the `artifacts/` directory under
 * the working directory and upload each as a Paperclip issue attachment.
 * This lets agents write deliverables (reports, data files, etc.) to a
 * well-known location and have them surfaced in the Paperclip run viewer.
 */
async function uploadArtifacts(
  ctx: AdapterExecutionContext,
  cwd: string,
  paperclipApiUrl: string,
  taskId: string | null,
): Promise<void> {
  if (!taskId || !ctx.authToken) return;

  const artifactDir = path.resolve(cwd, "artifacts");

  let files: import("node:fs").Dirent[];
  try {
    files = await readdir(artifactDir, { withFileTypes: true });
  } catch {
    return; // artifacts/ doesn't exist — nothing to upload
  }

  for (const file of files) {
    if (!file.isFile()) continue;
    const filePath = path.join(artifactDir, file.name);

    let fileBlob: Blob;
    try {
      const buf = await readFile(filePath);
      // Slice to a plain ArrayBuffer so Blob constructor is satisfied regardless
      // of whether Node returns a Buffer backed by SharedArrayBuffer or ArrayBuffer.
      const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
      fileBlob = new Blob([ab]);
    } catch {
      continue;
    }

    try {
      const formData = new FormData();
      formData.append("file", fileBlob, file.name);

      const endpoint = `${paperclipApiUrl}/companies/${ctx.agent.companyId}/issues/${taskId}/attachments`;
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.authToken}`,
          "X-Paperclip-Run-Id": ctx.runId,
        },
        body: formData,
      });

      await response.text(); // drain body to prevent socket leak (#89)

      if (response.ok) {
        await ctx.onLog("stdout", `[hermes] Uploaded artifact: ${file.name}\n`);
      } else {
        await ctx.onLog(
          "stdout",
          `[hermes] WARNING: artifact upload failed for ${file.name} (${response.status})\n`,
        );
      }
    } catch (err) {
      await ctx.onLog(
        "stdout",
        `[hermes] WARNING: artifact upload error for ${file.name}: ${err}\n`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Concurrency guard (#90)
// ---------------------------------------------------------------------------

// Track agents that currently have a Hermes run in flight. A second concurrent
// run for the same agent serializes on Hermes session files and causes Paperclip
// to spawn additional retries, creating a self-reinforcing retry storm that fills
// the 10-min run backlog. Returning early breaks the cycle.
const IN_FLIGHT_AGENTS = new Set<string>();

// ---------------------------------------------------------------------------
// Main execute
// ---------------------------------------------------------------------------

export async function execute(
  ctx: AdapterExecutionContext,
): Promise<AdapterExecutionResult> {
  const config = (ctx.config ?? ctx.agent?.adapterConfig ?? {}) as Record<string, unknown>;

  // ── Resolve configuration ──────────────────────────────────────────────
  const hermesCmd = cfgString(config.hermesCommand) || HERMES_CLI;
  const timeoutSec = cfgNumber(config.timeoutSec) || DEFAULT_TIMEOUT_SEC;
  const graceSec = cfgNumber(config.graceSec) || DEFAULT_GRACE_SEC;
  const maxTurns = cfgNumber(config.maxTurnsPerRun);
  const toolsets = cfgString(config.toolsets) || cfgStringArray(config.enabledToolsets)?.join(",");
  const extraArgs = cfgStringArray(config.extraArgs);
  const persistSession = cfgBoolean(config.persistSession) !== false;
  const worktreeMode = cfgBoolean(config.worktreeMode) === true;
  const checkpoints = cfgBoolean(config.checkpoints) === true;

  // ── Detect Hermes config early ────────────────────────────────────────
  // Read ~/.hermes/config.yaml before resolving model/provider so we can
  // use the Hermes default model as a fallback if no model is specified
  // in adapterConfig. This fixes the issue where DEFAULT_MODEL
  // (anthropic/claude-sonnet-4) would override a user's configured model.
  let detectedConfig: Awaited<ReturnType<typeof detectModel>> | null = null;
  try {
    detectedConfig = await detectModel();
  } catch {
    // Non-fatal — detection failure shouldn't block execution
  }

  // Resolve model: adapterConfig > Hermes config > DEFAULT_MODEL
  const model = cfgString(config.model) || detectedConfig?.model || DEFAULT_MODEL;

  // ── Resolve Paperclip API URL ──────────────────────────────────────────
  // Used for posting usage data back to Paperclip after execution
  let paperclipApiUrl =
    cfgString(config.paperclipApiUrl) ||
    process.env.PAPERCLIP_API_URL ||
    "http://127.0.0.1:3100/api";
  // Ensure /api suffix
  if (!paperclipApiUrl.endsWith("/api")) {
    paperclipApiUrl = paperclipApiUrl.replace(/\/+$/, "") + "/api";
  }

  // ── Resolve provider (defense in depth) ────────────────────────────────
  // Priority chain:
  //   1. Explicit provider in adapterConfig (user override)
  //   2. Provider from ~/.hermes/config.yaml (already detected above)
  //   3. Provider inferred from model name prefix
  //   4. "auto" (let Hermes decide)
  const explicitProvider = cfgString(config.provider);

  const { provider: resolvedProvider, resolvedFrom } = resolveProvider({
    explicitProvider,
    detectedProvider: detectedConfig?.provider,
    detectedModel: detectedConfig?.model,
    model,
  });

  // ── Terminal-status guard (#92) ─────────────────────────────────────────
  // Paperclip can deliver a wake for an issue that is already in a terminal
  // state (deferred wake, late comment, re-delivery). Spawning a Hermes run
  // for a done/cancelled issue wastes budget and can trigger redundant work.
  // The wake context carries the issue status on ctx.context (the heartbeat
  // contextSnapshot); when it is terminal, skip the run with a no-op result.
  const wakeCtx = (ctx.context ?? {}) as {
    issueStatus?: unknown;
    paperclipWake?: { issue?: { status?: unknown } };
  };
  const wakeStatus = (
    cfgString(wakeCtx.paperclipWake?.issue?.status) ||
    cfgString(wakeCtx.issueStatus) ||
    ""
  ).toLowerCase();
  if (wakeStatus === "done" || wakeStatus === "cancelled") {
    await ctx.onLog(
      "stdout",
      `[hermes] Skipping run \u2014 issue already in terminal status "${wakeStatus}" (guard #92)\n`,
    );
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: resolvedProvider,
      model,
      summary: `Skipped: issue already "${wakeStatus}"; no Hermes run spawned (guard #92).`,
      resultJson: { result: "", session_id: null, usage: null, cost_usd: null },
    };
  }


  // ── Concurrency guard (#90) ────────────────────────────────────────────────────────────────
  // Skip if this agent already has a Hermes run in flight. Concurrent runs
  // serialize on Hermes session files, inflating latency and triggering
  // Paperclip to spawn additional retries, forming a self-perpetuating
  // retry storm (#90).
  const agentId = ctx.agent?.id ?? null;
  if (agentId && IN_FLIGHT_AGENTS.has(agentId)) {
    await ctx.onLog(
      "stdout",
      `[hermes] Skipping run — another run is already in progress for this agent (guard #90)\n`,
    );
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      provider: resolvedProvider,
      model,
      summary: "Skipped: another run is already in progress for this agent (guard #90).",
      resultJson: { result: "", session_id: null, usage: null, cost_usd: null },
    };
  }
  if (agentId) IN_FLIGHT_AGENTS.add(agentId);

  // ── Load persona file (#124) ───────────────────────────────────────────
  // Paperclip writes the agent's instructions bundle path into config when
  // supportsInstructionsBundle is true in the ServerAdapterModule.
  const instructionsFilePath = cfgString(config.instructionsFilePath);
  let personaContent = "";
  if (instructionsFilePath) {
    personaContent = await loadPersonaFile(instructionsFilePath);
    if (personaContent) {
      await ctx.onLog("stdout", `[hermes] Loaded persona from ${instructionsFilePath} (${personaContent.length} chars)\n`);
    }
  }

  // ── Build prompt ───────────────────────────────────────────────────────
  const prompt = buildPrompt(ctx, config, personaContent);

  // ── Build command args ─────────────────────────────────────────────────
  // Use -Q (quiet) to get clean output: just response + session_id line
  const useQuiet = cfgBoolean(config.quiet) !== false; // default true
  const args: string[] = ["chat", "-q", prompt];
  if (useQuiet) args.push("-Q");

  if (model) {
    args.push("-m", model);
  }

  // Always pass --provider when we have a resolved one (not "auto").
  // "auto" means Hermes will decide on its own — no need to pass it.
  if (resolvedProvider !== "auto") {
    args.push("--provider", resolvedProvider);
  }

  if (toolsets) {
    args.push("-t", toolsets);
  }

  if (maxTurns && maxTurns > 0) {
    args.push("--max-turns", String(maxTurns));
  }

  if (worktreeMode) args.push("-w");
  if (checkpoints) args.push("--checkpoints");
  if (cfgBoolean(config.verbose) === true) args.push("-v");

  // Tag sessions as "tool" source so they don't clutter the user's session history.
  // Requires hermes-agent >= PR #3255 (feat/session-source-tag).
  args.push("--source", "tool");

  // Bypass Hermes dangerous-command approval prompts.
  // Paperclip agents run as non-interactive subprocesses with no TTY,
  // so approval prompts would always timeout and deny legitimate commands
  // (curl, python3 -c, etc.). Agents operate in a sandbox — the approval
  // system is designed for human-attended interactive sessions.
  args.push("--yolo");

  // Session resume. Only resume from a value that looks like a real session
  // ID — this guards against a previously-persisted bogus value (e.g. "from",
  // captured from error prose) being replayed as `--resume from`, which would
  // fail every retry with "Session not found" and strand the run. A
  // non-conforming stored ID is dropped so the run starts a fresh session.
  const prevSessionId = cfgString(
    (ctx.runtime?.sessionParams as Record<string, unknown> | null)?.sessionId,
  );
  if (persistSession && isValidSessionId(prevSessionId)) {
    args.push("--resume", prevSessionId);
  } else if (persistSession && prevSessionId) {
    await ctx.onLog(
      "stderr",
      `[hermes] WARNING: ignoring malformed stored session id "${prevSessionId}"; starting a fresh session.\n`,
    );
  }

  if (extraArgs?.length) {
    args.push(...extraArgs);
  }

  // ── Build environment ──────────────────────────────────────────────────
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...buildPaperclipEnv(ctx.agent),
  };

  // Paperclip may be launched from an interactive Hermes shell during local
  // development. Do not let those parent-session markers leak into the
  // managed child process; heartbeat agents are non-interactive and should use
  // their own fresh session metadata.
  delete env.HERMES_INTERACTIVE;
  delete env.HERMES_SESSION_ID;
  delete env.HERMES_GATEWAY_SESSION;

  if (ctx.runId) env.PAPERCLIP_RUN_ID = ctx.runId;
  // ctx.authToken is the short-lived agent JWT issued by Paperclip for this run.
  // Always override PAPERCLIP_API_KEY with it so Hermes uses the agent's identity
  // when making API calls — not a server-level key from the parent environment.
  // Without this, Paperclip attributes comments to "local-board" instead of the
  // agent (upstream issues #53 and #93).
  if (ctx.authToken) env.PAPERCLIP_API_KEY = ctx.authToken;
  const taskCtx = (ctx.context ?? {}) as {
    taskId?: unknown;
    issueId?: unknown;
    paperclipWake?: { issue?: { id?: unknown } };
    paperclipIssue?: { id?: unknown };
  };
  const taskId =
    cfgString(taskCtx.taskId) ||
    cfgString(taskCtx.issueId) ||
    cfgString(taskCtx.paperclipWake?.issue?.id) ||
    cfgString(taskCtx.paperclipIssue?.id) ||
    cfgString(ctx.config?.taskId);
  if (taskId) env.PAPERCLIP_TASK_ID = taskId;

  // Inject PAPERCLIP_API_URL so Hermes's curl calls reach the local Paperclip
  // instance. paperclipApiUrl has /api appended — strip it so the env var is
  // the bare base URL that paperclipai CLI and curl workflows expect (closes #117).
  env.PAPERCLIP_API_URL = paperclipApiUrl.replace(/\/api$/, "");
  if (ctx.agent?.id) env.PAPERCLIP_AGENT_ID = ctx.agent.id;
  if (ctx.agent?.companyId) env.PAPERCLIP_COMPANY_ID = ctx.agent.companyId;

  // Inject agent-configured env vars. Only string values are merged; an
  // unresolved secret_ref descriptor (or any non-string) is skipped and
  // surfaced as a warning rather than coerced to "[object Object]" — see
  // sanitizeUserEnv() for the full rationale.
  const { env: userEnv, warnings: envWarnings } = sanitizeUserEnv(config.env);
  Object.assign(env, userEnv);
  for (const warning of envWarnings) {
    await ctx.onLog("stderr", `[hermes] WARNING: ${warning}\n`);
  }

  // ── Resolve working directory ──────────────────────────────────────────
  const cwd =
    cfgString(config.cwd) || cfgString(ctx.config?.workspaceDir) || ".";
  try {
    await ensureAbsoluteDirectory(cwd);
  } catch {
    // Non-fatal
  }

  // ── Log start ──────────────────────────────────────────────────────────
  await ctx.onLog(
    "stdout",
    `[hermes] Starting Hermes Agent (model=${model}, provider=${resolvedProvider} [${resolvedFrom}], timeout=${timeoutSec}s${maxTurns ? `, max_turns=${maxTurns}` : ""})\n`,
  );
  if (prevSessionId) {
    await ctx.onLog(
      "stdout",
      `[hermes] Resuming session: ${prevSessionId}\n`,
    );
  }

  // ── Execute ────────────────────────────────────────────────────────────
  // Hermes writes non-error noise to stderr (MCP init, INFO logs, etc).
  // Paperclip renders all stderr as red/error in the UI.
  // Wrap onLog to reclassify benign stderr lines as stdout.
  let lastHermesEmit = Date.now();
  const wrappedOnLog = async (stream: "stdout" | "stderr", chunk: string) => {
    lastHermesEmit = Date.now();
    if (stream === "stderr") {
      const trimmed = chunk.trimEnd();
      // Benign patterns that should NOT appear as errors:
      // - Structured log lines: [timestamp] INFO/DEBUG/WARN: ...
      // - MCP server registration messages
      // - Python import/site noise
      const isBenign = /^\[?\d{4}[-/]\d{2}[-/]\d{2}T/.test(trimmed) || // structured timestamps
        /^[A-Z]+:\s+(INFO|DEBUG|WARN|WARNING)\b/.test(trimmed) || // log levels
        /Successfully registered all tools/.test(trimmed) ||
        /MCP [Ss]erver/.test(trimmed) ||
        /tool registered successfully/.test(trimmed) ||
        /Application initialized/.test(trimmed) ||
        // MCP ClosedResourceError (#104): MCP SDK throws when the server process exits
        // before the adapter finishes reading — this is expected on Hermes shutdown and
        // should never surface as a red error in the run viewer.
        /ClosedResourceError/.test(trimmed) ||
        /Connection closed/.test(trimmed) ||
        /write EPIPE/.test(trimmed) ||
        /Error: read ECONNRESET/.test(trimmed);
      if (isBenign) {
        return ctx.onLog("stdout", chunk);
      }
    }
    return ctx.onLog(stream, chunk);
  };

  // Keepalive: a long silent synthesis (Hermes composing a final answer with no
  // tool calls) emits no stdout, so nothing is forwarded via onLog and Paperclip's
  // run heartbeat (lastHeartbeatAt) goes stale. Paperclip then spawns a duplicate
  // run that steals the issue's checkout lock, and the original run's write-back
  // fails 409 (sameRunLock) then 401 — surfacing as adapter_failed +
  // stranded_assigned_issue. Emit a benign keepalive line whenever Hermes has been
  // quiet for >25s; any real Hermes output resets the timer (only fills genuine
  // gaps). Cleared when the child settles.
  const keepAlive = setInterval(() => {
    if (Date.now() - lastHermesEmit >= 25_000) {
      lastHermesEmit = Date.now();
      void ctx.onLog("stdout", "[hermes] working…\n");
    }
  }, 10_000);
  let result;
  try {
    result = await runChildProcess(ctx.runId, hermesCmd, args, {
      cwd,
      env,
      timeoutSec,
      graceSec,
      onLog: wrappedOnLog,
      onSpawn: ctx.onSpawn,
    }).finally(() => clearInterval(keepAlive));
  } catch (err) {
    if (agentId) IN_FLIGHT_AGENTS.delete(agentId);
    throw err;
  }

  // ── Parse output ───────────────────────────────────────────────────────
  const parsed = parseHermesOutput(result.stdout || "", result.stderr || "");

  await ctx.onLog(
    "stdout",
    `[hermes] Exit code: ${result.exitCode ?? "null"}, timed out: ${result.timedOut}\n`,
  );
  if (parsed.sessionId) {
    await ctx.onLog("stdout", `[hermes] Session: ${parsed.sessionId}\n`);
  }

  // ── Build result ───────────────────────────────────────────────────────
  const executionResult: AdapterExecutionResult = {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    provider: resolvedProvider,
    model,
  };

  if (parsed.errorMessage) {
    executionResult.errorMessage = parsed.errorMessage;
  }

  if (parsed.usage) {
    executionResult.usage = parsed.usage;
  }

  if (parsed.costUsd !== undefined) {
    executionResult.costUsd = parsed.costUsd;
  }

  // Summary from agent response — fall back to tool transcript if response is empty (#121)
  if (parsed.response) {
    executionResult.summary = parsed.response.slice(0, 2000);
  } else if (result.stdout) {
    const fallback = buildToolTranscriptFallback(result.stdout);
    executionResult.summary = fallback.slice(0, 2000);
    await ctx.onLog("stdout", `[hermes] No text response — using tool-transcript fallback summary\n`);
  }

  // Set resultJson so Paperclip can persist run metadata (used for UI display + auto-comments)
  executionResult.resultJson = {
    result: parsed.response || "",
    session_id: parsed.sessionId || null,
    usage: parsed.usage || null,
    cost_usd: parsed.costUsd ?? null,
  };

  // Store session ID for next run — only persist a well-formed ID so a bad
  // capture can never be saved and replayed on the next `--resume`.
  if (persistSession && isValidSessionId(parsed.sessionId)) {
    executionResult.sessionParams = { sessionId: parsed.sessionId };
    executionResult.sessionDisplayId = parsed.sessionId.slice(0, 16);
  }

  // ── Post usage data back to Paperclip ─────────────────────────────────
  // Write token usage and cost to heartbeat_runs table so Paperclip UI
  // can display token consumption and aggregate costs per agent/company.
  // This fixes #145 — data was extracted but never persisted.
  if ((parsed.usage || parsed.costUsd !== undefined) && ctx.authToken) {
    try {
      const endpoint = `${paperclipApiUrl}/v1/heartbeat-runs/${ctx.runId}`;
      const payload: { usageJson?: unknown; totalCostUsd?: number } = {};

      if (parsed.usage) {
        payload.usageJson = {
          inputTokens: parsed.usage.inputTokens,
          outputTokens: parsed.usage.outputTokens,
        };
      }

      if (parsed.costUsd !== undefined) {
        payload.totalCostUsd = parsed.costUsd;
      }

      // Non-blocking PATCH — don't fail the entire run if this fails
      const response = await fetch(endpoint, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${ctx.authToken}`,
          "X-Paperclip-Run-Id": ctx.runId,
        },
        body: JSON.stringify(payload),
      });

      // Always consume the response body — undici keeps the underlying socket
      // in CLOSE_WAIT until the body is drained, exhausting file descriptors
      // after many heartbeats (#89).
      const bodyText = await response.text();

      if (!response.ok) {
        // Log warning but don't throw — usage reporting is not critical to execution
        console.warn(
          `[hermes-adapter] Failed to post usage data to Paperclip: ${response.status} ${response.statusText}`,
          bodyText.slice(0, 200),
        );
      }
    } catch (error) {
      // Non-fatal — log but continue
      console.warn(`[hermes-adapter] Error posting usage data:`, error);
    }
  }

  // ── Upload artifacts (#170) ────────────────────────────────────────────
  // Scan the `artifacts/` directory in the working directory and upload any
  // files found as Paperclip issue attachments. Non-fatal — a missing
  // artifacts/ is expected in most runs.
  const taskCtxForArtifacts = (ctx.context ?? {}) as {
    taskId?: unknown;
    issueId?: unknown;
    paperclipWake?: { issue?: { id?: unknown } };
    paperclipIssue?: { id?: unknown };
  };
  const artifactTaskId =
    cfgString(taskCtxForArtifacts.taskId) ||
    cfgString(taskCtxForArtifacts.issueId) ||
    cfgString(taskCtxForArtifacts.paperclipWake?.issue?.id) ||
    cfgString(taskCtxForArtifacts.paperclipIssue?.id) ||
    null;
  await uploadArtifacts(ctx, cwd, paperclipApiUrl, artifactTaskId);

  if (agentId) IN_FLIGHT_AGENTS.delete(agentId);
  return executionResult;
}
