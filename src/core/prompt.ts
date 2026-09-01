import { type ActiveRuntime, type CompletedEpisode, type Reconstruction } from "./fold.js";
import { isJsonObject } from "./json.js";
import { renderState } from "./state.js";

export type PromptMessage = Readonly<Record<string, unknown>> & Readonly<{ role: string }>;

export type ContextItem =
  | Readonly<{ kind: "message"; entryId: string; message: PromptMessage }>
  | Readonly<{ kind: "marker"; entryId: string }>;

export const RUNTIME_CONTRACT = `You are executing the procedure below under a bounded-state runtime. Your context contains only the procedure, the current execution state, instructions from the user, and your last few actions with their results. Older history is not visible and will not return. Record every fact you will need later with state_patch in the same turn you learn it, before it leaves the window. The state block lists each field's merge policy. Policy fields cannot be overwritten or deleted; send only the change: new items for append/union, the amount to add for sum, a candidate for max, the single permanent value for once. lww fields are replaced whole with lww-set or removed with lww-delete. An invalid patch is rejected whole with the reasons; fix and resend. Keep state minimal and current. When the procedure goal is achieved, call skill_complete as the only tool call in that message, with a concise result.`;

export const STATE_NUDGE =
  "Record any facts from the recent tool observations that you will need later with state_patch now; the oldest turn in your view is about to leave the window.";

export function assemblePrompt(items: readonly ContextItem[], reconstruction: Reconstruction): PromptMessage[] {
  if (reconstruction.active) return assembleActive(items, reconstruction.active);
  return collapseCompleted(items, reconstruction.completed);
}

export function renderProcedure(active: ActiveRuntime): string {
  const { entered } = active.mode;
  const args = entered.procedure.args ? `\n\nTask arguments:\n${entered.procedure.args}` : "";
  return `<skill-state-procedure name=${JSON.stringify(entered.skillName)} location=${JSON.stringify(entered.procedure.skillPath)} schema-hash=${JSON.stringify(entered.schemaHash)}>\nReferences are relative to ${entered.procedure.skillBaseDir}.\n\n${entered.procedure.skillBody}${args}\n</skill-state-procedure>`;
}

/** P as a message, for summarizer paths; per-turn prompts carry P in the system prompt instead. */
export function procedureMessage(active: ActiveRuntime): PromptMessage {
  return syntheticUser(renderProcedure(active), active.mode.entered.enteredAt);
}

export function renderStateView(active: ActiveRuntime): string {
  const notes = active.schema.policyNotes
    .map(({ path, policy }) => `- ${path}: ${policy}`)
    .join("\n");
  return `<skill-state-current schema-hash=${JSON.stringify(active.schema.hash)}>\nMerge policies:\n${notes || "(no fields)"}\n\nState:\n${renderState(active.state)}\n</skill-state-current>`;
}

function assembleActive(items: readonly ContextItem[], active: ActiveRuntime): PromptMessage[] {
  const markerIndex = items.findIndex(
    (item) => item.kind === "marker" && item.entryId === active.mode.entryId,
  );
  const episodeItems = markerIndex < 0
    ? items.filter(
        (item) =>
          item.kind === "message" &&
          timestampOf(item.message) >= active.mode.entered.enteredAt,
      )
    : items.slice(markerIndex + 1);
  const messages = episodeItems.filter((item): item is Extract<ContextItem, { kind: "message" }> => item.kind === "message");

  const userMessages = messages
    .filter((item) => item.message.role === "user")
    .map((item) => item.message);
  if (active.mode.entered.source === "skill-invocation") {
    const invocationIndex = userMessages.findIndex((message) =>
      isInvokingSkillMessage(message, active),
    );
    if (invocationIndex >= 0) userMessages.splice(invocationIndex, 1);
  }

  const assistantIndices = messages
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.message.role === "assistant")
    .map(({ index }) => index);
  const selectedAssistantIndices = assistantIndices.slice(-active.mode.entered.config.windowTurns);
  const completeAssistantCalls = new Map<number, ReturnType<typeof toolCalls>>();
  const selectedCallIds = new Set<string>();

  for (const index of selectedAssistantIndices) {
    const calls = toolCalls(messages[index]!.message);
    if (calls.length === 0) continue;
    const resultIds = new Set(
      messages
        .map(({ message }) => message)
        .filter(
          (message) =>
            message.role === "toolResult" &&
            typeof message.toolCallId === "string",
        )
        .map((message) => message.toolCallId as string),
    );
    if (!calls.every((call) => resultIds.has(call.id))) continue;
    completeAssistantCalls.set(index, calls);
    for (const call of calls) selectedCallIds.add(call.id);
  }

  // Extension-injected custom messages (and context-visible `!` bash runs) are
  // observations: kept while inside the window span, deferred past any
  // call/result pair they would otherwise split, expired with the window.
  const evictedCount = assistantIndices.length - selectedAssistantIndices.length;
  const windowStartIndex = evictedCount > 0 ? assistantIndices[evictedCount - 1]! : -1;

  const windowMessages: PromptMessage[] = [];
  const openResultIds = new Set<string>();
  const deferredObservations: PromptMessage[] = [];
  const flushObservations = (): void => {
    if (openResultIds.size === 0 && deferredObservations.length > 0) {
      windowMessages.push(...deferredObservations);
      deferredObservations.length = 0;
    }
  };
  messages.forEach(({ message }, index) => {
    const calls = completeAssistantCalls.get(index);
    if (calls) {
      windowMessages.push({ ...message, content: calls.map((call) => call.raw) });
      for (const call of calls) openResultIds.add(call.id);
      return;
    }
    if (
      (message.role === "custom" || message.role === "bashExecution") &&
      message.excludeFromContext !== true &&
      index > windowStartIndex
    ) {
      deferredObservations.push(message);
      flushObservations();
      return;
    }
    if (
      message.role === "toolResult" &&
      typeof message.toolCallId === "string" &&
      selectedCallIds.has(message.toolCallId)
    ) {
      windowMessages.push(message);
      openResultIds.delete(message.toolCallId);
      flushObservations();
    }
  });
  flushObservations();

  const prompt: PromptMessage[] = [
    syntheticUser(renderStateView(active), active.mode.entered.enteredAt + 1),
    ...userMessages,
    ...windowMessages,
  ];

  if (shouldNudge(messages, selectedAssistantIndices, active)) {
    prompt.push(syntheticUser(STATE_NUDGE, newestTimestamp(prompt) + 1));
  }
  return prompt;
}

