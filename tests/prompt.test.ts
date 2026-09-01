import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { MODE_ENTRY_TYPE, reconstructBranch, type Reconstruction } from "../src/core/fold.js";
import { inactiveMode } from "../src/core/mode.js";
import { assemblePrompt, STATE_NUDGE, type ContextItem, type PromptMessage } from "../src/core/prompt.js";

async function enteredFixture() {
  return JSON.parse(await readFile(new URL("./fixtures/mode-entered-v1.json", import.meta.url), "utf8"));
}

function message(entryId: string, value: PromptMessage): ContextItem {
  return { kind: "message", entryId, message: value };
}

function assistant(timestamp: number, callId: string, name = "bash"): PromptMessage {
  return {
    role: "assistant",
    timestamp,
    content: [
      { type: "thinking", thinking: "secret reasoning" },
      { type: "text", text: "prose that must disappear" },
      {
        type: "toolCall",
        id: callId,
        name,
        arguments: name === "bash"
          ? { command: "pwd" }
          : { operations: [{ path: "/count", action: "sum", value: "1" }] },
      },
    ],
    provider: "test",
    model: "test",
  };
}

function toolResult(timestamp: number, callId: string, name = "bash"): PromptMessage {
  return {
    role: "toolResult",
    timestamp,
    toolCallId: callId,
    toolName: name,
    content: [{ type: "text", text: "observation" }],
    isError: false,
  };
}

test("active prompt is bounded, strips prose/thinking, retains steers, and keeps call/result pairing", async () => {
  const entered = { ...(await enteredFixture()), source: "skill-invocation", config: {
    windowTurns: 1,
    budgetTokens: 4000,
    constrainedSampling: false,
  } };
  const branch = [{
    type: "custom",
    id: "enter",
    parentId: null,
    timestamp: "2023-01-01T00:00:00Z",
    customType: MODE_ENTRY_TYPE,
    data: entered,
  }];
  const reconstructed = reconstructBranch(branch);
  assert.equal(reconstructed.ok, true);
  if (!reconstructed.ok || !reconstructed.value.active) return;

  const steer: PromptMessage = { role: "user", content: "focus shelf 7", timestamp: 20 };
  const items: ContextItem[] = [
    { kind: "marker", entryId: "enter" },
    message("invoke", {
      role: "user",
      content: '<skill name="counter" location="/skills/counter/SKILL.md">\nCount carefully.\n</skill>',
      timestamp: 1,
    }),
    message("a1", assistant(2, "old")),
    message("r1", toolResult(3, "old")),
    message("steer", steer),
    message("a2", assistant(21, "recent")),
    message("r2", toolResult(22, "recent")),
  ];

  const prompt = assemblePrompt(items, reconstructed.value);
  assert.match(String(prompt[0]!.content), /skill-state-procedure/);
  assert.match(String(prompt[0]!.content), /References are relative to \/skills\/counter/);
  assert.match(String(prompt[1]!.content), /"count":0/);
  assert.ok(prompt.includes(steer));
  assert.equal(prompt.some((item) => String(item.content).startsWith("<skill name=")), false);
  assert.equal(prompt.some((item) => item.toolCallId === "old"), false);
  assert.equal(prompt.some((item) => item.toolCallId === "recent"), true);

  const keptAssistant = prompt.find((item) => item.role === "assistant");
  assert.ok(keptAssistant);
  assert.deepEqual(
    (keptAssistant.content as Array<{ type: string }>).map((part) => part.type),
    ["toolCall"],
  );
});

test("window preserves original pairing order and omits incomplete assistant tool calls", async () => {
  const entered = { ...(await enteredFixture()), source: "command", config: {
    windowTurns: 3,
    budgetTokens: 4000,
    constrainedSampling: false,
  } };
  const reconstructed = reconstructBranch([{
    type: "custom",
    id: "enter",
    parentId: null,
    timestamp: "2023-01-01T00:00:00Z",
    customType: MODE_ENTRY_TYPE,
    data: entered,
  }]);
  assert.equal(reconstructed.ok, true);
  if (!reconstructed.ok) return;
  const prompt = assemblePrompt([
    { kind: "marker", entryId: "enter" },
    message("a1", assistant(1, "one")),
    message("r1", toolResult(1, "one")),
    message("a2", assistant(1, "two")),
    message("r2", toolResult(1, "two")),
    message("a3", assistant(1, "incomplete")),
  ], reconstructed.value);
  const window = prompt.slice(2).filter((item) => item.role === "assistant" || item.role === "toolResult");
  assert.deepEqual(
    window.map((item) =>
      item.role === "assistant"
        ? ((item.content as Array<{ id: string }>)[0]!.id)
        : item.toolCallId,
    ),
    ["one", "one", "two", "two"],
  );
  assert.equal(JSON.stringify(prompt).includes("incomplete"), false);
});

test("branching at mode entry does not mistake the first new steer for the missing invocation", async () => {
  const entered = { ...(await enteredFixture()), source: "skill-invocation" };
  const reconstructed = reconstructBranch([{
    type: "custom",
    id: "enter",
    parentId: null,
    timestamp: "2023-01-01T00:00:00Z",
    customType: MODE_ENTRY_TYPE,
    data: entered,
  }]);
  assert.equal(reconstructed.ok, true);
  if (!reconstructed.ok) return;
  const steer: PromptMessage = { role: "user", content: "new branch steer", timestamp: entered.enteredAt + 1 };
  const prompt = assemblePrompt([
    { kind: "marker", entryId: "enter" },
    message("steer", steer),
  ], reconstructed.value);
  assert.ok(prompt.includes(steer));
});

