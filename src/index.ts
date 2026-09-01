import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionBeforeTreeEvent,
  SessionEntry,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  buildContextEntries,
  convertToLlm,
  parseFrontmatter,
  serializeConversation,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { Static, TSchema } from "typebox";
import { Type } from "typebox";
import {
  ACCEPTED_PATCH_KIND,
  MODE_ENTRY_TYPE,
  acceptRuntimePatch,
  acceptedPatchDetails,
  reconstructBranch,
  type ActiveRuntime,
  type Reconstruction,
} from "./core/fold.js";
import {
  formatErrors,
  patchError,
  structuredErrorJson,
  type SkillStateError,
} from "./core/errors.js";
import {
  type EntrySource,
  type ModeEnteredV1,
  type ModeExitedV1,
} from "./core/mode.js";
import {
  assemblePrompt,
  procedureMessage,
  renderProcedure,
  RUNTIME_CONTRACT,
  type ContextItem,
  type PromptMessage,
} from "./core/prompt.js";
import { parseStateSchema, type StateSchema } from "./core/schema.js";
import { estimateStateTokens, initialState, parsePatch, renderState } from "./core/state.js";

const STATUS_KEY = "skill-state";
const STATE_PATCH_TOOL = "state_patch";
const COMPLETE_TOOL = "skill_complete";
const WINDOW_FLAG = "skill-state-window-turns";
const BUDGET_FLAG = "skill-state-budget-tokens";
const CONSTRAINED_FLAG = "skill-state-constrained-sampling";

const CompleteParams = Type.Object({
  result: Type.String({ description: "Concise outcome retained after the episode" }),
});

interface PendingCompletion {
  readonly toolCallId: string;
  readonly runId: string;
  readonly result: string;
  readonly finalState: string;
  readonly schemaHash: string;
}

interface SkillFrontmatter extends Record<string, unknown> {
  name?: string;
  metadata?: unknown;
}

interface ResolvedSkill {
  readonly name: string;
  readonly skillPath: string;
  readonly schemaPath: string;
  readonly skillBody: string;
  readonly schemaBytes: string;
  readonly schema: StateSchema;
}

