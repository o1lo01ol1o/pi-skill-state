import { ACCEPTED_PATCH_KIND, type ActiveRuntime, type CompletedEpisode, type Reconstruction } from "./fold.js";
import { isJsonObject } from "./json.js";
import { renderState } from "./state.js";

export type PromptMessage = Readonly<Record<string, unknown>> & Readonly<{ role: string }>;

export type ContextItem =
  | Readonly<{ kind: "message"; entryId: string; message: PromptMessage }>
  | Readonly<{ kind: "marker"; entryId: string }>;

export const RUNTIME_CONTRACT = `You are executing the procedure below under a bounded-state runtime. Your context contains only the procedure, the current execution state, instructions from the user, and your last few actions with their results. Older history is not visible and will not return. Record every fact you will need later with state_patch before it leaves the window. Policy fields accept deltas only. Keep state minimal and current. When the procedure goal is achieved, call skill_complete with a concise result.`;

export const STATE_NUDGE =
  "Record any facts from the recent tool observations that you will need later with state_patch now; the observation window will slide.";

export function assemblePrompt(items: readonly ContextItem[], reconstruction: Reconstruction): PromptMessage[] {
  if (reconstruction.active) return assembleActive(items, reconstruction.active);
  return collapseCompleted(items, reconstruction.completed);
}

export function renderProcedure(active: ActiveRuntime): string {
  const { entered } = active.mode;
  const args = entered.procedure.args ? `\n\nTask arguments:\n${entered.procedure.args}` : "";
  return `<skill-state-procedure name=${JSON.stringify(entered.skillName)} location=${JSON.stringify(entered.procedure.skillPath)} schema-hash=${JSON.stringify(entered.schemaHash)}>\nReferences are relative to ${entered.procedure.skillBaseDir}.\n\n${entered.procedure.skillBody}${args}\n</skill-state-procedure>`;
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

  const windowMessages: PromptMessage[] = [];
  messages.forEach(({ message }, index) => {
    const calls = completeAssistantCalls.get(index);
    if (calls) {
      windowMessages.push({ ...message, content: calls.map((call) => call.raw) });
      return;
    }
    if (
      message.role === "toolResult" &&
      typeof message.toolCallId === "string" &&
      selectedCallIds.has(message.toolCallId)
    ) {
      windowMessages.push(message);
    }
  });

  const prompt: PromptMessage[] = [
    syntheticUser(renderProcedure(active), active.mode.entered.enteredAt),
    syntheticUser(renderStateView(active), active.mode.entered.enteredAt + 1),
    ...userMessages,
    ...windowMessages,
  ];

  if (shouldNudge(messages, selectedAssistantIndices, active.mode.entered.config.windowTurns)) {
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
      result.push(
        syntheticUser(
          `<skill-state-episode name=${JSON.stringify(episode.entered.skillName)}>executed with args ${JSON.stringify(episode.entered.procedure.args)}</skill-state-episode>`,
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
  windowTurns: number,
): boolean {
  if (selectedAssistantIndices.length === 0) return false;
  const allAssistantCount = messages.filter(({ message }) => message.role === "assistant").length;
  if (allAssistantCount < windowTurns) return false;
  const latestIndex = selectedAssistantIndices[selectedAssistantIndices.length - 1]!;
  const latest = messages[latestIndex]!.message;
  const calls = toolCalls(latest);
  if (calls.length === 0) return false;
  const ids = new Set(calls.map((call) => call.id));
  return !messages.some(({ message }) => {
    if (
      message.role !== "toolResult" ||
      typeof message.toolCallId !== "string" ||
      !ids.has(message.toolCallId) ||
      message.isError === true ||
      !isJsonObject(message.details)
    ) {
      return false;
    }
    return message.details.kind === ACCEPTED_PATCH_KIND;
  });
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
