import { err, ok, patchError, type Result, type SkillStateError } from "./errors.js";
import { isJsonObject } from "./json.js";
import {
  enterMode,
  exitMode,
  inactiveMode,
  parseModeEntry,
  type ActiveMode,
  type ModeEnteredV1,
  type ModeExitedV1,
  type ModeState,
} from "./mode.js";
import { parseStateSchema, type StateSchema } from "./schema.js";
import {
  acceptPatch,
  estimateStateTokens,
  initialState,
  parseRenderedState,
  renderState,
  type State,
} from "./state.js";

export const MODE_ENTRY_TYPE = "skill-state/mode";
export const ACCEPTED_PATCH_KIND = "skill-state/accepted-patch";

export interface AcceptedPatchDetailsV1 {
  readonly v: 1;
  readonly kind: typeof ACCEPTED_PATCH_KIND;
  readonly runId: string;
  readonly schemaHash: string;
  readonly estimatedTokens: number;
}

export interface CompletedEpisode {
  readonly enteredEntryId: string;
  readonly exitedEntryId: string;
  readonly entered: ModeEnteredV1;
  readonly exited: ModeExitedV1;
}

export interface ActiveRuntime {
  readonly mode: ActiveMode;
  readonly schema: StateSchema;
  readonly state: State;
  readonly turns: number;
  readonly patches: number;
}

export interface Reconstruction {
  readonly mode: ModeState;
  readonly active?: ActiveRuntime;
  readonly completed: readonly CompletedEpisode[];
}

type PendingCall = Readonly<{ runId: string; schemaHash: string; args: unknown }>;

export function reconstructBranch(entries: readonly unknown[]): Result<Reconstruction> {
  let mode: ModeState = inactiveMode;
  let active: ActiveRuntime | undefined;
  const completed: CompletedEpisode[] = [];
  const calls = new Map<string, PendingCall>();
  const errors: SkillStateError[] = [];

  for (const rawEntry of entries) {
    if (!isEntry(rawEntry)) continue;

    if (rawEntry.type === "custom" && rawEntry.customType === MODE_ENTRY_TYPE) {
      const parsed = parseModeEntry(rawEntry.data);
      if (!parsed.ok) {
        errors.push(...parsed.errors);
        continue;
      }
      if (parsed.value.kind === "mode-entered") {
        const transition = enterMode(mode, rawEntry.id, parsed.value);
        if (!transition.ok) {
          errors.push(...transition.errors);
          continue;
        }
        const parsedSchema = parseStateSchema(parsed.value.procedure.schemaBytes);
        if (!parsedSchema.ok) {
          errors.push(...parsedSchema.errors);
          continue;
        }
        if (parsedSchema.value.hash !== parsed.value.schemaHash) {
          errors.push(entryConsistency("/schemaHash", parsedSchema.value.hash, parsed.value.schemaHash));
          continue;
        }
        const initial = initialState(parsedSchema.value);
        const initialTokens = estimateStateTokens(initial);
        if (initialTokens > parsed.value.config.budgetTokens) {
          errors.push(
            patchError(
              "state-budget",
              "/",
              `initial state at most ${parsed.value.config.budgetTokens} estimated tokens`,
              `${initialTokens} estimated tokens`,
            ),
          );
          continue;
        }
        mode = transition.value;
        active = {
          mode: transition.value,
          schema: parsedSchema.value,
          state: initial,
          turns: 0,
          patches: 0,
        };
        calls.clear();
      } else {
        if (!active || mode.tag !== "active") {
          const transition = exitMode(mode, parsed.value);
          if (!transition.ok) errors.push(...transition.errors);
          continue;
        }
        const transition = exitMode(mode, parsed.value);
        if (!transition.ok) {
          errors.push(...transition.errors);
          continue;
        }
        const finalState = parseRenderedState(active.schema, parsed.value.finalState);
        if (!finalState.ok) {
          errors.push(...finalState.errors);
          continue;
        }
        const canonicalFinalState = renderState(finalState.value);
        if (parsed.value.finalState !== canonicalFinalState) {
          errors.push(entryConsistency("/finalState", canonicalFinalState, parsed.value.finalState));
          continue;
        }
        if (canonicalFinalState !== renderState(active.state)) {
          errors.push(entryConsistency("/finalState", renderState(active.state), parsed.value.finalState));
          continue;
        }
        completed.push({
          enteredEntryId: active.mode.entryId,
          exitedEntryId: rawEntry.id,
          entered: active.mode.entered,
          exited: parsed.value,
        });
        mode = transition.value;
        active = undefined;
        calls.clear();
      }
      continue;
    }

    if (rawEntry.type !== "message" || !isJsonObject(rawEntry.message)) continue;
    const message = rawEntry.message;

    if (message.role === "assistant" && Array.isArray(message.content)) {
      if (active) active = { ...active, turns: active.turns + 1 };
      for (const part of message.content) {
        if (!isJsonObject(part) || part.type !== "toolCall" || part.name !== "state_patch") continue;
        if (typeof part.id !== "string") {
          errors.push(entryShape("/message/content/id", "state_patch tool call id", part.id));
          continue;
        }
        if (!active) continue;
        if (calls.has(part.id)) {
          errors.push(entryConsistency("/message/content/id", "unique state_patch call id", part.id));
          continue;
        }
        calls.set(part.id, {
          runId: active.mode.entered.runId,
          schemaHash: active.schema.hash,
          args: part.arguments,
        });
      }
      continue;
    }

    if (message.role !== "toolResult" || message.toolName !== "state_patch" || message.isError === true) continue;
    if (typeof message.toolCallId !== "string") {
      errors.push(entryShape("/message/toolCallId", "state_patch tool call id", message.toolCallId));
      continue;
    }
    const details = parseAcceptedPatchDetails(message.details);
    if (!details.ok) {
      errors.push(...details.errors);
      continue;
    }
    const call = calls.get(message.toolCallId);
    if (!call) {
      errors.push(entryConsistency("/message/toolCallId", "preceding state_patch call", message.toolCallId));
      continue;
    }
    calls.delete(message.toolCallId);
    if (!active || mode.tag !== "active") {
      errors.push({
        kind: "mode",
        code: "inactive",
        operation: "replay state_patch",
        expected: "active mode",
        actual: `accepted result for ${message.toolCallId}`,
      });
      continue;
    }
    if (details.value.runId !== call.runId || details.value.runId !== active.mode.entered.runId) {
      errors.push(entryConsistency("/details/runId", active.mode.entered.runId, details.value.runId));
      continue;
    }
    if (details.value.schemaHash !== call.schemaHash || details.value.schemaHash !== active.schema.hash) {
      errors.push(entryConsistency("/details/schemaHash", active.schema.hash, details.value.schemaHash));
      continue;
    }
    const transition = acceptPatch(
      active.schema,
      active.state,
      call.args,
      { maxTokens: active.mode.entered.config.budgetTokens },
    );
    if (!transition.ok) {
      errors.push(...transition.errors);
      continue;
    }
    if (transition.value.estimatedTokens !== details.value.estimatedTokens) {
      errors.push(
        entryConsistency(
          "/details/estimatedTokens",
          String(transition.value.estimatedTokens),
          String(details.value.estimatedTokens),
        ),
      );
      continue;
    }
    active = {
      ...active,
      state: transition.value.state,
      patches: active.patches + 1,
    };
  }

  if (errors.length > 0) return { ok: false, errors };
  return ok({
    mode,
    ...(active ? { active } : {}),
    completed,
  });
}