export default function skillStateExtension(pi: ExtensionAPI): void {
  pi.registerFlag(WINDOW_FLAG, {
    description: "Bounded observation-window turns (1-8)",
    type: "string",
    default: "2",
  });
  pi.registerFlag(BUDGET_FLAG, {
    description: "Maximum estimated tokens in rendered skill state",
    type: "string",
    default: "4000",
  });
  pi.registerFlag(CONSTRAINED_FLAG, {
    description: "Require provider-side constrained sampling for tagged state operations",
    type: "boolean",
    default: false,
  });

  let pendingCompletion: PendingCompletion | undefined;
  let cachedLeaf: string | null | undefined;
  let cachedReconstruction: Reconstruction | undefined;
  let persistenceBlock: Readonly<{ sessionKey: string; error: Error }> | undefined;

  const invalidate = (): void => {
    cachedLeaf = undefined;
    cachedReconstruction = undefined;
  };

  const reconstruct = (ctx: ExtensionContext): Reconstruction => {
    if (persistenceBlock) {
      if (persistenceBlock.sessionKey === sessionKey(ctx)) throw persistenceBlock.error;
      persistenceBlock = undefined;
    }
    const leaf = ctx.sessionManager.getLeafId();
    if (cachedLeaf === leaf && cachedReconstruction) return cachedReconstruction;
    const result = reconstructBranch(ctx.sessionManager.getBranch());
    if (!result.ok) throw coreFailure(result.errors);
    cachedLeaf = leaf;
    cachedReconstruction = result.value;
    return result.value;
  };

  const updateStatus = (ctx: ExtensionContext, reconstruction: Reconstruction): void => {
    if (!reconstruction.active) {
      setStatus(ctx, undefined);
      return;
    }
    const active = reconstruction.active;
    setStatus(ctx, `Σ ${formatEstimate(active.state)} · t${active.turns} · p${active.patches}`);
  };

  const setEpisodeTools = (active: ActiveRuntime | undefined): void => {
    const withoutOwn = pi.getActiveTools().filter(
      (name) => name !== STATE_PATCH_TOOL && name !== COMPLETE_TOOL,
    );
    if (!active) {
      pi.setActiveTools(withoutOwn);
      return;
    }
    pi.registerTool(createStatePatchTool(active.schema, active.mode.entered.config.constrainedSampling));
    pi.setActiveTools([...new Set([...withoutOwn, STATE_PATCH_TOOL, COMPLETE_TOOL])]);
  };

  const refresh = (ctx: ExtensionContext): Reconstruction => {
    invalidate();
    const reconstruction = reconstruct(ctx);
    setEpisodeTools(reconstruction.active);
    updateStatus(ctx, reconstruction);
    return reconstruction;
  };

  const appendModeEntry = (
    ctx: ExtensionContext,
    data: ModeEnteredV1 | ModeExitedV1,
    operation: "enter" | "exit",
  ): void => {
    try {
      pi.appendEntry(MODE_ENTRY_TYPE, data);
    } catch (cause) {
      const error = coreFailure([{
        kind: "mode",
        code: "boundary-io",
        operation: `persist mode ${operation}`,
        expected: "durable append-only session entry",
        actual: cause instanceof Error ? cause.message : String(cause),
      }]);
      persistenceBlock = { sessionKey: sessionKey(ctx), error };
      invalidate();
      setEpisodeTools(undefined);
      setStatus(ctx, "Σ blocked");
      throw error;
    }
  };

  const appendExit = (
    ctx: ExtensionContext,
    active: ActiveRuntime,
    outcome: "completed" | "stopped",
    result: string,
  ): void => {
    const exited: ModeExitedV1 = {
      v: 1,
      kind: "mode-exited",
      runId: active.mode.entered.runId,
      schemaHash: active.schema.hash,
      outcome,
      result,
      finalState: renderState(active.state),
      exitedAt: Date.now(),
    };
    appendModeEntry(ctx, exited, "exit");
    refresh(ctx);
  };

  const arm = async (
    skillName: string,
    args: string,
    source: EntrySource,
    ctx: ExtensionContext,
  ): Promise<void> => {
    if (!ctx.isIdle()) {
      throw coreFailure([{
        kind: "mode",
        code: "invalid-command",
        operation: "start",
        expected: "idle agent so the runtime contract is installed before the first bounded turn",
        actual: "agent is streaming or has queued continuation work",
      }]);
    }
    const current = reconstruct(ctx);
    if (current.active) {
      throw coreFailure([{
        kind: "mode",
        code: "already-active",
        operation: "start",
        expected: "inactive mode",
        actual: `run ${current.active.mode.entered.runId} is active`,
      }]);
    }
    const skill = await resolveSkill(pi, skillName);
    const config = readRunConfig(pi);
    const initialTokens = estimateStateTokens(initialState(skill.schema));
    if (initialTokens > config.budgetTokens) {
      throw coreFailure([
        patchError(
          "state-budget",
          "/",
          `initial state at most ${config.budgetTokens} estimated tokens`,
          `${initialTokens} estimated tokens`,
        ),
      ]);
    }
    const entered: ModeEnteredV1 = {
      v: 1,
      kind: "mode-entered",
      runId: randomUUID(),
      skillName,
      schemaHash: skill.schema.hash,
      source,
      enteredAt: Date.now(),
      procedure: {
        skillPath: skill.skillPath,
        skillBaseDir: dirname(skill.skillPath),
        schemaPath: skill.schemaPath,
        skillBody: skill.skillBody,
        schemaBytes: skill.schemaBytes,
        args,
      },
      config,
    };
    appendModeEntry(ctx, entered, "enter");
    refresh(ctx);
    notify(ctx, `skill-state started: ${skillName}`, "info");
  };

  pi.registerTool({
    name: COMPLETE_TOOL,
    label: "Skill Complete",
    description:
      "Complete the active bounded-state skill episode with a concise retained result. Call it only when the procedure goal is fully achieved, as the only tool call in its message; record final facts with state_patch in an earlier message.",
    promptSnippet: "Complete the active skill episode and retain its concise result",
    parameters: CompleteParams,
    executionMode: "sequential",
    async execute(toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        const reconstruction = reconstruct(ctx);
        if (!reconstruction.active) throw coreFailure([inactiveToolError(COMPLETE_TOOL)]);
        requireOnlyCompletionCall(ctx, toolCallId);
        pendingCompletion = {
          toolCallId,
          runId: reconstruction.active.mode.entered.runId,
          result: params.result,
          finalState: renderState(reconstruction.active.state),
          schemaHash: reconstruction.active.schema.hash,
        };
        return {
          content: [{ type: "text", text: `Episode complete: ${params.result}` }],
          details: { v: 1, kind: "skill-state/completion", runId: pendingCompletion.runId },
          terminate: true,
        };
      } catch (error) {
        notifyFailure(ctx, error);
        throw error;
      }
    },
    renderCall(args, theme) {
      return new Text(
        theme.fg("toolTitle", theme.bold("skill_complete ")) + theme.fg("muted", args.result),
        0,
        0,
      );
    },
    renderResult(result, _options, theme) {
      const first = result.content[0];
      return new Text(theme.fg("success", first?.type === "text" ? first.text : "Completed"), 0, 0);
    },
  });

  pi.registerCommand("skill-state", {
    description: "Start, stop, inspect, or show bounded skill state",
    handler: async (args, ctx) => {
      const command = takeLeadingToken(args);
      const action = command?.token ?? "status";
      try {
        if (action === "start") {
          const skill = takeLeadingToken(command?.rest ?? "");
          if (!skill) {
            throw modeFailure(
              "invalid-command",
              "start",
              "/skill-state start <skill> [args…]",
              "skill name is missing",
            );
          }
          await arm(skill.token, skill.rest, "command", ctx);
          return;
        }
        if (action === "stop") {
          if (!ctx.isIdle()) {
            ctx.abort();
            await ctx.waitForIdle();
          }
          const reconstruction = reconstruct(ctx);
          if (!reconstruction.active) throw coreFailure([inactiveToolError("stop")]);
          appendExit(ctx, reconstruction.active, "stopped", "Stopped by user.");
          pendingCompletion = undefined;
          notify(ctx, "skill-state stopped", "info");
          return;
        }
        const reconstruction = reconstruct(ctx);
        if (action === "show") {
          notify(
            ctx,
            reconstruction.active ? renderState(reconstruction.active.state) : "skill-state is inactive",
            "info",
          );
          return;
        }
        if (action === "status") {
          notify(ctx, formatDetailedStatus(reconstruction), "info");
          return;
        }
        throw modeFailure(
          "invalid-command",
          "skill-state command",
          "/skill-state start|stop|status|show",
          `unknown action ${JSON.stringify(action)}`,
        );
      } catch (error) {
        notifyFailure(ctx, error);
      }
    },
  });

  pi.on("input", async (event, ctx) => {
    const invocation = parseSkillInvocation(event.text);
    if (!invocation) return { action: "continue" as const };
    try {
      const candidate = await resolveSkill(pi, invocation.name, false);
      if (!candidate) return { action: "continue" as const };
      await arm(invocation.name, invocation.args, "skill-invocation", ctx);
      return { action: "continue" as const };
    } catch (error) {
      notifyFailure(ctx, error);
      return { action: "handled" as const };
    }
  });

  pi.on("session_start", (_event, ctx) => {
    try {
      refresh(ctx);
    } catch (error) {
      setEpisodeTools(undefined);
      setStatus(ctx, "Σ blocked");
      notifyFailure(ctx, error);
    }
  });
  pi.on("session_tree", (_event, ctx) => {
    pendingCompletion = undefined;
    try {
      refresh(ctx);
    } catch (error) {
      setEpisodeTools(undefined);
      setStatus(ctx, "Σ blocked");
      notifyFailure(ctx, error);
    }
  });
  pi.on("session_shutdown", (_event, ctx) => setStatus(ctx, undefined));

  pi.on("before_agent_start", (event, ctx) => {
    try {
      const active = reconstruct(ctx).active;
      if (!active) return;
      // P rides the system prompt: pi's provider conversion puts durable cache
      // breakpoints only on system/tool blocks, so a message-array P would be
      // re-priced every time Σ changes.
      return { systemPrompt: `${event.systemPrompt}\n\n${RUNTIME_CONTRACT}\n\n${renderProcedure(active)}` };
    } catch (error) {
      notifyFailure(ctx, error);
      return { systemPrompt: `${event.systemPrompt}\n\nSkill-state reconstruction is blocked. Do not call tools; report the failure to the user and stop.` };
    }
  });

  pi.on("context", (event, ctx) => {
    try {
      const reconstruction = reconstruct(ctx);
      updateStatus(ctx, reconstruction);
      const timeline = timelineFromEntries(ctx.sessionManager.buildContextEntries());
      return { messages: assemblePrompt(timeline, reconstruction) as unknown as typeof event.messages };
    } catch (error) {
      const text = failureMessage(error);
      setStatus(ctx, "Σ blocked");
      notify(ctx, text, "error");
      return {
        messages: [{
          role: "user",
          content: `Skill-state is blocked and tool calls are disabled: ${text}\nReport this failure to the user and stop.`,
          timestamp: Date.now(),
        }] as typeof event.messages,
      };
    }
  });

  pi.on("tool_call", (_event, ctx) => {
    try {
      reconstruct(ctx);
    } catch (error) {
      const reason = `skill-state reconstruction is blocked: ${failureMessage(error)}`;
      setStatus(ctx, "Σ blocked");
      notify(ctx, reason, "error");
      return { block: true, reason, terminate: true };
    }
  });

  pi.on("turn_end", (event, ctx) => {
    if (pendingCompletion) {
      const completed = event.toolResults.find(
        (result) =>
          result.toolCallId === pendingCompletion!.toolCallId &&
          result.toolName === COMPLETE_TOOL &&
          !result.isError,
      );
      if (completed) {
        try {
          const reconstruction = reconstruct(ctx);
          if (
            reconstruction.active &&
            reconstruction.active.mode.entered.runId === pendingCompletion.runId &&
            renderState(reconstruction.active.state) === pendingCompletion.finalState &&
            reconstruction.active.schema.hash === pendingCompletion.schemaHash
          ) {
            appendExit(ctx, reconstruction.active, "completed", pendingCompletion.result);
          }
        } catch (error) {
          notifyFailure(ctx, error);
        }
      }
      pendingCompletion = undefined;
      return;
    }
    try {
      refresh(ctx);
    } catch (error) {
      notifyFailure(ctx, error);
    }
  });

  pi.on("session_before_tree", async (event, ctx) => {
    if (!event.preparation.userWantsSummary) return;
    const branch = ctx.sessionManager.getBranch();
    const reconstructed = reconstructBranch(branch);
    if (!reconstructed.ok) {
      notifyFailure(ctx, coreFailure(reconstructed.errors));
      return { cancel: true };
    }
    if (!summaryTouchesEpisode(event, branch, reconstructed.value)) return;

    try {
      const assembled = assemblePrompt(
        timelineFromEntries(safeTreeEntries(event, branch, reconstructed.value)),
        reconstructed.value,
      );
      const safeMessages = reconstructed.value.active
        ? [procedureMessage(reconstructed.value.active), ...assembled]
        : assembled;
      const summarized = await summarizeSafeMessages(
        ctx,
        safeMessages,
        event.signal,
        event.preparation.customInstructions,
        "branch navigation",
      );
      return {
        summary: {
          summary: summarized.summary,
          usage: summarized.usage,
          details: { v: 1, kind: "skill-state/safe-branch-summary" },
        },
      };
    } catch (error) {
      notifyFailure(ctx, error);
      return { cancel: true };
    }
  });

  pi.on("session_before_compact", async (event, ctx) => {
    const reconstructed = reconstructBranch(event.branchEntries);
    if (!reconstructed.ok) {
      notifyFailure(ctx, coreFailure(reconstructed.errors));
      return { cancel: true };
    }
    if (reconstructed.value.active) {
      notify(ctx, "Compaction cancelled while a skill-state episode is active.", "warning");
      return { cancel: true };
    }
    if (reconstructed.value.completed.length === 0) return;

    try {
      const safe = await createSafeCompaction(event, ctx, reconstructed.value);
      if (!safe) return { cancel: true };
      return { compaction: safe };
    } catch (error) {
      notifyFailure(ctx, error);
      return { cancel: true };
    }
  });

  pi.registerEntryRenderer(MODE_ENTRY_TYPE, (entry, { expanded }, theme) => {
    const data = entry.data;
    if (!data || typeof data !== "object") return new Text(theme.fg("error", "invalid skill-state entry"), 0, 0);
    const value = data as Record<string, unknown>;
    const label = value.kind === "mode-entered"
      ? `skill-state started: ${String(value.skillName)}`
      : `skill-state ${String(value.outcome ?? "exited")}`;
    const detail = expanded ? `\n${JSON.stringify(value, null, 2)}` : "";
    return new Text(theme.fg("accent", label) + theme.fg("dim", detail), 0, 0);
  });

  function createStatePatchTool(
    schema: StateSchema,
    constrainedSampling: boolean,
  ): ToolDefinition<TSchema, { v: 1; kind: typeof ACCEPTED_PATCH_KIND; runId: string; schemaHash: string; estimatedTokens: number }> {
    return {
      name: STATE_PATCH_TOOL,
      label: "State Patch",
      description:
        "Atomically update bounded skill state with tagged operations. Each operation names an RFC 6901 path to a state field, the action required by that field's merge policy (policies are listed in the state block), and the payload as JSON text. Payload by action: lww-set replaces the whole field; lww-delete deletes it (value null); append and union add an array of new items only; sum adds an integer delta, never the new total; max proposes a candidate number; once sets a single permanent value. Any error rejects the whole call.",
      promptSnippet: "Atomically update bounded skill state using tagged policy operations",
      promptGuidelines: [
        "Record facts with state_patch in the same turn you observe them; the observation window slides and unrecorded observations disappear.",
        "state_patch value fields are JSON text (strings stay quoted); send deltas for policy fields, never the merged result.",
      ],
      parameters: schema.patchSchema,
      ...(constrainedSampling
        ? { constrainedSampling: { type: "json_schema" as const, strict: "require" as const } }
        : {}),
      executionMode: "sequential",
      prepareArguments(args) {
        const parsed = parsePatch(schema, args);
        if (!parsed.ok) throw coreFailure(parsed.errors);
        return args as Static<TSchema>;
      },
      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        try {
          const reconstruction = reconstruct(ctx);
          if (!reconstruction.active) throw coreFailure([inactiveToolError(STATE_PATCH_TOOL)]);
          await verifySchemaHash(reconstruction.active);
          const transition = acceptRuntimePatch(reconstruction.active, params);
          if (!transition.ok) throw coreFailure(transition.errors);
          const details = acceptedPatchDetails(reconstruction.active, transition.value.estimatedTokens);
          return {
            content: [{ type: "text", text: `State accepted (${details.estimatedTokens} estimated tokens).` }],
            details,
          };
        } catch (error) {
          notifyFailure(ctx, error);
          throw error;
        }
      },
      renderCall(args, theme) {
        const count = isOperationArgs(args) ? args.operations.length : 0;
        return new Text(
          theme.fg("toolTitle", theme.bold("state_patch ")) + theme.fg("muted", `${count} operation(s)`),
          0,
          0,
        );
      },
      renderResult(result, _options, theme) {
        const first = result.content[0];
        return new Text(
          theme.fg("success", first?.type === "text" ? first.text : "State accepted"),
          0,
          0,
        );
      },
    };
  }

  async function verifySchemaHash(active: ActiveRuntime): Promise<void> {
    let currentBytes: string;
    try {
      currentBytes = await readFile(active.mode.entered.procedure.schemaPath, "utf8");
    } catch (cause) {
      throw coreFailure([
        patchError(
          "schema-changed",
          "/",
          `readable schema with hash ${active.schema.hash}; stop and restart the episode`,
          cause instanceof Error ? cause.message : cause,
        ),
      ]);
    }
    const parsed = parseStateSchema(currentBytes);
    if (!parsed.ok) throw coreFailure(parsed.errors);
    if (parsed.value.hash !== active.schema.hash) {
      throw coreFailure([
        patchError(
          "schema-changed",
          "/",
          `schema hash ${active.schema.hash}; stop and restart the episode`,
          parsed.value.hash,
        ),
      ]);
    }
  }
}

