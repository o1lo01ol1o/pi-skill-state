import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { ACCEPTED_PATCH_KIND, MODE_ENTRY_TYPE } from "../src/core/fold.js";

test("live evidence checker requires and verifies exact final ground truth", async () => {
  const entered = JSON.parse(await readFile(new URL("./fixtures/mode-entered-v1.json", import.meta.url), "utf8"));
  const exited = JSON.parse(await readFile(new URL("./fixtures/mode-exited-v1.json", import.meta.url), "utf8"));
  const patchArgs = { operations: [{ path: "/count", action: "sum", value: "2" }] };
  const entries = [
    { type: "custom", id: "enter", customType: MODE_ENTRY_TYPE, data: entered },
    {
      type: "message",
      id: "patch-call",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "patch-1", name: "state_patch", arguments: patchArgs }],
        timestamp: 1,
      },
    },
    {
      type: "message",
      id: "patch-result",
      message: {
        role: "toolResult",
        toolCallId: "patch-1",
        toolName: "state_patch",
        isError: false,
        content: [{ type: "text", text: "accepted" }],
        details: {
          v: 1,
          kind: ACCEPTED_PATCH_KIND,
          runId: entered.runId,
          schemaHash: entered.schemaHash,
          estimatedTokens: 3,
        },
        timestamp: 2,
      },
    },
    {
      type: "message",
      id: "complete-call",
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "complete-1", name: "skill_complete", arguments: { result: "counted 2 items" } }],
        timestamp: 3,
      },
    },
    {
      type: "message",
      id: "complete-result",
      message: {
        role: "toolResult",
        toolCallId: "complete-1",
        toolName: "skill_complete",
        isError: false,
        content: [{ type: "text", text: "completed" }],
        details: { v: 1, kind: "skill-state/completion", runId: entered.runId },
        timestamp: 4,
      },
    },
    { type: "custom", id: "exit", customType: MODE_ENTRY_TYPE, data: exited },
  ];

  const directory = await mkdtemp(join(tmpdir(), "pi-skill-state-live-check-"));
  try {
    const session = join(directory, "session.jsonl");
    await writeFile(session, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    const project = fileURLToPath(new URL("..", import.meta.url));
    const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
    const script = "scripts/verify-live-session.mjs";
    const run = (...args: string[]) => spawnSync(tsx, [script, session, ...args], {
      cwd: project,
      encoding: "utf8",
    });

    assert.equal(run("false", '{"count":2}').status, 0);
    const omitted = run("false");
    assert.notEqual(omitted.status, 0);
    assert.match(omitted.stderr, /expected-final-json/);
    const wrong = run("false", '{"count":999}');
    assert.notEqual(wrong.status, 0);
    assert.match(wrong.stderr, /final state mismatch/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
