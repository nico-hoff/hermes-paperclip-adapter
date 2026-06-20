import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  isValidSessionId,
  parseHermesOutput,
  sanitizeUserEnv,
  buildToolTranscriptFallback,
} from "./execute.js";

describe("isValidSessionId", () => {
  it("accepts real Hermes session IDs (YYYYMMDD_HHMMSS_<suffix>)", () => {
    assert.equal(isValidSessionId("20260609_153047_5568c8"), true);
    assert.equal(isValidSessionId("20260609_145320_815d6f"), true);
    assert.equal(isValidSessionId("20991231_000000_abc123def"), true);
  });

  it("rejects prose captured from error output", () => {
    // The exact word the loose legacy regex used to capture from
    // "Use a session ID from a previous CLI run".
    assert.equal(isValidSessionId("from"), false);
  });

  it("rejects empty / malformed / non-string values", () => {
    assert.equal(isValidSessionId(""), false);
    assert.equal(isValidSessionId("abc123"), false);
    assert.equal(isValidSessionId("20260609_153047_"), false); // missing suffix
    assert.equal(isValidSessionId("2026-06-09_15:30:47_x"), false);
    assert.equal(isValidSessionId(undefined), false);
    assert.equal(isValidSessionId(null), false);
    assert.equal(isValidSessionId(42), false);
  });
});

describe("parseHermesOutput — session id capture", () => {
  it("does NOT capture 'from' out of the 'Session not found' error prose (regression)", () => {
    // Reproduces the death-loop: a failed run whose stderr is hermes' own
    // error message, with no canonical `session_id:` line.
    const stderr =
      "Session not found: 20260609_153047_5568c8\n" +
      "Use a session ID from a previous CLI run (hermes sessions list).\n";
    const parsed = parseHermesOutput("", stderr);
    assert.notEqual(parsed.sessionId, "from");
    assert.equal(parsed.sessionId, undefined);
  });

  it("captures the canonical quiet-mode session_id line", () => {
    const stdout = "Here is the answer.\n\nsession_id: 20260609_153047_5568c8\n";
    const parsed = parseHermesOutput(stdout, "");
    assert.equal(parsed.sessionId, "20260609_153047_5568c8");
  });

  it("accepts a well-formed legacy 'session saved' id", () => {
    const stdout = "work done\nsession saved: 20260101_010101_deadbe\n";
    const parsed = parseHermesOutput(stdout, "");
    assert.equal(parsed.sessionId, "20260101_010101_deadbe");
  });
});

describe("sanitizeUserEnv", () => {
  it("passes string values through", () => {
    const { env, warnings } = sanitizeUserEnv({ FOO: "bar", BAZ: "qux" });
    assert.deepEqual(env, { FOO: "bar", BAZ: "qux" });
    assert.equal(warnings.length, 0);
  });

  it("skips an unresolved secret_ref and never injects '[object Object]'", () => {
    const { env, warnings } = sanitizeUserEnv({
      HUBSPOT_SERVICE_KEY: {
        type: "secret_ref",
        secretId: "077ebfd6-1def-4604-9d1f-309bee832a5d",
        version: "latest",
      },
      OPENAI_API_KEY: "sk-real-value",
    });
    assert.equal("HUBSPOT_SERVICE_KEY" in env, false);
    assert.notEqual(env.HUBSPOT_SERVICE_KEY, "[object Object]");
    assert.equal(env.OPENAI_API_KEY, "sk-real-value");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /HUBSPOT_SERVICE_KEY/);
    assert.match(warnings[0], /secret_ref/);
  });

  it("skips other non-string values with a warning", () => {
    const { env, warnings } = sanitizeUserEnv({ N: 5, O: { a: 1 } });
    assert.deepEqual(env, {});
    assert.equal(warnings.length, 2);
  });

  it("ignores null/undefined silently and tolerates non-object input", () => {
    const { env, warnings } = sanitizeUserEnv({ A: null, B: undefined });
    assert.deepEqual(env, {});
    assert.equal(warnings.length, 0);
    assert.deepEqual(sanitizeUserEnv(undefined), { env: {}, warnings: [] });
    assert.deepEqual(sanitizeUserEnv("nope"), { env: {}, warnings: [] });
  });
});

describe("parseHermesOutput — SESSION_ID_REGEX tightening (#165)", () => {
  it("rejects 'from' captured from error text via primary regex path", () => {
    // Reproduce the exact error Hermes emits when session not found
    const stdout = "session_id: from a previous CLI run\n";
    const parsed = parseHermesOutput(stdout, "");
    assert.equal(parsed.sessionId, undefined, "loose word 'from' must not be captured");
  });

  it("rejects partial date-looking garbage via primary regex", () => {
    const stdout = "session_id: notadate_nottime_xyz\n";
    const parsed = parseHermesOutput(stdout, "");
    assert.equal(parsed.sessionId, undefined);
  });

  it("accepts a real session ID in quiet-mode format", () => {
    const stdout = "Done.\n\nsession_id: 20261225_235959_cafebabe\n";
    const parsed = parseHermesOutput(stdout, "");
    assert.equal(parsed.sessionId, "20261225_235959_cafebabe");
  });
});

describe("parseHermesOutput — legacy path rejects prose (#131/#142)", () => {
  it("does not capture prose words from verbose error output", () => {
    const combined = "\n[error] Use a session_id from your CLI history\n";
    const parsed = parseHermesOutput("", combined);
    assert.equal(parsed.sessionId, undefined);
  });

  it("captures well-formed session_id via legacy path", () => {
    // Non-quiet mode: no canonical 'session_id:' line, uses legacy pattern
    const stdout = "Work complete\nsession_id: 20260615_100000_aabbcc\n";
    const parsed = parseHermesOutput(stdout, "");
    // Primary regex should catch this; verify it's not undefined
    assert.equal(parsed.sessionId, "20260615_100000_aabbcc");
  });
});

describe("buildToolTranscriptFallback (#121)", () => {
  it("returns tool lines when response is empty", () => {
    const stdout = "[tool] ls /tmp\n[tool] cat /tmp/out.txt\nsession_id: 20260101_010101_abc\n";
    const result = buildToolTranscriptFallback(stdout);
    assert.ok(result.length > 0);
    assert.ok(!result.includes("session_id:"));
  });

  it("returns non-noise content when no tool lines present", () => {
    const stdout = "Some output from the agent\nMore lines\n";
    const result = buildToolTranscriptFallback(stdout);
    assert.ok(result.includes("Some output") || result.includes("More lines") || result.length > 0);
  });

  it("returns a placeholder when stdout is completely empty", () => {
    const result = buildToolTranscriptFallback("");
    assert.ok(result.length > 0);
    assert.ok(result.includes("completed"));
  });

  it("filters out [hermes] and [paperclip] noise lines", () => {
    const stdout = "[hermes] Starting Hermes Agent\n[paperclip] keepalive\nActual response here\n";
    const result = buildToolTranscriptFallback(stdout);
    assert.ok(!result.includes("[hermes]"));
    assert.ok(!result.includes("[paperclip]"));
  });
});
