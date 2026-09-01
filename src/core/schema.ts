import { createHash } from "node:crypto";
import type { TSchema } from "typebox";
import { Check, Errors as ValueErrors } from "typebox/value";
import {
  err,
  ok,
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
  renderCanonicalJson,
  type JsonObject,
  type JsonScalar,
  type JsonValue,
} from "./json.js";

export type MergePolicy = "lww" | "append" | "union" | "sum" | "max" | "once";
export type JsonSchemaType = "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";

export interface SchemaNode {
  readonly path: string;
  readonly type: JsonSchemaType;
  readonly policy: MergePolicy;
  readonly raw: JsonObject;
  readonly properties: Readonly<Record<string, SchemaNode>>;
  readonly required: ReadonlySet<string>;
  readonly items?: SchemaNode;
}

export interface StateSchema {
  readonly raw: JsonObject;
  readonly root: SchemaNode;
  readonly patchSchema: TSchema;
  readonly initial: JsonObject;
  readonly hash: string;
  readonly policyNotes: readonly Readonly<{ path: string; policy: MergePolicy }>[];
}

const SUPPORTED_TYPES = new Set<JsonSchemaType>([
  "object",
  "array",
  "string",
  "number",
  "integer",
  "boolean",
  "null",
]);
const POLICIES = new Set<MergePolicy>(["lww", "append", "union", "sum", "max", "once"]);

export function parseStateSchema(bytes: string): Result<StateSchema> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(bytes);
  } catch (cause) {
    return err(
      schemaError(
        "invalid-json",
        "/",
        "valid JSON object schema",
        cause instanceof Error ? cause.message : cause,
      ),
    );
  }

  if (!isJsonObject(decoded) || !isJsonValue(decoded)) {
    return err(schemaError("schema-shape", "/", "JSON object schema", decoded));
  }

  const errors: SkillStateError[] = [];
  const root = parseNode(decoded, "", true, errors);
  if (!root || errors.length > 0) return { ok: false, errors };

  const withDefaults = applyDefaults(root, {});
  if (!isJsonObject(withDefaults)) {
    return err(schemaError("invalid-default", "/", "object initial state", withDefaults));
  }

  const initialErrors = validationErrors(decoded as TSchema, withDefaults, "schema", "invalid-default");
  if (initialErrors.length > 0) return { ok: false, errors: initialErrors };

  const canonicalInitial = canonicalizePolicyValues(root, withDefaults);
  if (!isJsonObject(canonicalInitial)) {
    return err(schemaError("invalid-default", "/", "object initial state", canonicalInitial));
  }
  const safeSumErrors = unsafeSumDefaultErrors(root, canonicalInitial);
  if (safeSumErrors.length > 0) return { ok: false, errors: safeSumErrors };
  const normalizedInitial = freezeJson(canonicalInitial);
  const raw = freezeJson(cloneJson(decoded));
  const policyNotes = collectPolicyNotes(root);
  const patchSchema = freezeJson(operationPatchSchema()) as TSchema;
  const hash = createHash("sha256").update(renderCanonicalJson(raw)).digest("hex");

  return ok({
    raw,
    root,
    patchSchema,
    initial: normalizedInitial,
    hash,
    policyNotes,
  });
}

