import { describeJson, type JsonValue } from "./json.js";

export type SchemaErrorCode =
  | "invalid-json"
  | "schema-shape"
  | "unsupported-schema"
  | "open-object"
  | "missing-default"
  | "invalid-policy"
  | "policy-type"
  | "invalid-default";

export type PatchErrorCode =
  | "schema-mismatch"
  | "once-conflict"
  | "closure"
  | "state-budget"
  | "schema-changed";

export type EntryErrorCode = "entry-shape" | "entry-version" | "entry-consistency";
export type ModeErrorCode =
  | "inactive"
  | "already-active"
  | "skill-not-found"
  | "skill-not-stateful"
  | "invalid-command"
  | "reconstruction";

export type SkillStateError =
  | Readonly<{
      kind: "schema";
      code: SchemaErrorCode;
      path: string;
      expected: string;
      actual: string;
    }>
  | Readonly<{
      kind: "patch";
      code: PatchErrorCode;
      path: string;
      expected: string;
      actual: string;
      policy?: string;
    }>
  | Readonly<{
      kind: "entry";
      code: EntryErrorCode;
      path: string;
      expected: string;
      actual: string;
    }>
  | Readonly<{
      kind: "mode";
      code: ModeErrorCode;
      operation: string;
      expected: string;
      actual: string;
    }>;

export type Result<T> =
  | Readonly<{ ok: true; value: T }>
  | Readonly<{ ok: false; errors: readonly SkillStateError[] }>;

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T = never>(...errors: readonly SkillStateError[]): Result<T> {
  return { ok: false, errors };
}

export function schemaError(
  code: SchemaErrorCode,
  path: string,
  expected: string,
  actual: unknown,
): SkillStateError {
  return { kind: "schema", code, path, expected, actual: describeActual(actual) };
}

export function patchError(
  code: PatchErrorCode,
  path: string,
  expected: string,
  actual: unknown,
  policy?: string,
): SkillStateError {
  return {
    kind: "patch",
    code,
    path,
    expected,
    actual: describeActual(actual),
    ...(policy === undefined ? {} : { policy }),
  };
}

function describeActual(actual: unknown): string {
  if (
    actual === null ||
    typeof actual === "boolean" ||
    typeof actual === "number" ||
    typeof actual === "string" ||
    Array.isArray(actual) ||
    typeof actual === "object"
  ) {
    const shape = describeJson(actual);
    if (typeof actual === "string") return `${shape} ${JSON.stringify(actual)}`;
    if (typeof actual === "number" || typeof actual === "boolean" || actual === null) {
      return `${shape} ${String(actual)}`;
    }
    return shape;
  }
  return typeof actual;
}

export function formatError(error: SkillStateError): string {
  if (error.kind === "mode") {
    return `${error.operation}: expected ${error.expected}; ${error.actual}`;
  }
  const policy = error.kind === "patch" && error.policy ? `policy ${error.policy}: ` : "";
  return `${error.path || "/"}: ${policy}expected ${error.expected}; found ${error.actual}`;
}

export function formatErrors(errors: readonly SkillStateError[]): string {
  return errors.map(formatError).join("\n");
}

export function structuredErrorJson(errors: readonly SkillStateError[]): JsonValue {
  return errors.map((error) => ({ ...error })) as JsonValue;
}
