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

See [`skills/warehouse-audit`](skills/warehouse-audit/) for a complete example,
[`skills/skill-state-guide`](skills/skill-state-guide/) (`/skill:skill-state-guide`)
for the authoring guide — schema design, merge-policy selection, procedure
writing, debugging — and [`SPEC.md`](SPEC.md) for the runtime protocol and
trade-offs.

## Compatibility boundary

For the bounded-context privacy guarantee, skill-state must be the sole extension
that rewrites `context` or independently handles `session_before_compact` /
`session_before_tree`. Pi chains these handlers, so another history or summary
rewriter could observe raw episode entries or replace the safe projection. Extensions
that merely request pi's normal compaction remain compatible because skill-state
still owns the resulting event.

## Subagents

Skill-state is single-writer by design: an episode's state belongs to the
session (and branch) that armed it, and nothing a subagent does writes into the
parent's state. Multi-writer merge is future work ([`SPEC.md`](SPEC.md) §15).
Interaction boundaries, verified against `pi-subagents` 0.56:

- **Foreground delegation works.** A synchronous subagent call from inside an
  episode is an ordinary action: the call and its result ride the observation
  window, and the model should fold what it needs into state before the window
  slides. Recommended pattern: the parent owns the episode; children do
  stateless legwork.
- **Async completions are invisible mid-episode** (see Known issues): async
  results arrive as custom messages, which the bounded view currently drops.
  Use foreground delegation while an episode is active.
- **Don't hand stateful skills to subagents.** Arming happens on user
  `/skill:name` input or `/skill-state start`; children receive their task as a
  prompt (never a slash input) and are often spawned with `--no-extensions`, so
  a stateful skill degrades to plain instructions referencing `state_patch` /
  `skill_complete` tools that don't exist in the child.
- **Avoid fork-context children while an episode is active.** A child forked
  mid-episode either continues a divergent episode that never merges back (if
  it loads this extension) or sees the raw episode span (if it doesn't) — and
  pi-subagents installs its own child-side context rewriter, which is exactly
  the composition-unsafe pairing described under Compatibility boundary.
  Prefer `fresh` context for children spawned during episodes.
- Parent-side composition with pi-subagents is safe: it does not rewrite the
  parent's context and never produces its own compaction summaries.

## Performance and prompt caching: what to expect

While an episode is active, the per-turn prompt is O(1) in episode length —
(procedure + state + a k-turn window) — instead of a growing transcript, and
cumulative episode tokens are O(T) instead of O(T²). You can watch this in pi's
normal footer: the context figure comes from the provider's reported usage of
the last call, so it **drops to the bounded prompt's size on the first response
of an episode and stays roughly flat** for the rest of it. After completion,
later turns see only a collapsed (header, final state, result) block, so the
savings persist for the remainder of the session.

Cache behavior, by design:

- The system prompt (pi base + runtime contract + the frozen procedure) and the
  tool schemas are byte-stable for the whole episode. On Anthropic-style
  providers they sit inside the durable cache breakpoints; OpenAI-style prefix
  caching covers them automatically. These should be served at cache-read price
  every turn.
- Full cache invalidation happens exactly twice per episode: at entry and at
  exit (the system prompt and toolset change there).
- The state message and everything after it (steers, window) re-price whenever
  state changes — that is the bounded payload and it is expected to be small.
  Steers sit after state deliberately (instruction adjacency over cacheability);
  see SPEC.md §14 for the trade-offs.

**If reality doesn't match this** — the footer keeps climbing mid-episode, the
skill body is billed at full input price every turn, cache reads don't cover the
system prompt, or measured usage is far off the O(1)/O(T) claims — that is a bug
or a regression we want to know about. Please open an issue or, better, a PR
with: the provider and model, the session JSONL (or a redacted excerpt), and the
per-turn usage numbers (input / cache-read / cache-write). The same goes for any
cache invalidation you can attribute to this extension where the design above
says there shouldn't be one.

## Known issues

- Aborting mid-turn (Esc) while an assistant message still has unexecuted
  `state_patch` calls can leave a dangling proposal that wedges branch
  reconstruction ("Skill-state is blocked"). Workaround: `/tree`-navigate above
  the aborted message. A fold-level fix (expiring never-resolved proposals) is
  planned; PRs welcome.
- While an episode is active, custom messages injected by other extensions —
  e.g. pi-subagents' async `subagent-notify` completions — are outside the
  bounded view and never reach the model. Planned fix: include custom messages
  in the observation window. Until then, prefer foreground delegation during
  episodes; PRs welcome.

## Requirements

Node ≥ 22 to run the test suite (pi-coding-agent's bundled undici needs it);
the extension itself runs inside pi's own runtime.

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
