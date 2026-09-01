import { Check } from "typebox/value";
import {
  err,
  ok,
  patchError,
  schemaError,
  type Result,
  type SkillStateError,
} from "./errors.js";
import {
  canonicalizeJson,
  cloneJson,
  freezeJson,
  isJsonObject,
  isJsonValue,
  jsonEqual,
  renderCanonicalJson,
  type JsonObject,
  type JsonScalar,
  type JsonValue,
} from "./json.js";
import {
  canonicalScalarUnion,
  normalizeStateObject,
  type SchemaNode,
  type StateSchema,
  validationErrors,
} from "./schema.js";

declare const stateBrand: unique symbol;
declare const patchBrand: unique symbol;

export type State = Readonly<JsonObject> & { readonly [stateBrand]: true };
export type PatchAction = "lww-set" | "lww-delete" | "append" | "union" | "sum" | "max" | "once";

export interface StateOperation {
  readonly path: string;
  readonly action: PatchAction;
  readonly value: JsonValue;
}

/** A free program of checked operations; composition is concatenation. */
export type Patch = Readonly<{
  readonly operations: readonly StateOperation[];
  readonly [patchBrand]: true;
}>;

export interface PatchBudget {
  readonly maxTokens: number;
}

export interface AcceptedTransition {
  readonly patch: Patch;
  readonly state: State;
  readonly estimatedTokens: number;
}

export function initialState(schema: StateSchema): State {
  return asState(schema.initial);
}

export function emptyPatch(): Patch {
  return asPatch([]);
}

export function composePatches(...patches: readonly Patch[]): Patch {
  return asPatch(patches.flatMap((patch) => patch.operations));
}

export function parseRenderedState(schema: StateSchema, rendered: string): Result<State> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(rendered);
  } catch (cause) {
    return err(
      schemaError(
        "invalid-json",
        "/",
        "canonical JSON state",
        cause instanceof Error ? cause.message : cause,
      ),
    );
  }
  if (!isJsonObject(decoded) || !isJsonValue(decoded)) {
    return err(schemaError("schema-shape", "/", "JSON object state", decoded));
  }
  const errors = [
    ...validationErrors(schema.raw, decoded, "patch", "closure"),
    ...unsafeSumStateErrors(schema.root, decoded),
  ];
  if (errors.length > 0) return { ok: false, errors };
  return ok(asState(normalizeStateObject(schema, decoded)));
}

export function renderState(state: State): string {
  return renderCanonicalJson(state);
}

export function estimateStateTokens(state: State): number {
  return Math.ceil(renderState(state).length / 4);
}

export function acceptPatch(
  schema: StateSchema,
  current: State,
  raw: unknown,
  budget: PatchBudget,
): Result<AcceptedTransition> {
  const shapeErrors = validationErrors(schema.patchSchema, raw, "patch", "schema-mismatch");
  if (shapeErrors.length > 0) return { ok: false, errors: shapeErrors };
  if (!isJsonObject(raw) || !Array.isArray(raw.operations)) {
    return err(patchError("schema-mismatch", "/", "tagged operation patch", raw));
  }

  const parsed = parseOperations(schema, raw.operations);
  if (!parsed.ok) return parsed;
  const next = runOperations(schema, current, parsed.value, budget);
  if (!next.ok) return next;
  return ok({
    patch: asPatch(parsed.value),
    state: next.value.state,
    estimatedTokens: next.value.estimatedTokens,
  });
}

export function applyPatch(
  schema: StateSchema,
  initial: State,
  patch: Patch,
  budget: PatchBudget,
): Result<State> {
  const result = runOperations(schema, initial, patch.operations, budget);
  return result.ok ? ok(result.value.state) : result;
}

function parseOperations(schema: StateSchema, rawOperations: readonly unknown[]): Result<readonly StateOperation[]> {
  const operations: StateOperation[] = [];
  const errors: SkillStateError[] = [];

  rawOperations.forEach((raw, index) => {
    const base = `/operations/${index}`;
    if (!isJsonObject(raw)) {
      errors.push(patchError("schema-mismatch", base, "operation object", raw));
      return;
    }
    const path = raw.path;
    const action = raw.action;
    const encoded = raw.value;
    if (typeof path !== "string" || typeof action !== "string" || typeof encoded !== "string") return;

    const resolved = resolveOperationPath(schema.root, path);
    if (!resolved.ok) {
      errors.push(...resolved.errors.map((error) => ({ ...error, path: `${base}/path` })));
      return;
    }
    if (!isPatchAction(action)) return;
    const allowed = allowedActions(resolved.value.node);
    if (!allowed.includes(action)) {
      const expected = allowed.length > 0
        ? `${allowed.join(" or ")} for ${resolved.value.node.policy} field ${path}`
        : `operations on protected descendant fields of ${path}`;
      errors.push(
        patchError(
          "schema-mismatch",
          `${base}/action`,
          expected,
          action,
          resolved.value.node.policy,
        ),
      );
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(encoded);
    } catch (cause) {
      errors.push(
        patchError(
          "schema-mismatch",
          `${base}/value`,
          "valid JSON payload string",
          cause instanceof Error ? cause.message : cause,
          resolved.value.node.policy,
        ),
      );
      return;
    }
    if (!isJsonValue(value)) {
      errors.push(patchError("schema-mismatch", `${base}/value`, "finite JSON value", value, resolved.value.node.policy));
      return;
    }

    const payloadErrors = validateOperationPayload(resolved.value.node, action, value, base);
    if (payloadErrors.length > 0) {
      errors.push(...payloadErrors);
      return;
    }
    operations.push({ path, action, value: canonicalizeJson(value) });
  });

  return errors.length > 0 ? { ok: false, errors } : ok(operations);
}