function parseNode(
  raw: JsonObject,
  path: string,
  isRoot: boolean,
  errors: SkillStateError[],
): SchemaNode | undefined {
  const rawType = raw.type;
  if (typeof rawType !== "string" || !SUPPORTED_TYPES.has(rawType as JsonSchemaType)) {
    errors.push(
      schemaError(
        "unsupported-schema",
        pointer(path, "type"),
        "one of object, array, string, number, integer, boolean, null",
        rawType,
      ),
    );
    return undefined;
  }
  const type = rawType as JsonSchemaType;
  checkSupportedKeywords(raw, type, path, isRoot, errors);
  const policy = parsePolicy(raw, path, isRoot, errors);

  if (raw.default !== undefined && !isJsonValue(raw.default)) {
    errors.push(schemaError("invalid-default", pointer(path, "default"), "JSON value", raw.default));
  }

  let properties: Record<string, SchemaNode> = Object.create(null) as Record<string, SchemaNode>;
  let required = new Set<string>();
  let items: SchemaNode | undefined;

  if (type === "object") {
    if (raw.additionalProperties !== false) {
      errors.push(schemaError("open-object", pointer(path, "additionalProperties"), "false", raw.additionalProperties));
    }
    if (raw.properties !== undefined && !isJsonObject(raw.properties)) {
      errors.push(schemaError("schema-shape", pointer(path, "properties"), "object", raw.properties));
    }
    if (raw.required !== undefined) {
      if (!Array.isArray(raw.required) || raw.required.some((name) => typeof name !== "string")) {
        errors.push(schemaError("schema-shape", pointer(path, "required"), "array of property names", raw.required));
      } else {
        const requiredNames = raw.required as string[];
        required = new Set(requiredNames);
        if (required.size !== requiredNames.length) {
          errors.push(schemaError("schema-shape", pointer(path, "required"), "unique property names", raw.required));
        }
      }
    }

    const rawProperties = isJsonObject(raw.properties) ? raw.properties : {};
    for (const name of [...required].sort()) {
      if (!Object.prototype.hasOwnProperty.call(rawProperties, name)) {
        errors.push(
          schemaError("schema-shape", pointer(path, "required"), `declared property ${JSON.stringify(name)}`, name),
        );
      }
    }

    for (const [name, propertySchema] of Object.entries(rawProperties)) {
      if (!isJsonObject(propertySchema)) {
        errors.push(schemaError("schema-shape", pointer(pointer(path, "properties"), name), "schema object", propertySchema));
        continue;
      }
      const child = parseNode(propertySchema, pointer(path, name), false, errors);
      if (child) properties[name] = child;
    }
  } else if (type === "array") {
    if (!isJsonObject(raw.items)) {
      errors.push(schemaError("schema-shape", pointer(path, "items"), "single item schema", raw.items));
    } else {
      items = parseNode(raw.items, pointer(path, "[]"), false, errors);
    }
  }

  checkPolicyCompatibility(policy, type, items, path, errors);

  return {
    path: path || "/",
    type,
    policy,
    raw,
    properties: Object.freeze(properties),
    required,
    ...(items ? { items } : {}),
  };
}

function checkSupportedKeywords(
  raw: JsonObject,
  type: JsonSchemaType,
  path: string,
  isRoot: boolean,
  errors: SkillStateError[],
): void {
  const common = new Set(["type", "title", "description", "default", "enum", "const", "x-skill-state"]);
  const byType: Record<JsonSchemaType, readonly string[]> = {
    object: ["properties", "required", "additionalProperties", "minProperties", "maxProperties"],
    array: ["items", "minItems", "maxItems", "uniqueItems"],
    string: ["minLength", "maxLength", "pattern"],
    number: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"],
    integer: ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"],
    boolean: [],
    null: [],
  };
  const allowed = new Set([...common, ...byType[type], ...(isRoot ? ["$schema", "$id"] : [])]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push(
        schemaError(
          "unsupported-schema",
          pointer(path, key),
          `supported ${type} schema keyword`,
          key,
        ),
      );
    }
  }

  for (const key of ["minLength", "maxLength", "minItems", "maxItems", "minProperties", "maxProperties"] as const) {
    const value = raw[key];
    if (value !== undefined && (!Number.isSafeInteger(value) || (value as number) < 0)) {
      errors.push(schemaError("schema-shape", pointer(path, key), "non-negative safe integer", value));
    }
  }
  for (const key of ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"] as const) {
    const value = raw[key];
    if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value))) {
      errors.push(schemaError("schema-shape", pointer(path, key), "finite number", value));
    }
  }
  if (typeof raw.multipleOf === "number" && raw.multipleOf <= 0) {
    errors.push(schemaError("schema-shape", pointer(path, "multipleOf"), "number greater than zero", raw.multipleOf));
  }
  if (raw.uniqueItems !== undefined && typeof raw.uniqueItems !== "boolean") {
    errors.push(schemaError("schema-shape", pointer(path, "uniqueItems"), "boolean", raw.uniqueItems));
  }
  if (raw.pattern !== undefined) {
    if (typeof raw.pattern !== "string") {
      errors.push(schemaError("schema-shape", pointer(path, "pattern"), "regular-expression string", raw.pattern));
    } else {
      try {
        new RegExp(raw.pattern);
      } catch {
        errors.push(schemaError("schema-shape", pointer(path, "pattern"), "valid regular expression", raw.pattern));
      }
    }
  }
  if (raw.enum !== undefined && (!Array.isArray(raw.enum) || raw.enum.length === 0)) {
    errors.push(schemaError("schema-shape", pointer(path, "enum"), "non-empty JSON array", raw.enum));
  } else if (Array.isArray(raw.enum)) {
    const encodings = raw.enum.filter(isJsonValue).map((value) => renderCanonicalJson(value));
    if (encodings.length !== raw.enum.length || new Set(encodings).size !== encodings.length) {
      errors.push(schemaError("schema-shape", pointer(path, "enum"), "unique JSON values", raw.enum));
    }
  }
  if (raw.const !== undefined && !isJsonValue(raw.const)) {
    errors.push(schemaError("schema-shape", pointer(path, "const"), "JSON value", raw.const));
  }
}