export function acceptedPatchDetails(runtime: ActiveRuntime, estimatedTokens: number): AcceptedPatchDetailsV1 {
  return {
    v: 1,
    kind: ACCEPTED_PATCH_KIND,
    runId: runtime.mode.entered.runId,
    schemaHash: runtime.schema.hash,
    estimatedTokens,
  };
}

export function parseAcceptedPatchDetails(raw: unknown): Result<AcceptedPatchDetailsV1> {
  if (!isJsonObject(raw)) return err(entryShape("/details", "accepted patch details", raw));
  const errors: SkillStateError[] = [];
  if (raw.v !== 1) errors.push(entryShape("/details/v", "version 1", raw.v, "entry-version"));
  if (raw.kind !== ACCEPTED_PATCH_KIND) errors.push(entryShape("/details/kind", ACCEPTED_PATCH_KIND, raw.kind));
  if (typeof raw.runId !== "string") errors.push(entryShape("/details/runId", "string", raw.runId));
  if (typeof raw.schemaHash !== "string") errors.push(entryShape("/details/schemaHash", "string", raw.schemaHash));
  if (!Number.isSafeInteger(raw.estimatedTokens) || (raw.estimatedTokens as number) < 0) {
    errors.push(entryShape("/details/estimatedTokens", "non-negative integer", raw.estimatedTokens));
  }
  if (errors.length > 0) return { ok: false, errors };
  return ok(raw as unknown as AcceptedPatchDetailsV1);
}

function isEntry(raw: unknown): raw is Readonly<{
  id: string;
  type: string;
  customType?: string;
  data?: unknown;
  message?: unknown;
}> {
  return isJsonObject(raw) && typeof raw.id === "string" && typeof raw.type === "string";
}

function entryShape(
  path: string,
  expected: string,
  actual: unknown,
  code: "entry-shape" | "entry-version" = "entry-shape",
): SkillStateError {
  return {
    kind: "entry",
    code,
    path,
    expected,
    actual: actual === undefined ? "missing" : JSON.stringify(actual),
  };
}

function entryConsistency(path: string, expected: string, actual: string): SkillStateError {
  return { kind: "entry", code: "entry-consistency", path, expected, actual };
}
