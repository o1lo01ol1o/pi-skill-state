import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ACCEPTED_PATCH_KIND, MODE_ENTRY_TYPE, reconstructBranch } from "../src/core/fold.js";
import { renderState } from "../src/core/state.js";

async function fixtures() {
  const entered = JSON.parse(await readFile(new URL("./fixtures/mode-entered-v1.json", import.meta.url), "utf8"));
  const exited = JSON.parse(await readFile(new URL("./fixtures/mode-exited-v1.json", import.meta.url), "utf8"));
  return { entered, exited };
}

function custom(id: string, data: unknown) {
  return { type: "custom", id, parentId: null, timestamp: "2023-01-01T00:00:00Z", customType: MODE_ENTRY_TYPE, data };
}

function sumPatch(count: number) {
  return { operations: [{ path: "/count", action: "sum", value: JSON.stringify(count) }] };
}

function assistant(id: string, callId: string, args: unknown) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2023-01-01T00:00:01Z",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: callId, name: "state_patch", arguments: args }],
      timestamp: 1,
    },
  };
}

function result(id: string, callId: string, runId: string, schemaHash: string, estimatedTokens: number, isError = false) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2023-01-01T00:00:02Z",
    message: {
      role: "toolResult",
      toolCallId: callId,
      toolName: "state_patch",
      content: [{ type: "text", text: isError ? "rejected" : "accepted" }],
      details: isError
        ? { rejected: true }
        : { v: 1, kind: ACCEPTED_PATCH_KIND, runId, schemaHash, estimatedTokens },
      isError,
      timestamp: 2,
    },
  };
}

test("fold reconstructs accepted patches deterministically and completes a matching episode", async () => {
  const { entered, exited } = await fixtures();
  const branch = [
    custom("enter", entered),
    assistant("assistant", "call-1", sumPatch(2)),
    result("result", "call-1", entered.runId, entered.schemaHash, 3),
  ];

  const active = reconstructBranch(branch);
  assert.equal(active.ok, true);
  if (!active.ok || !active.value.active) return;
  assert.equal(renderState(active.value.active.state), '{"count":2}');
  assert.equal(active.value.active.patches, 1);
  assert.equal(active.value.active.turns, 1);

  const replay = reconstructBranch(branch);
  assert.equal(replay.ok, true);
  if (replay.ok && replay.value.active) {
    assert.equal(renderState(replay.value.active.state), renderState(active.value.active.state));
  }

  const completed = reconstructBranch([...branch, custom("exit", exited)]);
  assert.equal(completed.ok, true);
  if (completed.ok) {
    assert.equal(completed.value.mode.tag, "inactive");
    assert.equal(completed.value.completed.length, 1);
    assert.equal(completed.value.completed[0]!.enteredEntryId, "enter");
    assert.equal(completed.value.completed[0]!.exitedEntryId, "exit");
  }
});

test("failed state_patch results are excluded from replay", async () => {
  const { entered } = await fixtures();
  const folded = reconstructBranch([
    custom("enter", entered),
    assistant("assistant", "call-1", sumPatch(999)),
    result("result", "call-1", entered.runId, entered.schemaHash, 3, true),
  ]);
  assert.equal(folded.ok, true);
  if (folded.ok && folded.value.active) {
    assert.equal(renderState(folded.value.active.state), '{"count":0}');
    assert.equal(folded.value.active.patches, 0);
  }
});

test("branch prefixes reconstruct their own state", async () => {
  const { entered } = await fixtures();
  const common = [custom("enter", entered)];
  const left = reconstructBranch([
    ...common,
    assistant("left-a", "left-call", sumPatch(1)),
    result("left-r", "left-call", entered.runId, entered.schemaHash, 3),
  ]);
  const right = reconstructBranch([
    ...common,
    assistant("right-a", "right-call", sumPatch(7)),
    result("right-r", "right-call", entered.runId, entered.schemaHash, 3),
  ]);
  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  if (left.ok && right.ok && left.value.active && right.value.active) {
    assert.equal(renderState(left.value.active.state), '{"count":1}');
    assert.equal(renderState(right.value.active.state), '{"count":7}');
  }
});

test("replay rejects a persisted run whose initial defaults exceed its frozen budget", async () => {
  const { entered } = await fixtures();
  const folded = reconstructBranch([
    custom("enter", { ...entered, config: { ...entered.config, budgetTokens: 1 } }),
  ]);
  assert.equal(folded.ok, false);
  if (!folded.ok) {
    assert.ok(folded.errors.some((error) => error.kind === "patch" && error.code === "state-budget"));
  }
});

test("replay rejects noncanonical denormalized final state text", async () => {
  const { entered, exited } = await fixtures();
  const folded = reconstructBranch([
    custom("enter", entered),
    assistant("assistant", "call-1", sumPatch(2)),
    result("result", "call-1", entered.runId, entered.schemaHash, 3),
    custom("exit", { ...exited, finalState: '{ "count": 2 }' }),
  ]);
  assert.equal(folded.ok, false);
  if (!folded.ok) {
    assert.ok(folded.errors.some((error) => error.kind === "entry" && error.path === "/finalState"));
  }
});

test("schema hash mismatches and orphan accepted results fail loudly", async () => {
  const { entered } = await fixtures();
  const mismatch = reconstructBranch([custom("enter", { ...entered, schemaHash: "wrong" })]);
  assert.equal(mismatch.ok, false);

  const orphan = reconstructBranch([
    custom("enter", entered),
    result("orphan", "missing-call", entered.runId, entered.schemaHash, 3),
  ]);
  assert.equal(orphan.ok, false);
});