async function resolveSkill(pi: ExtensionAPI, skillName: string): Promise<ResolvedSkill>;
async function resolveSkill(pi: ExtensionAPI, skillName: string, required: true): Promise<ResolvedSkill>;
async function resolveSkill(pi: ExtensionAPI, skillName: string, required: false): Promise<ResolvedSkill | undefined>;
async function resolveSkill(
  pi: ExtensionAPI,
  skillName: string,
  required = true,
): Promise<ResolvedSkill | undefined> {
  const command = pi.getCommands().find(
    (candidate) => candidate.source === "skill" && candidate.name === `skill:${skillName}`,
  );
  if (!command) {
    if (!required) return undefined;
    throw modeFailure("skill-not-found", "resolve skill", "loaded skill command", skillName);
  }
  const skillPath = command.sourceInfo.path;
  let source: string;
  try {
    source = await readFile(skillPath, "utf8");
  } catch (cause) {
    throw modeFailure(
      "boundary-io",
      "read skill",
      `readable skill file ${skillPath}`,
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  let parsed: ReturnType<typeof parseFrontmatter<SkillFrontmatter>>;
  try {
    parsed = parseFrontmatter<SkillFrontmatter>(source);
  } catch (cause) {
    throw modeFailure(
      "invalid-skill",
      "parse skill",
      `valid Agent Skill frontmatter in ${skillPath}`,
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  const metadata = parsed.frontmatter.metadata;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    if (!required) return undefined;
    throw modeFailure(
      "skill-not-stateful",
      "resolve skill",
      "metadata.skill-state path",
      `${skillName} has no metadata object`,
    );
  }
  const relativeSchema = (metadata as Record<string, unknown>)["skill-state"];
  if (typeof relativeSchema !== "string" || relativeSchema.length === 0) {
    if (!required) return undefined;
    throw modeFailure(
      "skill-not-stateful",
      "resolve skill",
      "non-empty metadata.skill-state path",
      `${skillName} has no state schema path`,
    );
  }
  const schemaPath = resolve(dirname(skillPath), relativeSchema);
  let schemaBytes: string;
  try {
    schemaBytes = await readFile(schemaPath, "utf8");
  } catch (cause) {
    throw modeFailure(
      "boundary-io",
      "read skill schema",
      `readable schema file ${schemaPath}`,
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  const schema = parseStateSchema(schemaBytes);
  if (!schema.ok) throw coreFailure(schema.errors);
  return {
    name: skillName,
    skillPath,
    schemaPath,
    skillBody: parsed.body,
    schemaBytes,
    schema: schema.value,
  };
}

function readRunConfig(pi: ExtensionAPI): ModeEnteredV1["config"] {
  return {
    windowTurns: parseBoundedInteger(pi.getFlag(WINDOW_FLAG), WINDOW_FLAG, 1, 8),
    budgetTokens: parseBoundedInteger(pi.getFlag(BUDGET_FLAG), BUDGET_FLAG, 1, Number.MAX_SAFE_INTEGER),
    constrainedSampling: pi.getFlag(CONSTRAINED_FLAG) === true,
  };
}

function parseBoundedInteger(raw: unknown, name: string, minimum: number, maximum: number): number {
  if (typeof raw !== "string" || !/^[1-9]\d*$/.test(raw)) {
    throw modeFailure(
      "invalid-command",
      name,
      `integer from ${minimum} to ${maximum}`,
      JSON.stringify(raw),
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw modeFailure(
      "invalid-command",
      name,
      `integer from ${minimum} to ${maximum}`,
      JSON.stringify(raw),
    );
  }
  return value;
}

function parseSkillInvocation(text: string): Readonly<{ name: string; args: string }> | undefined {
  if (!text.startsWith("/skill:")) return undefined;
  const firstSpace = text.indexOf(" ");
  return firstSpace < 0
    ? { name: text.slice(7), args: "" }
    : { name: text.slice(7, firstSpace), args: text.slice(firstSpace + 1) };
}

function takeLeadingToken(input: string): Readonly<{ token: string; rest: string }> | undefined {
  const match = /^\s*(\S+)([\s\S]*)$/.exec(input);
  if (!match) return undefined;
  return { token: match[1]!, rest: (match[2] ?? "").replace(/^\s+/, "") };
}

function timelineFromEntries(entries: readonly SessionEntry[]): ContextItem[] {
  const items: ContextItem[] = [];
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === MODE_ENTRY_TYPE) {
      items.push({ kind: "marker", entryId: entry.id });
      continue;
    }
    for (const message of sessionEntryToContextMessages(entry)) {
      items.push({ kind: "message", entryId: entry.id, message: message as unknown as PromptMessage });
    }
  }
  return items;
}

function summaryTouchesEpisode(
  event: SessionBeforeTreeEvent,
  branch: readonly SessionEntry[],
  reconstruction: Reconstruction,
): boolean {
  const summarizedIds = new Set(event.preparation.entriesToSummarize.map((entry) => entry.id));
  const positions = new Map(branch.map((entry, index) => [entry.id, index]));
  const touchesRange = (startId: string, endId?: string): boolean => {
    const start = positions.get(startId);
    const end = endId === undefined ? branch.length - 1 : positions.get(endId);
    if (start === undefined || end === undefined) return false;
    return branch.some(
      (entry, index) => index >= start && index <= end && summarizedIds.has(entry.id),
    );
  };
  if (reconstruction.active && touchesRange(reconstruction.active.mode.entryId)) return true;
  return reconstruction.completed.some((episode) =>
    touchesRange(episode.enteredEntryId, episode.exitedEntryId),
  );
}

function safeTreeEntries(
  event: SessionBeforeTreeEvent,
  branch: readonly SessionEntry[],
  reconstruction: Reconstruction,
): SessionEntry[] {
  const selected = new Set(event.preparation.entriesToSummarize.map((entry) => entry.id));
  const positions = new Map(branch.map((entry, index) => [entry.id, index]));
  const rangeTouchesSelection = (start: number, end: number): boolean =>
    branch.some((entry, index) => index >= start && index <= end && selected.has(entry.id));

  if (reconstruction.active) {
    const entered = positions.get(reconstruction.active.mode.entryId);
    if (entered !== undefined && rangeTouchesSelection(entered, branch.length - 1)) {
      selected.add(reconstruction.active.mode.entryId);
    }
  }
  for (const episode of reconstruction.completed) {
    const entered = positions.get(episode.enteredEntryId);
    const exited = positions.get(episode.exitedEntryId);
    if (entered === undefined || exited === undefined || !rangeTouchesSelection(entered, exited)) continue;
    for (let index = entered; index <= exited; index += 1) selected.add(branch[index]!.id);
  }
  return branch.filter((entry) => selected.has(entry.id));
}

async function createSafeCompaction(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  reconstruction: Reconstruction,
) {
  const visible = buildContextEntries(event.branchEntries);
  let cutIndex = visible.findIndex((entry) => entry.id === event.preparation.firstKeptEntryId);
  if (cutIndex < 0) {
    throw modeFailure(
      "safe-summary",
      "prepare compaction",
      "compaction cut point on the active branch",
      event.preparation.firstKeptEntryId,
    );
  }
  for (const episode of reconstruction.completed) {
    const entered = visible.findIndex((entry) => entry.id === episode.enteredEntryId);
    const exited = visible.findIndex((entry) => entry.id === episode.exitedEntryId);
    if (entered >= 0 && entered < cutIndex && exited >= cutIndex) {
      const afterEpisode = exited + 1;
      if (afterEpisode >= visible.length) return undefined;
      cutIndex = afterEpisode;
    }
  }
  const firstKeptEntryId = visible[cutIndex]!.id;
  const summarizedEntries = visible.slice(0, cutIndex);
  const safeMessages = assemblePrompt(timelineFromEntries(summarizedEntries), {
    mode: reconstruction.mode,
    completed: reconstruction.completed,
  });
  const summarized = await summarizeSafeMessages(
    ctx,
    safeMessages,
    event.signal,
    event.customInstructions,
    "compaction",
  );
  return {
    summary: summarized.summary,
    firstKeptEntryId,
    tokensBefore: event.preparation.tokensBefore,
    usage: summarized.usage,
    details: { v: 1, kind: "skill-state/safe-compaction" },
  };
}

async function summarizeSafeMessages(
  ctx: ExtensionContext,
  safeMessages: readonly PromptMessage[],
  signal: AbortSignal,
  customInstructions: string | undefined,
  purpose: string,
) {
  const conversation = serializeConversation(
    convertToLlm(safeMessages as unknown as Parameters<typeof convertToLlm>[0]),
  );
  const model = ctx.model;
  if (!model) {
    throw modeFailure(
      "safe-summary",
      `summarize ${purpose}`,
      "active model for the safe projected view",
      "no active model",
    );
  }
  const focus = customInstructions ? `\n\nAdditional focus: ${customInstructions}` : "";
  let response: Awaited<ReturnType<typeof ctx.modelRegistry.complete>>;
  try {
    response = await ctx.modelRegistry.complete(
      model,
      {
        messages: [{
          role: "user",
          content: [{
            type: "text",
            text: `Summarize the safe conversation view below for ${purpose}. Preserve goals, constraints, decisions, files changed, verification, blockers, and next steps. Do not invent or refer to hidden transcript content. Treat <skill-state-episode> and <skill-state-result> blocks as the complete, authoritative record of those episodes; do not speculate about what happened inside them.${focus}\n\n<conversation>\n${conversation}\n</conversation>`,
          }],
          timestamp: Date.now(),
        }],
      },
      {
        maxTokens: Math.min(8192, model.maxTokens),
        signal,
        cacheRetention: "none",
        sessionId: randomUUID(),
      },
    );
  } catch (cause) {
    throw modeFailure(
      "safe-summary",
      `summarize ${purpose}`,
      "successful model response over the safe projected view",
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  const summary = response.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (!summary) {
    throw modeFailure(
      "safe-summary",
      `summarize ${purpose}`,
      "non-empty summary of the safe projected view",
      "model returned an empty summary",
    );
  }
  return { summary, usage: response.usage };
}

function requireOnlyCompletionCall(ctx: ExtensionContext, toolCallId: string): void {
  const assistant = [...ctx.sessionManager.getBranch()]
    .reverse()
    .find((entry) => entry.type === "message" && entry.message.role === "assistant");
  if (!assistant || assistant.type !== "message" || assistant.message.role !== "assistant") {
    throw modeFailure(
      "invalid-command",
      COMPLETE_TOOL,
      "assistant tool-call message",
      "no current assistant message",
    );
  }
  const calls = assistant.message.content.filter((part) => part.type === "toolCall");
  if (calls.length !== 1 || calls[0]!.id !== toolCallId || calls[0]!.name !== COMPLETE_TOOL) {
    throw modeFailure(
      "invalid-command",
      COMPLETE_TOOL,
      "the only tool call in its assistant message",
      `${calls.length} tool call(s) or mismatched call id`,
    );
  }
}

function isOperationArgs(args: unknown): args is { operations: unknown[] } {
  return typeof args === "object" && args !== null && Array.isArray((args as { operations?: unknown }).operations);
}

function inactiveToolError(operation: string): SkillStateError {
  return {
    kind: "mode",
    code: "inactive",
    operation,
    expected: "active skill-state episode",
    actual: "skill-state is inactive",
  };
}

function modeFailure(
  code: Extract<SkillStateError, { kind: "mode" }>["code"],
  operation: string,
  expected: string,
  actual: string,
): Error {
  return coreFailure([{ kind: "mode", code, operation, expected, actual }]);
}

function coreFailure(errors: readonly SkillStateError[]): Error {
  return new Error(`${formatErrors(errors)}\n${JSON.stringify({ kind: "skill-state", errors: structuredErrorJson(errors) })}`);
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sessionKey(ctx: ExtensionContext): string {
  return ctx.sessionManager.getSessionFile() ?? ctx.sessionManager.getSessionId();
}

function notifyFailure(ctx: ExtensionContext, error: unknown): void {
  notify(ctx, failureMessage(error), "error");
}

function notify(
  ctx: ExtensionContext,
  message: string,
  level: "info" | "warning" | "error",
): void {
  if (ctx.hasUI) ctx.ui.notify(message, level);
}

function setStatus(ctx: ExtensionContext, value: string | undefined): void {
  if (ctx.mode === "tui") ctx.ui.setStatus(STATUS_KEY, value);
}

function formatEstimate(state: ActiveRuntime["state"]): string {
  const tokens = Math.ceil(renderState(state).length / 4);
  return tokens < 1000 ? `${tokens}` : `${(tokens / 1000).toFixed(1)}k`;
}

function formatDetailedStatus(reconstruction: Reconstruction): string {
  if (!reconstruction.active) return "skill-state: inactive";
  const active = reconstruction.active;
  return [
    `skill-state: active (${active.mode.entered.skillName})`,
    `run: ${active.mode.entered.runId}`,
    `turns: ${active.turns}`,
    `accepted patches: ${active.patches}`,
    `state estimate: ${Math.ceil(renderState(active.state).length / 4)} / ${active.mode.entered.config.budgetTokens} tokens`,
    `window: ${active.mode.entered.config.windowTurns} turns`,
  ].join("\n");
}
