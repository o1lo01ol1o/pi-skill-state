import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { ACCEPTED_PATCH_KIND, type ActiveRuntime } from "../src/core/fold.js";
import { type ActiveMode } from "../src/core/mode.js";
import { assemblePrompt, type ContextItem, type PromptMessage } from "../src/core/prompt.js";
import { parseStateSchema } from "../src/core/schema.js";
import { acceptPatch, initialState, renderState } from "../src/core/state.js";

test("50-turn warehouse-style run keeps prompt footprint flat and reaches ground truth", async () => {
  const entered = JSON.parse(await readFile(new URL("./fixtures/mode-entered-v1.json", import.meta.url), "utf8"));
  const parsedSchema = parseStateSchema(entered.procedure.schemaBytes);
  assert.equal(parsedSchema.ok, true);
  if (!parsedSchema.ok) return;

  const mode: ActiveMode = { tag: "active", entryId: "enter", entered };
  let active: ActiveRuntime = {
    mode,
    schema: parsedSchema.value,
    state: initialState(parsedSchema.value),
    turns: 0,
    patches: 0,
  };
  const timeline: ContextItem[] = [{ kind: "marker", entryId: "enter" }];
  const promptSizes: number[] = [];

  for (let turn = 1; turn <= 50; turn += 1) {
    const callId = `patch-${turn}`;
    const args = {
      operations: [{ path: "/count", action: "sum", value: "1" }],
    };
    const transition = acceptPatch(
      active.schema,
      active.state,
      args,
      { maxTokens: active.mode.entered.config.budgetTokens },
    );
    assert.equal(transition.ok, true);
    if (!transition.ok) return;

    const assistant: PromptMessage = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: `reasoning turn ${turn} that must not accumulate` },
        { type: "text", text: `prose turn ${turn} that must not accumulate` },
        { type: "toolCall", id: callId, name: "state_patch", arguments: args },
      ],
      timestamp: turn * 2,
    };
    const toolResult: PromptMessage = {
      role: "toolResult",
      toolCallId: callId,
      toolName: "state_patch",
      content: [{ type: "text", text: `accepted ${turn}` }],
      details: {
        v: 1,
        kind: ACCEPTED_PATCH_KIND,
        runId: entered.runId,
        schemaHash: entered.schemaHash,
        estimatedTokens: transition.value.estimatedTokens,
      },
      isError: false,
      timestamp: turn * 2 + 1,
    };
    timeline.push(
      { kind: "message", entryId: `a-${turn}`, message: assistant },
      { kind: "message", entryId: `r-${turn}`, message: toolResult },
    );
    active = {
      ...active,
      state: transition.value.state,
      turns: turn,
      patches: turn,
    };

    const projected = assemblePrompt(timeline, { mode, active, completed: [] });
    promptSizes.push(JSON.stringify(projected).length);
    assert.ok(projected.length <= 6, `turn ${turn} retained too many messages`);
    assert.equal(JSON.stringify(projected).includes("reasoning turn 1"), false);
  }

  assert.equal(renderState(active.state), '{"count":50}');
  const steadyStateSizes = promptSizes.slice(9);
  assert.ok(
    Math.max(...steadyStateSizes) - Math.min(...steadyStateSizes) < 100,
    `steady-state prompt grew unexpectedly: ${Math.min(...steadyStateSizes)}..${Math.max(...steadyStateSizes)}`,
  );
});
