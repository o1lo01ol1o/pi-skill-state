import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { Check } from "typebox/value";
import { parseStateSchema } from "../src/core/schema.js";

const exampleSchemaPath = new URL("../skills/warehouse-audit/state.schema.json", import.meta.url);

test("B1 parses the bundled closed schema and derives defaults and patch policies", async () => {
  const parsed = parseStateSchema(await readFile(exampleSchemaPath, "utf8"));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  assert.deepEqual(parsed.value.initial, {
    defects_found: [],
    items_counted: 0,
    phase: "scan",
    shelves_done: [],
  });
  assert.equal(parsed.value.hash.length, 64);
  assert.ok(Check(parsed.value.patchSchema, {
    operations: [
      { path: "/shelves_done", action: "union", value: '["7-01"]' },
      { path: "/items_counted", action: "sum", value: "4" },
    ],
  }));
  assert.equal(Check(parsed.value.patchSchema, { operations: [{ path: "/phase", action: "lww-set" }] }), false);
  assert.equal(Check(parsed.value.patchSchema, { operations: [], unknown: true }), false);
  assert.equal(Check(parsed.value.patchSchema, { operations: [{ path: "/phase", action: "lww-delete", value: "null" }] }), true);
});

test("B1 accumulates independent, path-addressed structural errors", () => {
  const parsed = parseStateSchema(JSON.stringify({
    type: "object",
    additionalProperties: true,
    properties: {
      log: { type: "string", "x-skill-state": { merge: "append" } },
      bag: {
        type: "array",
        items: { type: "object", properties: {} },
        "x-skill-state": { merge: "union" },
      },
    },
  }));

  assert.equal(parsed.ok, false);
  if (parsed.ok) return;
  assert.ok(parsed.errors.length >= 4);
  assert.ok(parsed.errors.some((error) => error.kind === "schema" && error.code === "open-object"));
  assert.ok(parsed.errors.some((error) => error.kind === "schema" && error.code === "policy-type"));
  assert.ok(parsed.errors.some((error) => "path" in error && error.path.includes("/bag/items")));
});

test("B1 synthesizes required object parents for child defaults but leaves optional parents absent", () => {
  const parsed = parseStateSchema(JSON.stringify({
    type: "object",
    additionalProperties: false,
    properties: {
      required_group: {
        type: "object",
        additionalProperties: false,
        properties: { phase: { type: "string", default: "scan" } },
        required: ["phase"],
      },
      optional_group: {
        type: "object",
        additionalProperties: false,
        properties: { phase: { type: "string", default: "scan" } },
      },
    },
    required: ["required_group"],
  }));
  assert.equal(parsed.ok, true);
  if (parsed.ok) assert.deepEqual(parsed.value.initial, { required_group: { phase: "scan" } });
});

test("B1 rejects an initial state that defaults cannot make valid", () => {
  const parsed = parseStateSchema(JSON.stringify({
    type: "object",
    additionalProperties: false,
    properties: { required_name: { type: "string" } },
    required: ["required_name"],
  }));
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.ok(parsed.errors.some((error) => error.kind === "schema" && error.code === "invalid-default"));
  }
});

test("B1 rejects unsupported JSON Schema vocabularies and non-integer sum fields", () => {
  const parsed = parseStateSchema(JSON.stringify({
    type: "object",
    additionalProperties: false,
    properties: {
      count: { type: "number", allOf: [{ minimum: 0 }], "x-skill-state": { merge: "sum" } },
    },
  }));
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.ok(parsed.errors.some((error) => error.kind === "schema" && error.code === "unsupported-schema"));
    assert.ok(parsed.errors.some((error) => error.kind === "schema" && error.code === "policy-type"));
  }
});

test("B1 rejects malformed supported keywords and policy annotations", () => {
  const parsed = parseStateSchema(JSON.stringify({
    type: "object",
    additionalProperties: false,
    properties: {
      value: {
        type: "integer",
        multipleOf: 0,
        enum: [1, 1],
        "x-skill-state": { merge: "sum", typo: true },
      },
    },
    required: ["value", "value"],
  }));
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    const paths = parsed.errors.flatMap((error) => "path" in error ? [error.path] : []);
    assert.ok(paths.includes("/value/multipleOf"));
    assert.ok(paths.includes("/value/enum"));
    assert.ok(paths.includes("/value/x-skill-state/typo"));
    assert.ok(paths.includes("/required"));
  }
});

test("B1 rejects unsafe-integer sum defaults", () => {
  const parsed = parseStateSchema(JSON.stringify({
    type: "object",
    additionalProperties: false,
    properties: {
      count: {
        type: "integer",
        default: Number.MAX_SAFE_INTEGER + 1,
        "x-skill-state": { merge: "sum" },
      },
    },
  }));
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.ok(parsed.errors.some((error) => error.kind === "schema" && error.code === "invalid-default"));
  }
});

test("schema hash is canonical over object key order", () => {
  const left = parseStateSchema('{"type":"object","additionalProperties":false,"properties":{}}');
  const right = parseStateSchema('{"properties":{},"additionalProperties":false,"type":"object"}');
  assert.equal(left.ok, true);
  assert.equal(right.ok, true);
  if (left.ok && right.ok) assert.equal(left.value.hash, right.value.hash);
});
