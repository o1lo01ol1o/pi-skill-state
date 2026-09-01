import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import skillStateExtension from "../src/index.js";
import { MODE_ENTRY_TYPE } from "../src/core/fold.js";

type Handler = (event: any, context: any) => unknown;

test("shell runs an auto-armed episode end to end and delays exit until turn_end", async () => {
  const handlers = new Map<string, Handler[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const flags = new Map<string, boolean | string>();
  const entries: any[] = [];
  const notifications: Array<{ text: string; level?: string }> = [];
  const statuses = new Map<string, string | undefined>();
  let activeTools = ["read", "bash"];
  let idle = true;
  let id = 0;
  let capturedCompactionPrompt = "";

  const append = (entry: any) => {
    entries.push({
      ...entry,
      id: entry.id ?? `e${++id}`,
      parentId: entries.at(-1)?.id ?? null,
      timestamp: entry.timestamp ?? new Date(1700000000000 + id).toISOString(),
    });
  };

  const pi = {
    on(name: string, handler: Handler) {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerFlag(name: string, options: { default?: boolean | string }) {
      if (options.default !== undefined) flags.set(name, options.default);
    },
    getFlag(name: string) {
      return flags.get(name);
    },
    registerTool(definition: any) {
      tools.set(definition.name, definition);
    },
    registerCommand(name: string, options: any) {
      commands.set(name, options);
    },
    registerEntryRenderer() {},
    getCommands() {
      return [{
        name: "skill:warehouse-audit",
        description: "test",
        source: "skill",
        sourceInfo: {
          path: fileURLToPath(new URL("../skills/warehouse-audit/SKILL.md", import.meta.url)),
          source: "test",
          scope: "project",
          origin: "top-level",
        },
      }];
    },
    appendEntry(customType: string, data: unknown) {
      append({ type: "custom", customType, data });
    },
    getActiveTools() {
      return [...activeTools];
    },
    setActiveTools(names: string[]) {
      activeTools = [...names];
    },
  } as unknown as ExtensionAPI;

  skillStateExtension(pi);

  const context: any = {
    mode: "tui",
    hasUI: true,
    isIdle: () => idle,
    abort() {},
    waitForIdle: async () => {},
    ui: {
      notify(text: string, level?: string) {
        notifications.push(level === undefined ? { text } : { text, level });
      },
      setStatus(key: string, value: string | undefined) {
        statuses.set(key, value);
      },
    },
    sessionManager: {
      getLeafId: () => entries.at(-1)?.id ?? null,
      getBranch: () => [...entries],
      buildContextEntries: () => [...entries],
    },
    model: { id: "test", maxTokens: 16_384 },
    modelRegistry: {
      async complete(_model: unknown, request: any) {
        capturedCompactionPrompt = request.messages[0].content[0].text;
        return {
          content: [{ type: "text", text: "safe compact summary" }],
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        };
      },
    },
  };

  const invoke = async (name: string, event: unknown) => {
    let result: unknown;
    for (const handler of handlers.get(name) ?? []) result = await handler(event, context);
    return result;
  };

  await invoke("session_start", { type: "session_start", reason: "startup" });
  assert.equal(activeTools.includes("state_patch"), false);

  idle = false;
  const streamingInput = await invoke("input", {
    type: "input",
    text: "/skill:warehouse-audit aisle=streaming",
    source: "interactive",
    streamingBehavior: "steer",
  }) as { action: string };
  assert.equal(streamingInput.action, "handled");
  assert.equal(entries.length, 0);
  idle = true;

  const input = await invoke("input", {
    type: "input",
    text: "/skill:warehouse-audit aisle=7",
    source: "interactive",
  }) as { action: string };
  assert.equal(input.action, "continue");
  assert.ok(entries.some((entry) => entry.type === "custom" && entry.customType === MODE_ENTRY_TYPE));
  assert.ok(activeTools.includes("state_patch"));
  assert.ok(activeTools.includes("skill_complete"));

  append({ type: "message", message: { role: "user", content: "expanded skill invocation", timestamp: 2 } });
  const before = await invoke("before_agent_start", {
    type: "before_agent_start",
    prompt: "expanded",
    systemPrompt: "base",
    systemPromptOptions: {},
  }) as { systemPrompt: string };
  assert.match(before.systemPrompt, /bounded-state runtime/);

  const patchArgs = {
    operations: [
      { path: "/items_counted", action: "sum", value: "42" },
      { path: "/shelves_done", action: "union", value: '["7-01"]' },
    ],
  };
  append({
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "discard me" },
        { type: "toolCall", id: "patch-1", name: "state_patch", arguments: patchArgs },
      ],
      timestamp: 3,
    },
  });
  const patchTool = tools.get("state_patch");
  assert.ok(patchTool);
  assert.deepEqual(patchTool.prepareArguments(patchArgs), patchArgs);
  const patchResult = await patchTool.execute("patch-1", patchArgs, undefined, undefined, context);
  append({
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "patch-1",
      toolName: "state_patch",
      content: patchResult.content,
      details: patchResult.details,
      isError: false,
      timestamp: 4,
    },
  });
  await invoke("turn_end", { type: "turn_end", turnIndex: 0, message: {}, toolResults: [] });

  const projected = await invoke("context", { type: "context", messages: [] }) as { messages: any[] };
  assert.ok(projected.messages.some((message) => String(message.content).includes('"items_counted":42')));
  assert.match(statuses.get("skill-state") ?? "", /p1/);

  const activeCompact = await invoke("session_before_compact", {
    type: "session_before_compact",
    preparation: { firstKeptEntryId: entries.at(-1).id, tokensBefore: 100 },
    branchEntries: [...entries],
    reason: "manual",
    willRetry: false,
    signal: new AbortController().signal,
  }) as { cancel?: boolean };
  assert.equal(activeCompact.cancel, true);

  const safeTree = await invoke("session_before_tree", {
    type: "session_before_tree",
    preparation: {
      targetId: entries[0].id,
      oldLeafId: entries.at(-1).id,
      commonAncestorId: null,
      entriesToSummarize: [...entries],
      userWantsSummary: true,
    },
    signal: new AbortController().signal,
  }) as { summary?: { summary: string; details: { kind: string } } };
  assert.equal(safeTree.summary?.summary, "safe compact summary");
  assert.equal(safeTree.summary?.details.kind, "skill-state/safe-branch-summary");
  assert.equal(capturedCompactionPrompt.includes("discard me"), false);
  assert.match(capturedCompactionPrompt, /skill-state-current/);

  append({
    type: "message",
    message: {
      role: "assistant",
      content: [{ type: "toolCall", id: "complete-1", name: "skill_complete", arguments: { result: "aisle done" } }],
      timestamp: 5,
    },
  });
  const completeTool = tools.get("skill_complete");
  const completionResult = await completeTool.execute(
    "complete-1",
    { result: "aisle done" },
    undefined,
    undefined,
    context,
  );
  assert.equal(entries.at(-1).type, "message", "exit is not appended inside execute");
  append({
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "complete-1",
      toolName: "skill_complete",
      content: completionResult.content,
      details: completionResult.details,
      isError: false,
      timestamp: 6,
    },
  });
  await invoke("turn_end", {
    type: "turn_end",
    turnIndex: 1,
    message: {},
    toolResults: [entries.at(-1).message],
  });

  assert.equal(entries.at(-1).type, "custom");
  assert.equal(entries.at(-1).data.kind, "mode-exited");
  assert.equal(activeTools.includes("state_patch"), false);

  const enteredMarker = entries.find(
    (entry) => entry.type === "custom" && entry.data?.kind === "mode-entered",
  );
  const keepWholeEpisode = await invoke("session_before_compact", {
    type: "session_before_compact",
    preparation: { firstKeptEntryId: enteredMarker.id, tokensBefore: 250 },
    branchEntries: [...entries],
    reason: "manual",
    willRetry: false,
    signal: new AbortController().signal,
  }) as { compaction?: { firstKeptEntryId: string } };
  assert.equal(keepWholeEpisode.compaction?.firstKeptEntryId, enteredMarker.id);
  assert.equal(capturedCompactionPrompt.includes("Final state"), false, "a wholly retained episode is not duplicated into the summary");

  append({ type: "message", message: { role: "user", content: "after episode", timestamp: 7 } });
  const collapsed = await invoke("context", { type: "context", messages: [] }) as { messages: any[] };
  assert.equal(JSON.stringify(collapsed.messages).includes("discard me"), false);
  assert.ok(collapsed.messages.some((message) => String(message.content).includes("Final state")));

  const firstKept = entries.at(-1).id;
  const compacted = await invoke("session_before_compact", {
    type: "session_before_compact",
    preparation: { firstKeptEntryId: firstKept, tokensBefore: 500 },
    branchEntries: [...entries],
    reason: "manual",
    willRetry: false,
    signal: new AbortController().signal,
  }) as { compaction?: { summary: string; firstKeptEntryId: string } };
  assert.equal(compacted.compaction?.summary, "safe compact summary");
  assert.equal(compacted.compaction?.firstKeptEntryId, firstKept);
  assert.equal(capturedCompactionPrompt.includes("discard me"), false);
  assert.match(capturedCompactionPrompt, /Final state/);

  await commands.get("skill-state").handler(
    "start warehouse-audit alpha  two   words  ",
    context,
  );
  const explicitEntry = [...entries].reverse().find(
    (entry) => entry.type === "custom" && entry.data?.kind === "mode-entered",
  );
  assert.equal(explicitEntry.data.procedure.args, "alpha  two   words  ");
  await commands.get("skill-state").handler("stop", context);

  append({
    type: "custom",
    customType: MODE_ENTRY_TYPE,
    data: { v: 2, kind: "mode-entered" },
  });
  const blocked = await invoke("tool_call", {
    type: "tool_call",
    toolCallId: "unsafe-bash",
    toolName: "bash",
    input: { command: "echo unsafe" },
  }) as { block?: boolean; terminate?: boolean };
  assert.equal(blocked.block, true);
  assert.equal(blocked.terminate, true);

  assert.ok(notifications.some((item) => item.text.includes("started")));
});