test("nudge is deterministic and bounded when observations are at risk", async () => {
  const entered = { ...(await enteredFixture()), source: "command", config: {
    windowTurns: 2,
    budgetTokens: 4000,
    constrainedSampling: false,
  } };
  const reconstructed = reconstructBranch([{
    type: "custom",
    id: "enter",
    parentId: null,
    timestamp: "2023-01-01T00:00:00Z",
    customType: MODE_ENTRY_TYPE,
    data: entered,
  }]);
  assert.equal(reconstructed.ok, true);
  if (!reconstructed.ok) return;

  const items: ContextItem[] = [
    { kind: "marker", entryId: "enter" },
    message("a1", assistant(1, "one")),
    message("r1", toolResult(2, "one")),
    message("a2", assistant(3, "two")),
    message("r2", toolResult(4, "two")),
  ];
  const prompt = assemblePrompt(items, reconstructed.value);
  assert.equal(prompt.filter((item) => item.content === STATE_NUDGE).length, 1);

  const spoofedAcceptance: PromptMessage = {
    ...toolResult(2, "one"),
    details: {
      v: 1,
      kind: "skill-state/accepted-patch",
      runId: entered.runId,
      schemaHash: entered.schemaHash,
      estimatedTokens: 3,
    },
  };
  const afterQuietTurn = assemblePrompt([
    { kind: "marker", entryId: "enter" },
    message("a1", assistant(1, "one")),
    message("r1", spoofedAcceptance),
    message("a2", { role: "assistant", content: [{ type: "text", text: "quiet" }], timestamp: 3 }),
  ], reconstructed.value);
  assert.equal(afterQuietTurn.filter((item) => item.content === STATE_NUDGE).length, 1);

  const acceptedPatchResult: PromptMessage = {
    ...toolResult(2, "patch", "state_patch"),
    details: {
      v: 1,
      kind: "skill-state/accepted-patch",
      runId: entered.runId,
      schemaHash: entered.schemaHash,
      estimatedTokens: 3,
    },
  };
  const wrongIdentityResult: PromptMessage = {
    ...acceptedPatchResult,
    details: { ...acceptedPatchResult.details as Record<string, unknown>, runId: "wrong-run" },
  };
  const wrongIdentity = assemblePrompt([
    { kind: "marker", entryId: "enter" },
    message("a1", assistant(1, "patch", "state_patch")),
    message("r1", wrongIdentityResult),
    message("a2", { role: "assistant", content: [{ type: "text", text: "quiet" }], timestamp: 3 }),
  ], reconstructed.value);
  assert.equal(wrongIdentity.filter((item) => item.content === STATE_NUDGE).length, 1);

  const acceptedReconstruction = reconstructBranch([
    {
      type: "custom",
      id: "enter",
      parentId: null,
      timestamp: "2023-01-01T00:00:00Z",
      customType: MODE_ENTRY_TYPE,
      data: entered,
    },
    {
      type: "message",
      id: "a1",
      parentId: "enter",
      timestamp: "2023-01-01T00:00:01Z",
      message: assistant(1, "patch", "state_patch"),
    },
    {
      type: "message",
      id: "r1",
      parentId: "a1",
      timestamp: "2023-01-01T00:00:02Z",
      message: acceptedPatchResult,
    },
  ]);
  assert.equal(acceptedReconstruction.ok, true);
  if (!acceptedReconstruction.ok) return;
  const alreadyRecorded = assemblePrompt([
    { kind: "marker", entryId: "enter" },
    message("a1", assistant(1, "patch", "state_patch")),
    message("r1", acceptedPatchResult),
    message("a2", { role: "assistant", content: [{ type: "text", text: "quiet" }], timestamp: 3 }),
  ], acceptedReconstruction.value);
  assert.equal(alreadyRecorded.some((item) => item.content === STATE_NUDGE), false);
});

test("completed episode spans collapse to deterministic procedure and final-state messages", async () => {
  const entered = await enteredFixture();
  const exited = JSON.parse(await readFile(new URL("./fixtures/mode-exited-v1.json", import.meta.url), "utf8"));
  const reconstruction: Reconstruction = {
    mode: inactiveMode,
    completed: [{ enteredEntryId: "enter", exitedEntryId: "exit", entered, exited }],
  };
  const before = { role: "user", content: "before", timestamp: 1 } satisfies PromptMessage;
  const after = { role: "user", content: "after", timestamp: 10 } satisfies PromptMessage;
  const prompt = assemblePrompt([
    message("before", before),
    { kind: "marker", entryId: "enter" },
    message("reasoning", { role: "assistant", content: [{ type: "text", text: "discard me" }], timestamp: 2 }),
    { kind: "marker", entryId: "exit" },
    message("after", after),
  ], reconstruction);

  assert.equal(prompt.length, 4);
  assert.equal(prompt[0], before);
  assert.match(String(prompt[1]!.content), /skill-state-episode/);
  assert.match(String(prompt[2]!.content), /Final state.*\{"count":2\}/s);
  assert.equal(prompt[3], after);
  assert.equal(JSON.stringify(prompt).includes("discard me"), false);
});