function parsePolicy(
  raw: JsonObject,
  path: string,
  isRoot: boolean,
  errors: SkillStateError[],
): MergePolicy {
  const annotation = raw["x-skill-state"];
  if (annotation === undefined) return "lww";
  if (isRoot) {
    errors.push(schemaError("invalid-policy", pointer(path, "x-skill-state"), "no root merge annotation", annotation));
    return "lww";
  }
  if (!isJsonObject(annotation) || typeof annotation.merge !== "string" || !POLICIES.has(annotation.merge as MergePolicy)) {
    errors.push(
      schemaError(
        "invalid-policy",
        pointer(path, "x-skill-state"),
        "{ merge: lww | append | union | sum | max | once }",
        annotation,
      ),
    );
    return "lww";
  }
  const unknown = Object.keys(annotation).filter((key) => key !== "merge");
  for (const key of unknown) {
    errors.push(
      schemaError(
        "invalid-policy",
        pointer(pointer(path, "x-skill-state"), key),
        "only the merge annotation key",
        key,
      ),
    );
  }
  return annotation.merge as MergePolicy;
}

function checkPolicyCompatibility(
  policy: MergePolicy,
  type: JsonSchemaType,
  items: SchemaNode | undefined,
  path: string,
  errors: SkillStateError[],
): void {
  if ((policy === "append" || policy === "union") && type !== "array") {
    errors.push(schemaError("policy-type", path || "/", `${policy} policy on an array`, type));
  }
  if (policy === "sum" && type !== "integer") {
    errors.push(schemaError("policy-type", path || "/", "sum policy on a safe-integer state field", type));
  }
  if (policy === "max" && type !== "number" && type !== "integer") {
    errors.push(schemaError("policy-type", path || "/", "max policy on a number", type));
  }
  if (policy === "union" && items && (items.type === "object" || items.type === "array")) {
    errors.push(schemaError("policy-type", pointer(path, "items"), "scalar items for union policy", items.type));
  }
}

function applyDefaults(node: SchemaNode, input: JsonValue): JsonValue {
  if (node.type === "object") {
    const source = isJsonObject(input) ? input : {};
    const output = Object.create(null) as Record<string, JsonValue>;
    for (const [name, child] of Object.entries(node.properties)) {
      if (Object.prototype.hasOwnProperty.call(source, name)) {
        output[name] = applyDefaults(child, cloneJson(source[name]!));
      } else if (Object.prototype.hasOwnProperty.call(child.raw, "default") && isJsonValue(child.raw.default)) {
        output[name] = applyDefaults(child, cloneJson(child.raw.default));
      } else if (node.required.has(name) && child.type === "object") {
        output[name] = applyDefaults(child, {});
      }
    }
    return output;
  }
  if (node.type === "array" && Array.isArray(input) && node.items) {
    return input.map((item) => applyDefaults(node.items!, cloneJson(item)));
  }
  return cloneJson(input);
}