function validateOperationPayload(
  node: SchemaNode,
  action: PatchAction,
  value: JsonValue,
  base: string,
): SkillStateError[] {
  const path = `${base}/value`;
  switch (action) {
    case "lww-delete":
      return value === null ? [] : [patchError("schema-mismatch", path, "JSON null for deletion", value, node.policy)];
    case "lww-set":
    case "once":
      return Check(node.raw, value)
        ? []
        : validationErrors(node.raw, value, "patch", "schema-mismatch").map((error) => ({
            ...error,
            path: error.kind === "patch" && error.path !== "/" ? `${path}${error.path}` : path,
          }));
    case "append":
    case "union":
      if (!Array.isArray(value)) return [patchError("schema-mismatch", path, "JSON array delta", value, node.policy)];
      if (!node.items) return [patchError("schema-mismatch", path, "array item schema", value, node.policy)];
      return value.flatMap((item, itemIndex) =>
        Check(node.items!.raw, item)
          ? []
          : [patchError("schema-mismatch", `${path}/${itemIndex}`, "item matching the state schema", item, node.policy)],
      );
    case "sum":
      return typeof value === "number" && Number.isSafeInteger(value)
        ? []
        : [patchError("schema-mismatch", path, "safe integer delta", value, node.policy)];
    case "max":
      return typeof value === "number" && Number.isFinite(value)
        ? []
        : [patchError("schema-mismatch", path, "finite number candidate", value, node.policy)];
  }
}

function runOperations(
  schema: StateSchema,
  current: State,
  operations: readonly StateOperation[],
  budget: PatchBudget,
): Result<Readonly<{ state: State; estimatedTokens: number }>> {
  let candidate: JsonObject = cloneJson(current);
  const guardErrors: SkillStateError[] = [];

  for (const operation of operations) {
    const resolved = resolveOperationPath(schema.root, operation.path);
    if (!resolved.ok) return resolved;
    const updated = updateAtPath(schema.root, candidate, resolved.value.segments, operation, guardErrors);
    candidate = updated.value;
  }
  if (guardErrors.length > 0) return { ok: false, errors: guardErrors };

  const normalized = normalizeStateObject(schema, candidate);
  const closureErrors = [
    ...validationErrors(schema.raw, normalized, "patch", "closure"),
    ...unsafeSumStateErrors(schema.root, normalized),
  ];
  if (closureErrors.length > 0) return { ok: false, errors: closureErrors };

  const next = asState(normalized);
  const estimatedTokens = estimateStateTokens(next);
  if (estimatedTokens > budget.maxTokens) {
    const heaviest = Object.entries(next)
      .map(([key, value]) => ({ key, chars: renderCanonicalJson(value).length }))
      .sort((left, right) => right.chars - left.chars || left.key.localeCompare(right.key))
      .slice(0, 3)
      .map(({ key, chars }) => `${key}≈${Math.ceil(chars / 4)}t`)
      .join(", ");
    return err(
      patchError(
        "state-budget",
        "/",
        `rendered state at most ${budget.maxTokens} estimated tokens; prune or restructure (${heaviest || "empty"})`,
        `${estimatedTokens} estimated tokens`,
      ),
    );
  }

  return ok({ state: next, estimatedTokens });
}

interface ObjectUpdate {
  readonly value: JsonObject;
  readonly changed: boolean;
}

