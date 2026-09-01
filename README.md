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

## Verify

```bash
npm run verify
```
