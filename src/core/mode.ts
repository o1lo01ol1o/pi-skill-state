import { err, ok, type Result, type SkillStateError } from "./errors.js";
import { isJsonObject } from "./json.js";

export type EntrySource = "command" | "skill-invocation";
export type EpisodeOutcome = "completed" | "stopped";

export interface FrozenProcedure {
  readonly skillPath: string;
  readonly skillBaseDir: string;
  readonly schemaPath: string;
  readonly skillBody: string;
  readonly schemaBytes: string;
  readonly args: string;
}

export interface FrozenRunConfig {
  readonly windowTurns: number;
  readonly budgetTokens: number;
  readonly constrainedSampling: boolean;
}

export interface ModeEnteredV1 {
  readonly v: 1;
  readonly kind: "mode-entered";
  readonly runId: string;
  readonly skillName: string;
  readonly schemaHash: string;
  readonly source: EntrySource;
  readonly enteredAt: number;
  readonly procedure: FrozenProcedure;
  readonly config: FrozenRunConfig;
}

export interface ModeExitedV1 {
  readonly v: 1;
  readonly kind: "mode-exited";
  readonly runId: string;
  readonly schemaHash: string;
  readonly outcome: EpisodeOutcome;
  readonly result: string;
  readonly finalState: string;
  readonly exitedAt: number;
}

export type PersistedModeEntry = ModeEnteredV1 | ModeExitedV1;

declare const modePhaseBrand: unique symbol;

export interface InactiveMode {
  readonly tag: "inactive";
  readonly [modePhaseBrand]: "inactive";
}

export interface ActiveMode {
  readonly tag: "active";
  readonly entryId: string;
  readonly entered: ModeEnteredV1;
  readonly [modePhaseBrand]: "active";
}

export type ModeState = InactiveMode | ActiveMode;

export const inactiveMode = Object.freeze({ tag: "inactive" }) as InactiveMode;

/** Protocol entry consumes the inactive phase; callers must parse raw transition order first. */
export function enterMode(_current: InactiveMode, entryId: string, entered: ModeEnteredV1): ActiveMode {
  return Object.freeze({ tag: "active", entryId, entered }) as ActiveMode;
}

/** Protocol exit consumes the active phase; an inactive caller is a type error. */
export function exitMode(current: ActiveMode, exited: ModeExitedV1): Result<InactiveMode> {
  if (current.entered.runId !== exited.runId) {
    return err({
      kind: "entry",
      code: "entry-consistency",
      path: "/runId",
      expected: current.entered.runId,
      actual: exited.runId,
    });
  }
  if (current.entered.schemaHash !== exited.schemaHash) {
    return err({
      kind: "entry",
      code: "entry-consistency",
      path: "/schemaHash",
      expected: current.entered.schemaHash,
      actual: exited.schemaHash,
    });
  }
  return ok(inactiveMode);
}

export function parseModeEntry(raw: unknown): Result<PersistedModeEntry> {
  if (!isJsonObject(raw)) return entryFailure("/", "versioned mode entry object", raw);
  if (raw.v !== 1) return entryFailure("/v", "entry version 1", raw.v, "entry-version");
  if (raw.kind === "mode-entered") return parseEntered(raw);
  if (raw.kind === "mode-exited") return parseExited(raw);
  return entryFailure("/kind", "mode-entered or mode-exited", raw.kind);
}

function parseEntered(raw: Readonly<Record<string, unknown>>): Result<ModeEnteredV1> {
  const errors: SkillStateError[] = [];
  rejectUnknownFields(
    raw,
    ["v", "kind", "runId", "skillName", "schemaHash", "source", "enteredAt", "procedure", "config"],
    "",
    errors,
  );
  stringField(raw, "runId", errors);
  stringField(raw, "skillName", errors);
  stringField(raw, "schemaHash", errors);
  numberField(raw, "enteredAt", errors);
  if (raw.source !== "command" && raw.source !== "skill-invocation") {
    errors.push(entryError("/source", "command or skill-invocation", raw.source));
  }
  if (!isJsonObject(raw.procedure)) {
    errors.push(entryError("/procedure", "frozen procedure object", raw.procedure));
  } else {
    rejectUnknownFields(
      raw.procedure,
      ["skillPath", "skillBaseDir", "schemaPath", "skillBody", "schemaBytes", "args"],
      "/procedure",
      errors,
    );
    for (const field of ["skillPath", "skillBaseDir", "schemaPath", "skillBody", "schemaBytes", "args"] as const) {
      stringField(raw.procedure, field, errors, "/procedure");
    }
  }
  if (!isJsonObject(raw.config)) {
    errors.push(entryError("/config", "frozen run config object", raw.config));
  } else {
    rejectUnknownFields(
      raw.config,
      ["windowTurns", "budgetTokens", "constrainedSampling"],
      "/config",
      errors,
    );
    const windowTurns = raw.config.windowTurns;
    const budgetTokens = raw.config.budgetTokens;
    if (!Number.isSafeInteger(windowTurns) || (windowTurns as number) < 1 || (windowTurns as number) > 8) {
      errors.push(entryError("/config/windowTurns", "integer from 1 to 8", windowTurns));
    }
    if (!Number.isSafeInteger(budgetTokens) || (budgetTokens as number) < 1) {
      errors.push(entryError("/config/budgetTokens", "positive integer", budgetTokens));
    }
    if (typeof raw.config.constrainedSampling !== "boolean") {
      errors.push(entryError("/config/constrainedSampling", "boolean", raw.config.constrainedSampling));
    }
  }
  if (errors.length > 0) return { ok: false, errors };
  return ok(raw as unknown as ModeEnteredV1);
}

function parseExited(raw: Readonly<Record<string, unknown>>): Result<ModeExitedV1> {
  const errors: SkillStateError[] = [];
  rejectUnknownFields(
    raw,
    ["v", "kind", "runId", "schemaHash", "outcome", "result", "finalState", "exitedAt"],
    "",
    errors,
  );
  stringField(raw, "runId", errors);
  stringField(raw, "schemaHash", errors);
  stringField(raw, "result", errors);
  stringField(raw, "finalState", errors);
  numberField(raw, "exitedAt", errors);
  if (raw.outcome !== "completed" && raw.outcome !== "stopped") {
    errors.push(entryError("/outcome", "completed or stopped", raw.outcome));
  }
  if (errors.length > 0) return { ok: false, errors };
  return ok(raw as unknown as ModeExitedV1);
}

function rejectUnknownFields(
  raw: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  base: string,
  errors: SkillStateError[],
): void {
  const known = new Set(allowed);
  for (const field of Object.keys(raw)) {
    if (!known.has(field)) errors.push(entryError(`${base}/${field}`, "no unknown field in v1 entry", raw[field]));
  }
}

function stringField(
  raw: Readonly<Record<string, unknown>>,
  field: string,
  errors: SkillStateError[],
  base = "",
): void {
  if (typeof raw[field] !== "string") errors.push(entryError(`${base}/${field}`, "string", raw[field]));
}

function numberField(raw: Readonly<Record<string, unknown>>, field: string, errors: SkillStateError[]): void {
  if (typeof raw[field] !== "number" || !Number.isFinite(raw[field])) {
    errors.push(entryError(`/${field}`, "finite number", raw[field]));
  }
}

function entryFailure<T>(
  path: string,
  expected: string,
  actual: unknown,
  code: "entry-shape" | "entry-version" = "entry-shape",
): Result<T> {
  return err(entryError(path, expected, actual, code));
}

function entryError(
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
