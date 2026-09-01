import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import { parseStateSchema } from "../src/core/schema.js";
import {
  acceptPatch,
  applyPatch,
  composePatches,
  emptyPatch,
  estimateStateTokens,
  initialState,
  parseRenderedState,
  renderState,
  stateSatisfiesSchema,
  type PatchAction,
  type State,
} from "../src/core/state.js";

const STATE_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  properties: {
    cursor: { type: "string" },
    log: { type: "array", items: { type: "string" }, default: [], "x-skill-state": { merge: "append" } },
    seen: { type: "array", items: { type: "string" }, default: [], "x-skill-state": { merge: "union" } },
    count: { type: "integer", default: 0, "x-skill-state": { merge: "sum" } },
    high: { type: "number", "x-skill-state": { merge: "max" } },
    token: { type: "string", "x-skill-state": { merge: "once" } },
    nested: {
      type: "object",
      additionalProperties: false,
      properties: { a: { type: "number" }, b: { type: "number" } },
    },
  },
});

type Op = readonly [path: string, action: PatchAction, value: unknown];

function wire(...operations: readonly Op[]) {
  return {
    operations: operations.map(([path, action, value]) => ({
      path,
      action,
      value: JSON.stringify(value),
    })),
  };
}

function schema() {
  const parsed = parseStateSchema(STATE_SCHEMA);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) throw new Error("test schema failed to parse");
  return parsed.value;
}

const UNBOUNDED = { maxTokens: Number.MAX_SAFE_INTEGER };

function accepted(current: State, raw: unknown) {
  const result = acceptPatch(schema(), current, raw, UNBOUNDED);
  assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.errors));
  if (!result.ok) throw new Error("patch was unexpectedly rejected");
  return result.value;
}

test("tagged operations apply every field policy atomically", () => {
  const start = initialState(schema());
  const first = accepted(start, wire(
    ["/cursor", "lww-set", "one"],
    ["/log", "append", ["a"]],
    ["/seen", "union", ["z", "a", "z"]],
    ["/count", "sum", 2],
    ["/high", "max", 4],
    ["/token", "once", "fixed"],
    ["/nested/a", "lww-set", 1],
    ["/nested/b", "lww-set", 2],
  ));
  const second = accepted(first.state, wire(
    ["/cursor", "lww-delete", null],
    ["/log", "append", ["b"]],
    ["/seen", "union", ["m", "a"]],
    ["/count", "sum", -1],
    ["/high", "max", 3],
    ["/token", "once", "fixed"],
    ["/nested/a", "lww-delete", null],
  ));

  assert.deepEqual(JSON.parse(renderState(second.state)), {
    count: 1,
    high: 4,
    log: ["a", "b"],
    nested: { b: 2 },
    seen: ["a", "m", "z"],
    token: "fixed",
  });
  assert.ok(stateSatisfiesSchema(schema(), second.state));
});

test("once conflicts reject all operations in the tool call", () => {
  const start = initialState(schema());
  const first = accepted(start, wire(["/token", "once", "alpha"], ["/count", "sum", 3]));
  const rejected = acceptPatch(
    schema(),
    first.state,
    wire(["/token", "once", "beta"], ["/count", "sum", 9]),
    UNBOUNDED,
  );
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.ok(rejected.errors.some((error) => error.kind === "patch" && error.code === "once-conflict"));
  }
  assert.equal(renderState(first.state), '{"count":3,"log":[],"seen":[],"token":"alpha"}');
});

test("path/action/payload mismatches accumulate at the tagged boundary", () => {
  const start = initialState(schema());
  const result = acceptPatch(schema(), start, {
    operations: [
      { path: "/log", action: "sum", value: "1" },
      { path: "/missing", action: "lww-set", value: "true" },
      { path: "/count", action: "sum", value: "1.5" },
    ],
  }, UNBOUNDED);
  assert.equal(result.ok, false);
  if (!result.ok) {
    const paths = result.errors.flatMap((error) => error.kind === "patch" ? [error.path] : []);
    assert.deepEqual(paths, [
      "/operations/0/action",
      "/operations/1/path",
      "/operations/2/value",
    ]);
  }
});

test("lww ancestor operations cannot bypass protected descendant policies", () => {
  const protectedSchema = parseStateSchema(JSON.stringify({
    type: "object",
    additionalProperties: false,
    properties: {
      group: {
        type: "object",
        additionalProperties: false,
        properties: {
          log: { type: "array", items: { type: "string" }, default: [], "x-skill-state": { merge: "append" } },
        },
      },
    },
  }));
  assert.equal(protectedSchema.ok, true);
  if (!protectedSchema.ok) return;
  for (const action of ["lww-set", "lww-delete"] as const) {
    const rejected = acceptPatch(
      protectedSchema.value,
      initialState(protectedSchema.value),
      wire(["/group", action, action === "lww-delete" ? null : { log: ["overwrite"] }]),
      UNBOUNDED,
    );
    assert.equal(rejected.ok, false);
  }
  const accepted = acceptPatch(
    protectedSchema.value,
    initialState(protectedSchema.value),
    wire(["/group/log", "append", ["kept"]]),
    UNBOUNDED,
  );
  assert.equal(accepted.ok, true);
});

