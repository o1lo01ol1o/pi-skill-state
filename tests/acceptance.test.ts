import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { ACCEPTED_PATCH_KIND, type ActiveRuntime } from "../src/core/fold.js";
import { enterMode, inactiveMode, type ModeEnteredV1 } from "../src/core/mode.js";
import { assemblePrompt, type ContextItem, type PromptMessage } from "../src/core/prompt.js";
import { parseStateSchema } from "../src/core/schema.js";
import { acceptPatch, initialState, renderState } from "../src/core/state.js";

test("50-turn bundled warehouse run keeps prompt footprint flat and reaches ground truth", async () => {
  const skillUrl = new URL("../skills/warehouse-audit/SKILL.md", import.meta.url);
  const schemaUrl = new URL("../skills/warehouse-audit/state.schema.json", import.meta.url);
  const [skillBytes, schemaBytes] = await Promise.all([
    readFile(skillUrl, "utf8"),
    readFile(schemaUrl, "utf8"),
  ]);
  const parsedSchema = parseStateSchema(schemaBytes);
  assert.equal(parsedSchema.ok, true);
  if (!parsedSchema.ok) return;
  const skill = parseFrontmatter(skillBytes);
  const entered: ModeEnteredV1 = {
    v: 1,
    kind: "mode-entered",
    runId: "warehouse-run-001",
    skillName: "warehouse-audit",
    schemaHash: parsedSchema.value.hash,
    source: "command",
    enteredAt: 1_700_000_000_000,
    procedure: {
      skillPath: fileURLToPath(skillUrl),
      skillBaseDir: fileURLToPath(new URL("../skills/warehouse-audit/", import.meta.url)),
      schemaPath: fileURLToPath(schemaUrl),
      skillBody: skill.body,
      schemaBytes,
      args: "audit repeating shelves S-1 through S-5 for 50 batches",
    },
    config: { windowTurns: 2, budgetTokens: 4000, constrainedSampling: false },
  };

  const mode = enterMode(inactiveMode, "enter", entered);
  let active: ActiveRuntime = {
    mode,
    schema: parsedSchema.value,
    state: initialState(parsedSchema.value),
    turns: 0,
    patches: 0,
    acceptedPatchCallIds: new Set(),
  };
  const timeline: ContextItem[] = [{ kind: "marker", entryId: "enter" }];
  const promptSizes: number[] = [];

  for (let turn = 1; turn <= 50; turn += 1) {
    const callId = `patch-${turn}`;
    const shelf = `S-${((turn - 1) % 5) + 1}`;
    const operations: Array<{ path: string; action: string; value: string }> = [
      { path: "/shelves_done", action: "union", value: JSON.stringify([shelf]) },
      { path: "/items_counted", action: "sum", value: "1" },
      { path: "/defects_found", action: "append", value: turn === 25
        ? JSON.stringify([{ shelf, issue: "damaged label" }])
        : "[]" },
      { path: "/phase", action: "lww-set", value: JSON.stringify(turn === 50 ? "verify" : "scan") },
      { path: "/notes", action: "lww-set", value: JSON.stringify(turn === 50 ? "done" : "next batch") },
    ];
    if (turn === 1) {
      operations.push({ path: "/baseline_commit", action: "once", value: JSON.stringify("baseline-001") });
    }
    const args = { operations };
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
      acceptedPatchCallIds: new Set([...active.acceptedPatchCallIds, callId]),
    };

    const projected = assemblePrompt(timeline, { mode, active, completed: [] });
    promptSizes.push(JSON.stringify(projected).length);
    assert.ok(projected.length <= 5, `turn ${turn} retained too many messages`);
    assert.equal(JSON.stringify(projected).includes("reasoning turn 1"), false);
  }

  assert.equal(
    renderState(active.state),
    '{"baseline_commit":"baseline-001","defects_found":[{"issue":"damaged label","shelf":"S-5"}],"items_counted":50,"notes":"done","phase":"verify","shelves_done":["S-1","S-2","S-3","S-4","S-5"]}',
  );
  const steadyStateSizes = promptSizes.slice(9);
  assert.ok(
    Math.max(...steadyStateSizes) - Math.min(...steadyStateSizes) < 160,
    `steady-state prompt grew unexpectedly: ${Math.min(...steadyStateSizes)}..${Math.max(...steadyStateSizes)}`,
  );
});