function updateAtPath(
  node: SchemaNode,
  current: JsonObject,
  segments: readonly string[],
  operation: StateOperation,
  errors: SkillStateError[],
): ObjectUpdate {
  const [head, ...tail] = segments;
  if (!head) return { value: current, changed: false };
  const child = node.properties[head]!;
  const output = Object.create(null) as Record<string, JsonValue>;
  for (const [key, value] of Object.entries(current)) output[key] = cloneJson(value);

  if (tail.length > 0) {
    const prior = output[head];
    const nested = updateAtPath(child, isJsonObject(prior) ? prior : {}, tail, operation, errors);
    if (!nested.changed) return { value: current, changed: false };
    output[head] = nested.value;
    return { value: output, changed: true };
  }

  const present = Object.prototype.hasOwnProperty.call(output, head);
  const prior = output[head];
  let changed = false;
  switch (operation.action) {
    case "lww-set":
      if (!present || prior === undefined || !jsonEqual(prior, operation.value)) {
        output[head] = cloneJson(operation.value);
        changed = true;
      }
      break;
    case "lww-delete":
      if (present) {
        delete output[head];
        changed = true;
      }
      break;
    case "append": {
      const items = operation.value as JsonValue[];
      if (items.length > 0) {
        output[head] = [...(Array.isArray(prior) ? prior.map(cloneJson) : []), ...items.map(cloneJson)];
        changed = true;
      }
      break;
    }
    case "union": {
      const items = operation.value as JsonScalar[];
      if (items.length > 0) {
        const union = canonicalScalarUnion([
          ...(Array.isArray(prior) ? (prior as JsonScalar[]) : []),
          ...items,
        ]);
        if (!Array.isArray(prior) || !jsonEqual(prior, union)) {
          output[head] = union;
          changed = true;
        }
      }
      break;
    }
    case "sum": {
      const delta = operation.value as number;
      if (delta !== 0) {
        const total = (typeof prior === "number" ? prior : 0) + delta;
        if (!Number.isSafeInteger(total)) {
          errors.push(patchError("closure", operation.path, "safe integer sum", total, "sum"));
        } else {
          output[head] = total;
          changed = true;
        }
      }
      break;
    }
    case "max": {
      const candidate = operation.value as number;
      if (typeof prior !== "number" || candidate > prior) {
        output[head] = candidate;
        changed = true;
      }
      break;
    }
    case "once":
      if (!present) {
        output[head] = cloneJson(operation.value);
        changed = true;
      } else if (prior !== undefined && !jsonEqual(prior, operation.value)) {
        errors.push(
          patchError(
            "once-conflict",
            operation.path,
            `the existing write-once value ${renderCanonicalJson(prior)}`,
            operation.value,
            "once",
          ),
        );
      }
      break;
  }
  return changed ? { value: output, changed: true } : { value: current, changed: false };
}

function resolveOperationPath(
  root: SchemaNode,
  path: string,
): Result<Readonly<{ node: SchemaNode; segments: readonly string[] }>> {
  const segments = decodePointer(path);
  if (!segments || segments.length === 0) {
    return err(patchError("schema-mismatch", path || "/", "RFC 6901 pointer to a state field", path));
  }
  let node = root;
  for (let index = 0; index < segments.length; index += 1) {
    if (node.type !== "object") {
      return err(patchError("schema-mismatch", path, "path through lww object fields only", path));
    }
    const child = node.properties[segments[index]!];
    if (!child) return err(patchError("schema-mismatch", path, "known state field path", path));
    node = child;
    if (index < segments.length - 1 && (node.policy !== "lww" || node.type !== "object")) {
      return err(patchError("schema-mismatch", path, "path not descending through a policy field", path, node.policy));
    }
  }
  return ok({ node, segments });
}

function decodePointer(path: string): string[] | undefined {
  if (!path.startsWith("/") || /~(?:[^01]|$)/.test(path)) return undefined;
  return path
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function allowedActions(node: SchemaNode): readonly PatchAction[] {
  if (node.policy !== "lww") return [node.policy];
  if (node.type === "object" && hasProtectedDescendant(node)) return [];
  return ["lww-set", "lww-delete"];
}

function hasProtectedDescendant(node: SchemaNode): boolean {
  return Object.values(node.properties).some(
    (child) => child.policy !== "lww" || hasProtectedDescendant(child),
  );
}

function isPatchAction(value: string): value is PatchAction {
  return ["lww-set", "lww-delete", "append", "union", "sum", "max", "once"].includes(value);
}

function unsafeSumStateErrors(node: SchemaNode, value: JsonValue): SkillStateError[] {
  if (node.policy === "sum" && (typeof value !== "number" || !Number.isSafeInteger(value))) {
    return [patchError("closure", node.path, "safe integer state for sum policy", value, "sum")];
  }
  if (node.type === "object" && isJsonObject(value)) {
    return Object.entries(value).flatMap(([name, childValue]) => {
      const child = node.properties[name];
      return child ? unsafeSumStateErrors(child, childValue) : [];
    });
  }
  if (node.type === "array" && Array.isArray(value) && node.items) {
    return value.flatMap((item) => unsafeSumStateErrors(node.items!, item));
  }
  return [];
}

function asState(value: JsonObject): State {
  return freezeJson(cloneJson(value)) as State;
}

function asPatch(operations: readonly StateOperation[]): Patch {
  const frozen = Object.freeze(
    operations.map((operation) =>
      Object.freeze({ ...operation, value: freezeJson(cloneJson(operation.value)) }),
    ),
  );
  return Object.freeze({ operations: frozen }) as Patch;
}

export function stateSatisfiesSchema(schema: StateSchema, state: State): boolean {
  return Check(schema.raw, state) && unsafeSumStateErrors(schema.root, state).length === 0;
}
