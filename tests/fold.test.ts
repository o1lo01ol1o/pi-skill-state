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

function assistantBatch(id: string, calls: readonly Readonly<{ id: string; args: unknown }>[]) {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2023-01-01T00:00:01Z",
    message: {
      role: "assistant",
      content: calls.map((call) => ({ type: "toolCall", id: call.id, name: "state_patch", arguments: call.args })),
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

test("replay rejects out-of-order and duplicate state_patch results", async () => {
  const { entered } = await fixtures();
  const reversed = reconstructBranch([
    custom("enter", entered),
    assistantBatch("assistant", [
      { id: "call-1", args: sumPatch(1) },
      { id: "call-2", args: sumPatch(2) },
    ]),
    result("result-2", "call-2", entered.runId, entered.schemaHash, 3),
    result("result-1", "call-1", entered.runId, entered.schemaHash, 3),
  ]);
  assert.equal(reversed.ok, false);
  if (!reversed.ok) {
    assert.ok(reversed.errors.some((error) => error.kind === "entry" && error.path === "/message/toolCallId"));
  }

  const duplicate = reconstructBranch([
    custom("enter", entered),
    assistant("assistant", "call-1", sumPatch(1)),
    result("failed", "call-1", entered.runId, entered.schemaHash, 3, true),
    result("duplicate", "call-1", entered.runId, entered.schemaHash, 3),
  ]);
  assert.equal(duplicate.ok, false);

  const reusedCallId = reconstructBranch([
    custom("enter", entered),
    assistant("assistant-1", "call-1", sumPatch(1)),
    result("result-1", "call-1", entered.runId, entered.schemaHash, 3),
    assistant("assistant-2", "call-1", sumPatch(1)),
    result("result-2", "call-1", entered.runId, entered.schemaHash, 3),
  ]);
  assert.equal(reusedCallId.ok, false);
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

test("never-resolved proposals from aborted turns expire instead of blocking replay", async () => {
  const { entered } = await fixtures();
  const user = (id: string, timestamp: number) => ({
    type: "message",
    id,
    parentId: null,
    timestamp: "2023-01-01T00:00:03Z",
    message: { role: "user", content: "continue", timestamp },
  });

  const abortedBatch = reconstructBranch([
    custom("enter", entered),
    assistantBatch("assistant-1", [
      { id: "call-1", args: sumPatch(5) },
      { id: "call-2", args: sumPatch(7) },
    ]),
    result("result-1", "call-1", entered.runId, entered.schemaHash, 3, true),
    user("steer", 3),
    assistant("assistant-2", "call-3", sumPatch(2)),
    result("result-3", "call-3", entered.runId, entered.schemaHash, 3),
  ]);
  assert.equal(abortedBatch.ok, true, abortedBatch.ok ? undefined : JSON.stringify(abortedBatch.errors));
  if (abortedBatch.ok && abortedBatch.value.active) {
    assert.equal(renderState(abortedBatch.value.active.state), '{"count":2}');
    assert.equal(abortedBatch.value.active.patches, 1);
  }

  const danglingAcrossTurn = reconstructBranch([
    custom("enter", entered),
    assistant("assistant-1", "call-1", sumPatch(5)),
    assistant("assistant-2", "call-2", sumPatch(2)),
    result("result-2", "call-2", entered.runId, entered.schemaHash, 3),
  ]);
  assert.equal(danglingAcrossTurn.ok, true);
  if (danglingAcrossTurn.ok && danglingAcrossTurn.value.active) {
    assert.equal(renderState(danglingAcrossTurn.value.active.state), '{"count":2}');
  }
});

test("mode exit expires dangling proposals and still cross-checks final state", async () => {
  const { entered, exited } = await fixtures();
  const stopAfterAbort = reconstructBranch([
    custom("enter", entered),
    assistant("assistant", "call-1", sumPatch(5)),
    custom("exit", { ...exited, finalState: '{"count":0}' }),
  ]);
  assert.equal(stopAfterAbort.ok, true, stopAfterAbort.ok ? undefined : JSON.stringify(stopAfterAbort.errors));
  if (stopAfterAbort.ok) {
    assert.equal(stopAfterAbort.value.mode.tag, "inactive");
    assert.equal(stopAfterAbort.value.completed.length, 1);
  }

  const wrongFinal = reconstructBranch([
    custom("enter", entered),
    assistant("assistant", "call-1", sumPatch(5)),
    custom("exit", { ...exited, finalState: '{"count":5}' }),
  ]);
  assert.equal(wrongFinal.ok, false, "an expired proposal must not count toward final state");
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