test("neutral deltas do not materialize absent optional policy fields", () => {
  const optionalSchema = parseStateSchema(JSON.stringify({
    type: "object",
    additionalProperties: false,
    properties: {
      log: { type: "array", items: { type: "string" }, "x-skill-state": { merge: "append" } },
      seen: { type: "array", items: { type: "string" }, "x-skill-state": { merge: "union" } },
      count: { type: "integer", "x-skill-state": { merge: "sum" } },
    },
  }));
  assert.equal(optionalSchema.ok, true);
  if (!optionalSchema.ok) return;
  const result = acceptPatch(optionalSchema.value, initialState(optionalSchema.value), {
    operations: [
      { path: "/log", action: "append", value: "[]" },
      { path: "/seen", action: "union", value: "[]" },
      { path: "/count", action: "sum", value: "0" },
    ],
  }, UNBOUNDED);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(renderState(result.value.state), "{}");
});

test("nested neutral deltas do not materialize an absent optional parent", () => {
  const nestedSchema = parseStateSchema(JSON.stringify({
    type: "object",
    additionalProperties: false,
    properties: {
      group: {
        type: "object",
        additionalProperties: false,
        properties: {
          log: { type: "array", items: { type: "string" }, "x-skill-state": { merge: "append" } },
          seen: { type: "array", items: { type: "string" }, "x-skill-state": { merge: "union" } },
          count: { type: "integer", "x-skill-state": { merge: "sum" } },
        },
      },
    },
  }));
  assert.equal(nestedSchema.ok, true);
  if (!nestedSchema.ok) return;
  const result = acceptPatch(
    nestedSchema.value,
    initialState(nestedSchema.value),
    wire(
      ["/group/log", "append", []],
      ["/group/seen", "union", []],
      ["/group/count", "sum", 0],
    ),
    UNBOUNDED,
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(renderState(result.value.state), "{}");
});

test("prototype-named fields remain ordinary state data", () => {
  const prototypeSchema = parseStateSchema(
    '{"type":"object","additionalProperties":false,"properties":{"__proto__":{"type":"string","default":"seed"},"toString":{"type":"string","default":"safe"}}}',
  );
  assert.equal(prototypeSchema.ok, true);
  if (!prototypeSchema.ok) return;
  assert.equal(
    renderState(initialState(prototypeSchema.value)),
    '{"__proto__":"seed","toString":"safe"}',
  );
  const updated = acceptPatch(
    prototypeSchema.value,
    initialState(prototypeSchema.value),
    wire(["/__proto__", "lww-set", "updated"], ["/toString", "lww-set", "still-safe"]),
    UNBOUNDED,
  );
  assert.equal(updated.ok, true);
  if (updated.ok) {
    assert.equal(
      renderState(updated.value.state),
      '{"__proto__":"updated","toString":"still-safe"}',
    );
  }
});

test("RFC 6901 pointer escaping addresses field names containing slash and tilde", () => {
  const escapedSchema = parseStateSchema(JSON.stringify({
    type: "object",
    additionalProperties: false,
    properties: { "a/b~c": { type: "string" } },
  }));
  assert.equal(escapedSchema.ok, true);
  if (!escapedSchema.ok) return;
  const result = acceptPatch(
    escapedSchema.value,
    initialState(escapedSchema.value),
    wire(["/a~1b~0c", "lww-set", "ok"]),
    UNBOUNDED,
  );
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(renderState(result.value.state), '{"a/b~c":"ok"}');
});

test("sum is exact over safe integers and rejects unsafe overflow", () => {
  const start = initialState(schema());
  const nearLimit = accepted(start, wire(["/count", "sum", Number.MAX_SAFE_INTEGER]));
  const overflow = acceptPatch(schema(), nearLimit.state, wire(["/count", "sum", 1]), UNBOUNDED);
  assert.equal(overflow.ok, false);
  if (!overflow.ok) assert.ok(overflow.errors.some((error) => error.kind === "patch" && error.code === "closure"));
});

test("the state budget rejects the whole transition and reports heavy fields", () => {
  const start = initialState(schema());
  const result = acceptPatch(schema(), start, wire(["/log", "append", ["x".repeat(100)]]), { maxTokens: 5 });
  assert.equal(result.ok, false);
  if (!result.ok) {
    const budget = result.errors.find((error) => error.kind === "patch" && error.code === "state-budget");
    assert.ok(budget);
    assert.match(budget.expected, /log≈/);
  }
});

test("canonical render parses back to the same checked state", () => {
  const transition = accepted(initialState(schema()), wire(
    ["/seen", "union", ["z", "a", "z"]],
    ["/nested/b", "lww-set", 2],
    ["/nested/a", "lww-set", 1],
  ));
  const rendered = renderState(transition.state);
  assert.equal(rendered, '{"count":0,"log":[],"nested":{"a":1,"b":2},"seen":["a","z"]}');
  const reparsed = parseRenderedState(schema(), rendered);
  assert.equal(reparsed.ok, true);
  if (reparsed.ok) assert.equal(renderState(reparsed.value), rendered);
  assert.equal(estimateStateTokens(transition.state), Math.ceil(rendered.length / 4));
});

test("identity, action, and associativity laws hold for accepted operation programs", () => {
  fc.assert(fc.property(
    fc.array(fc.string({ maxLength: 8 }), { maxLength: 4 }),
    fc.array(fc.string({ maxLength: 8 }), { maxLength: 4 }),
    fc.integer({ min: -100, max: 100 }),
    fc.integer({ min: -100, max: 100 }),
    (leftLog, rightLog, leftCount, rightCount) => {
      const checkedSchema = schema();
      const start = initialState(checkedSchema);
      const left = acceptPatch(checkedSchema, start, wire(["/log", "append", leftLog], ["/count", "sum", leftCount]), UNBOUNDED);
      assert.equal(left.ok, true);
      if (!left.ok) return;
      const right = acceptPatch(checkedSchema, left.value.state, wire(["/log", "append", rightLog], ["/count", "sum", rightCount]), UNBOUNDED);
      assert.equal(right.ok, true);
      if (!right.ok) return;

      const identity = applyPatch(checkedSchema, start, emptyPatch(), UNBOUNDED);
      assert.equal(identity.ok, true);
      if (identity.ok) assert.equal(renderState(identity.value), renderState(start));

      const action = applyPatch(checkedSchema, start, composePatches(left.value.patch, right.value.patch), UNBOUNDED);
      assert.equal(action.ok, true);
      if (action.ok) assert.equal(renderState(action.value), renderState(right.value.state));

      const lhs = applyPatch(checkedSchema, start, composePatches(composePatches(left.value.patch, right.value.patch), emptyPatch()), UNBOUNDED);
      const rhs = applyPatch(checkedSchema, start, composePatches(left.value.patch, composePatches(right.value.patch, emptyPatch())), UNBOUNDED);
      assert.equal(lhs.ok, true);
      assert.equal(rhs.ok, true);
      if (lhs.ok && rhs.ok) assert.equal(renderState(lhs.value), renderState(rhs.value));
    },
  ), { numRuns: 200 });
});

test("generated accepted traces cover every policy and preserve composition and render laws", () => {
  const batchArbitrary = fc.record({
    cursor: fc.option(fc.string({ maxLength: 8 }), { nil: null }),
    log: fc.array(fc.string({ maxLength: 6 }), { maxLength: 3 }),
    seen: fc.array(fc.string({ maxLength: 6 }), { maxLength: 3 }),
    count: fc.integer({ min: -20, max: 20 }),
    high: fc.integer({ min: -100, max: 100 }),
    nestedA: fc.option(fc.integer({ min: -20, max: 20 }), { nil: null }),
  });
  fc.assert(fc.property(
    fc.string({ maxLength: 8 }),
    fc.array(batchArbitrary, { minLength: 1, maxLength: 6 }),
    (token, batches) => {
      const checkedSchema = schema();
      const start = initialState(checkedSchema);
      let sequential = start;
      const patches = [];
      for (const batch of batches) {
        const raw = wire(
          ["/cursor", batch.cursor === null ? "lww-delete" : "lww-set", batch.cursor],
          ["/log", "append", batch.log],
          ["/seen", "union", batch.seen],
          ["/count", "sum", batch.count],
          ["/high", "max", batch.high],
          ["/token", "once", token],
          ["/nested/a", batch.nestedA === null ? "lww-delete" : "lww-set", batch.nestedA],
        );
        const transition = acceptPatch(checkedSchema, sequential, raw, UNBOUNDED);
        assert.equal(transition.ok, true);
        if (!transition.ok) return;
        sequential = transition.value.state;
        patches.push(transition.value.patch);
        const roundTrip = parseRenderedState(checkedSchema, renderState(sequential));
        assert.equal(roundTrip.ok, true);
        if (roundTrip.ok) assert.equal(renderState(roundTrip.value), renderState(sequential));
      }
      const composed = applyPatch(
        checkedSchema,
        start,
        composePatches(...patches),
        UNBOUNDED,
      );
      assert.equal(composed.ok, true);
      if (composed.ok) assert.equal(renderState(composed.value), renderState(sequential));
    },
  ), { numRuns: 200 });
});

test("explicit replacement preserves delete-then-rebuild semantics without RFC flattening", () => {
  const checkedSchema = schema();
  const seeded = accepted(initialState(checkedSchema), wire(["/nested", "lww-set", { a: 1, b: 2 }]));
  const deleted = accepted(seeded.state, wire(["/nested", "lww-delete", null]));
  const rebuilt = accepted(deleted.state, wire(["/nested", "lww-set", { a: 9 }]));
  const result = applyPatch(checkedSchema, seeded.state, composePatches(deleted.patch, rebuilt.patch), UNBOUNDED);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(renderState(result.value), '{"count":0,"log":[],"nested":{"a":9},"seen":[]}');
});