function canonicalizePolicyValues(node: SchemaNode, value: JsonValue): JsonValue {
  if (node.type === "object" && isJsonObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((name) => {
          const child = node.properties[name];
          return [name, child ? canonicalizePolicyValues(child, value[name]!) : canonicalizeJson(value[name]!)];
        }),
    );
  }
  if (node.type === "array" && Array.isArray(value)) {
    const normalized = node.items
      ? value.map((item) => canonicalizePolicyValues(node.items!, item))
      : value.map((item) => canonicalizeJson(item));
    if (node.policy === "union") return canonicalScalarUnion(normalized as JsonScalar[]);
    return normalized;
  }
  return canonicalizeJson(value);
}

function unsafeSumDefaultErrors(node: SchemaNode, value: JsonValue): SkillStateError[] {
  if (node.policy === "sum" && (typeof value !== "number" || !Number.isSafeInteger(value))) {
    return [schemaError("invalid-default", node.path, "safe integer default for sum policy", value)];
  }
  if (node.type === "object" && isJsonObject(value)) {
    return Object.entries(value).flatMap(([name, childValue]) => {
      const child = node.properties[name];
      return child ? unsafeSumDefaultErrors(child, childValue) : [];
    });
  }
  if (node.type === "array" && Array.isArray(value) && node.items) {
    return value.flatMap((item) => unsafeSumDefaultErrors(node.items!, item));
  }
  return [];
}

export function normalizeStateObject(schema: StateSchema, value: JsonObject): JsonObject {
  const normalized = canonicalizePolicyValues(schema.root, value);
  if (!isJsonObject(normalized)) throw new Error("State schema root normalization did not produce an object");
  return normalized;
}

export function canonicalScalarUnion(values: readonly JsonScalar[]): JsonScalar[] {
  const byEncoding = new Map<string, JsonScalar>();
  for (const value of values) byEncoding.set(renderCanonicalJson(value), value);
  return [...byEncoding.entries()]
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([, value]) => value);
}

function operationPatchSchema(): JsonObject {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      operations: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            path: { type: "string", description: "RFC 6901 pointer to a state field" },
            action: {
              type: "string",
              enum: ["lww-set", "lww-delete", "append", "union", "sum", "max", "once"],
            },
            value: {
              type: "string",
              description: "JSON-encoded operation payload; lww-delete requires null",
            },
          },
          required: ["path", "action", "value"],
        },
      },
    },
    required: ["operations"],
  };
}

function collectPolicyNotes(root: SchemaNode): readonly Readonly<{ path: string; policy: MergePolicy }>[] {
  const notes: Array<Readonly<{ path: string; policy: MergePolicy }>> = [];
  const visit = (node: SchemaNode): void => {
    for (const child of Object.values(node.properties)) {
      notes.push({ path: child.path, policy: child.policy });
      visit(child);
      if (child.items) visit(child.items);
    }
  };
  visit(root);
  return notes;
}

export function validationErrors(
  schema: TSchema,
  value: unknown,
  kind: "schema" | "patch",
  code: "invalid-default" | "schema-mismatch" | "closure",
): SkillStateError[] {
  if (Check(schema, value)) return [];
  return ValueErrors(schema, value).map((issue) => {
    const path = issue.instancePath || "/";
    if (kind === "schema") return schemaError(code as "invalid-default", path, issue.message, valueAt(value, path));
    return {
      kind: "patch" as const,
      code: code as "schema-mismatch" | "closure",
      path,
      expected: issue.message,
      actual: valueAtDescription(value, path),
    };
  });
}

function valueAt(value: unknown, pointerPath: string): unknown {
  if (!pointerPath || pointerPath === "/") return value;
  let current = value;
  for (const encoded of pointerPath.split("/").slice(1)) {
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(current)) current = current[Number(key)];
    else if (isJsonObject(current)) current = current[key];
    else return current;
  }
  return current;
}

function valueAtDescription(value: unknown, pointerPath: string): string {
  const found = valueAt(value, pointerPath);
  if (found === undefined) return "missing";
  if (found === null) return "null";
  if (Array.isArray(found)) return `array(${found.length})`;
  if (typeof found === "object") return "object";
  return `${typeof found} ${JSON.stringify(found)}`;
}

function pointer(base: string, segment: string): string {
  const encoded = segment.replaceAll("~", "~0").replaceAll("/", "~1");
  return `${base}/${encoded}`;
}