function collapseCompleted(
  items: readonly ContextItem[],
  completed: readonly CompletedEpisode[],
): PromptMessage[] {
  const byEntered = new Map(completed.map((episode) => [episode.enteredEntryId, episode]));
  const result: PromptMessage[] = [];
  let skipUntil: string | undefined;

  for (const item of items) {
    if (skipUntil) {
      if (item.kind === "marker" && item.entryId === skipUntil) skipUntil = undefined;
      continue;
    }
    if (item.kind === "marker") {
      const episode = byEntered.get(item.entryId);
      if (!episode) continue;
      const args = episode.entered.procedure.args;
      result.push(
        syntheticUser(
          `<skill-state-episode name=${JSON.stringify(episode.entered.skillName)}>Executed skill ${JSON.stringify(episode.entered.skillName)}${args ? ` with arguments ${JSON.stringify(args)}` : ""}.</skill-state-episode>`,
          episode.entered.enteredAt,
        ),
        syntheticUser(
          `<skill-state-result outcome=${JSON.stringify(episode.exited.outcome)}>\nFinal state:\n${episode.exited.finalState}\n\nResult:\n${episode.exited.result}\n</skill-state-result>`,
          episode.exited.exitedAt,
        ),
      );
      skipUntil = episode.exitedEntryId;
      continue;
    }
    result.push(item.message);
  }
  return result;
}

function shouldNudge(
  messages: readonly Readonly<{ message: PromptMessage }>[],
  selectedAssistantIndices: readonly number[],
  active: ActiveRuntime,
): boolean {
  if (selectedAssistantIndices.length === 0) return false;
  const allAssistantCount = messages.filter(({ message }) => message.role === "assistant").length;
  if (allAssistantCount < active.mode.entered.config.windowTurns) return false;
  const atRiskIndex = selectedAssistantIndices[0]!;
  const atRisk = messages[atRiskIndex]!.message;
  const calls = toolCalls(atRisk);
  if (calls.length === 0) return false;
  const statePatchIds = new Set(
    calls
      .filter((call) => call.raw.name === "state_patch")
      .map((call) => call.id),
  );
  return ![...statePatchIds].some((callId) => active.acceptedPatchCallIds.has(callId));
}

function toolCalls(message: PromptMessage): Array<{ id: string; raw: Readonly<Record<string, unknown>> }> {
  if (!Array.isArray(message.content)) return [];
  const calls: Array<{ id: string; raw: Readonly<Record<string, unknown>> }> = [];
  for (const part of message.content) {
    if (!isJsonObject(part) || part.type !== "toolCall" || typeof part.id !== "string") continue;
    calls.push({ id: part.id, raw: part });
  }
  return calls;
}

function isInvokingSkillMessage(message: PromptMessage, active: ActiveRuntime): boolean {
  const content = typeof message.content === "string"
    ? message.content
    : Array.isArray(message.content)
      ? message.content
          .filter((part): part is Readonly<{ type: "text"; text: string }> =>
            isJsonObject(part) && part.type === "text" && typeof part.text === "string",
          )
          .map((part) => part.text)
          .join("\n")
      : "";
  const prefix = `<skill name=${JSON.stringify(active.mode.entered.skillName)} location=${JSON.stringify(active.mode.entered.procedure.skillPath)}>`;
  return content.startsWith(prefix);
}

function syntheticUser(content: string, timestamp: number): PromptMessage {
  return { role: "user", content, timestamp };
}

function timestampOf(message: PromptMessage): number {
  return typeof message.timestamp === "number" ? message.timestamp : 0;
}

function newestTimestamp(messages: readonly PromptMessage[]): number {
  return messages.reduce((latest, message) => Math.max(latest, timestampOf(message)), 0);
}
