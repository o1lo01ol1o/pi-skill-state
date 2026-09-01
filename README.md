# pi-skill-state

A pi extension for bounded, schema-validated state during long procedural skill runs.
It keeps the append-only session log for audit while replacing model context with:

```text
(procedure, current checked state, bounded recent observations)
```

## Use

```bash
npm install
pi -e .
```

A stateful skill declares a schema relative to `SKILL.md`:

```yaml
metadata:
  skill-state: ./state.schema.json
```

Start explicitly or invoke the skill normally:

```text
/skill-state start warehouse-audit aisle=7
/skill:warehouse-audit aisle=7
```

Inspect or stop the active episode:

```text
/skill-state status
/skill-state show
/skill-state stop
```

## State operations

`state_patch` uses strict-compatible tagged operations. Every outer field is required;
`value` contains JSON text:

```json
{
  "operations": [
    { "path": "/shelves_done", "action": "union", "value": "[\"7-01\"]" },
    { "path": "/items_counted", "action": "sum", "value": "42" }
  ]
}
```

Actions are `lww-set`, `lww-delete`, `append`, `union`, `sum`, `max`, and `once`.
Paths are RFC 6901 pointers and must match the field policy. Multi-operation calls are
atomic.

## CLI flags

```text
--skill-state-window-turns <1..8>       default 2
--skill-state-budget-tokens <positive>  default 4000
--skill-state-constrained-sampling      default false
```

Pi 0.84.2 has no extension settings-registration API, so v1 intentionally supports
these as CLI flags only.

## Schema subset

Schemas are closed object trees (`additionalProperties: false`). Supported primitive,
object, and array constraints are implemented in `src/core/schema.ts`; unsupported
keywords are rejected when the skill arms. `sum` fields must use `type: integer` and
all sums stay within JavaScript's safe-integer range.

See [`skills/warehouse-audit`](skills/warehouse-audit/) for a complete example and
[`SPEC.md`](SPEC.md) for the runtime protocol and trade-offs.

## Compatibility boundary

For the bounded-context privacy guarantee, skill-state must be the sole extension
that rewrites `context` or independently handles `session_before_compact` /
`session_before_tree`. Pi chains these handlers, so another history or summary
rewriter could observe raw episode entries or replace the safe projection. Extensions
that merely request pi's normal compaction remain compatible because skill-state
still owns the resulting event.

## Verify

```bash
npm run verify
```

The real-pi acceptance gate runs the bundled skill once normally and once with strict
constrained sampling, then validates the persisted protocol evidence:

```bash
rm -rf /tmp/skill-state-normal /tmp/skill-state-strict

pi --no-extensions -e . --print --session-dir /tmp/skill-state-normal \
  '/skill:warehouse-audit Audit only shelf A: exactly 3 items, no defects. Record only shelves_done union ["A"] and items_counted sum 3; do not change any other state field; then complete.'
npm run verify:live-session -- /tmp/skill-state-normal false \
  '{"defects_found":[],"items_counted":3,"phase":"scan","shelves_done":["A"]}'

pi --no-extensions -e . --print --skill-state-constrained-sampling \
  --session-dir /tmp/skill-state-strict \
  '/skill:warehouse-audit Audit only shelf B: exactly 4 items, no defects. Record only shelves_done union ["B"] and items_counted sum 4; do not change any other state field; then complete.'
npm run verify:live-session -- /tmp/skill-state-strict true \
  '{"defects_found":[],"items_counted":4,"phase":"scan","shelves_done":["B"]}'
```
