export type JsonScalar = null | boolean | number | string;
export type JsonValue = JsonScalar | JsonValue[] | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isJsonObject(value) && Object.values(value).every(isJsonValue);
}

export function cloneJson<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneJson(item)) as T;
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneJson(item)]),
    ) as T;
  }
  return value;
}

export function freezeJson<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) {
    for (const item of value) freezeJson(item);
  } else if (isJsonObject(value)) {
    for (const item of Object.values(value)) freezeJson(item);
  }
  return Object.freeze(value);
}

export function canonicalizeJson<T extends JsonValue>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => canonicalizeJson(item)) as T;
  if (isJsonObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalizeJson(value[key]!)]),
    ) as T;
  }
  return Object.is(value, -0) ? (0 as T) : value;
}

export function renderCanonicalJson(value: JsonValue): string {
  return JSON.stringify(canonicalizeJson(value));
}

export function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  return renderCanonicalJson(left) === renderCanonicalJson(right);
}

export function describeJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object") return "object";
  if (typeof value === "number" && !Number.isFinite(value)) return "non-finite number";
  return typeof value;
}
