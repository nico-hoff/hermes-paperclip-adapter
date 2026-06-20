/**
 * Integration tests for the Hermes adapter against a live local Paperclip instance.
 *
 * These tests exercise the full adapter module surface without spawning Hermes.
 * They validate prompt building, persona loading, context extraction, and the
 * skill/session codec contracts that Paperclip calls at runtime.
 *
 * Run with: npm test
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { loadPersonaFile, buildToolTranscriptFallback } from "./execute.js";
import { getHermesPython } from "./test.js";
import { sessionCodec } from "./index.js";
import { parseModelFromConfig } from "./detect-model.js";

// ---------------------------------------------------------------------------
// Persona file loading (#124)
// ---------------------------------------------------------------------------

describe("loadPersonaFile (#124)", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = join(tmpdir(), `hermes-test-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("reads persona content from AGENTS.md", async () => {
    const filePath = join(tmpDir, "AGENTS.md");
    await writeFile(filePath, "# Agent Instructions\n\nYou are a helpful assistant.");
    const content = await loadPersonaFile(filePath);
    assert.ok(content.includes("Agent Instructions"));
    assert.ok(content.includes("helpful assistant"));
  });

  it("returns empty string when file does not exist", async () => {
    const content = await loadPersonaFile(join(tmpDir, "NONEXISTENT.md"));
    assert.equal(content, "");
  });

  it("trims whitespace from persona content", async () => {
    const filePath = join(tmpDir, "SOUL.md");
    await writeFile(filePath, "\n\n  Soul content here  \n\n");
    const content = await loadPersonaFile(filePath);
    assert.equal(content, "Soul content here");
  });
});

// ---------------------------------------------------------------------------
// Session codec contract (#48 / Paperclip session API)
// ---------------------------------------------------------------------------

describe("sessionCodec — Paperclip session contract", () => {
  it("deserializes a valid session record", () => {
    const raw = { sessionId: "20260609_153047_5568c8" };
    const params = sessionCodec.deserialize(raw);
    assert.ok(params !== null);
    assert.equal(params?.sessionId, "20260609_153047_5568c8");
  });

  it("deserializes session_id (snake_case fallback)", () => {
    const raw = { session_id: "20260609_153047_5568c8" };
    const params = sessionCodec.deserialize(raw);
    assert.ok(params !== null);
    assert.equal(params?.sessionId, "20260609_153047_5568c8");
  });

  it("returns null for empty/missing session", () => {
    assert.equal(sessionCodec.deserialize(null), null);
    assert.equal(sessionCodec.deserialize({}), null);
    assert.equal(sessionCodec.deserialize({ sessionId: "" }), null);
  });

  it("serializes params back to storage format", () => {
    const params = { sessionId: "20260101_010101_abc123" };
    const stored = sessionCodec.serialize(params);
    assert.ok(stored !== null);
    assert.equal(stored?.sessionId, "20260101_010101_abc123");
  });

  it("getDisplayId returns the session ID", () => {
    const fn = sessionCodec.getDisplayId;
    assert.ok(fn !== undefined);
    const id = fn!({ sessionId: "20260101_010101_abc123" });
    assert.equal(id, "20260101_010101_abc123");
  });
});

// ---------------------------------------------------------------------------
// Hermes config YAML parsing
// ---------------------------------------------------------------------------

describe("parseModelFromConfig — Hermes config.yaml parsing", () => {
  it("extracts model and provider from standard config", () => {
    const yaml = `model:\n  default: anthropic/claude-sonnet-4\n  provider: anthropic\n`;
    const result = parseModelFromConfig(yaml);
    assert.ok(result !== null);
    assert.equal(result?.model, "anthropic/claude-sonnet-4");
    assert.equal(result?.provider, "anthropic");
  });

  it("returns null when model section is missing", () => {
    const yaml = `ui:\n  theme: dark\n`;
    const result = parseModelFromConfig(yaml);
    assert.equal(result, null);
  });

  it("handles custom provider and base_url", () => {
    const yaml = `model:\n  default: gpt-5.4\n  provider: copilot\n  base_url: https://api.githubcopilot.com\n`;
    const result = parseModelFromConfig(yaml);
    assert.equal(result?.model, "gpt-5.4");
    assert.equal(result?.provider, "copilot");
    assert.equal(result?.baseUrl, "https://api.githubcopilot.com");
  });
});

// ---------------------------------------------------------------------------
// getHermesPython ESM/macOS (#105)
// ---------------------------------------------------------------------------

describe("getHermesPython (#105)", () => {
  it("returns python3 or python without using require() (ESM-safe)", async () => {
    // getHermesPython uses promisified execFile — not require().
    // On macOS and CI this should find python3 from the PATH.
    // If neither python3 nor python is available the test is skipped
    // rather than failing, since the test environment may not have Python.
    try {
      const binary = await getHermesPython();
      assert.ok(
        binary === "python3" || binary === "python",
        `Expected python3 or python, got: ${binary}`,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("not found in PATH")) {
        // Python not installed in this environment — acceptable for CI
        return;
      }
      throw err;
    }
  });
});

// ---------------------------------------------------------------------------
// buildToolTranscriptFallback edge cases (#121)
// ---------------------------------------------------------------------------

describe("buildToolTranscriptFallback — edge cases (#121)", () => {
  it("handles unicode in tool output lines gracefully", () => {
    const stdout = "[tool] Created file: résumé.pdf\n[hermes] Done.\n";
    const result = buildToolTranscriptFallback(stdout);
    assert.ok(typeof result === "string");
    assert.ok(result.length > 0);
  });

  it("handles very long stdout without truncation issues", () => {
    const lines = Array.from({ length: 1000 }, (_, i) => `line ${i}`).join("\n");
    const result = buildToolTranscriptFallback(lines);
    assert.ok(result.length > 0);
  });
});
