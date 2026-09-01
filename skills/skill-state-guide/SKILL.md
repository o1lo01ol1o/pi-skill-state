---
name: skill-state-guide
description: Author, run, and debug bounded-state pi skills — state schema design, merge-policy selection, patch discipline, and the episode lifecycle of the skill-state runtime. Load when writing or converting a skill that declares metadata.skill-state, or when diagnosing a running episode.
---

# Authoring and using skill-state skills

skill-state runs a procedural skill under a bounded prompt. While an episode is
active the model does not see the conversation transcript; every turn it sees
exactly:

1. **P** — the skill body plus the invocation arguments, frozen at start;
2. **Σ** — a JSON state object it maintains through validated `state_patch` calls;
3. the last *k* turns of its own tool calls and their results (default k = 2);
4. any user messages sent during the episode, verbatim.

Everything else — including all of the model's own earlier prose and reasoning —
is gone from its view (it stays in the session file for audit). Anything the
model will need later **must be written into Σ before it leaves the window**.
Prompt size is therefore constant in episode length; a 200-turn run costs the
same per turn as a 10-turn run.

Normative details live in `SPEC.md` at the repository root; this guide is the
working subset an author needs.

## When to use it

Use skill-state when the task is a **procedure over many items or steps** whose
intermediate facts fit a fixed shape: audits, migrations, sweeps, batch fixes,
inventory/e-discovery-style enumeration, long benchmark loops. Signals: "for
each X do Y and tally Z", horizon beyond ~15 turns, progress expressible as
sets/counts/logs.

Do not use it when the task is conversational, exploratory with no stable state
shape, short enough that a plain transcript fits, or genuinely needs verbatim
history (e.g. reviewing earlier discussion). The paper this runtime implements
(SKILL.state, arXiv:2608.26263) found one schema per **domain** suffices —
across 100 diverse CTF challenge instances a single static 5-field schema was
reused unchanged. Write the schema for the domain's procedure, not per task;
task specifics arrive as invocation arguments.

## Declaring a stateful skill

A stateful skill is a normal Agent Skill plus one `metadata` pointer:

```yaml
---
name: warehouse-audit
description: Audit a warehouse aisle shelf by shelf while retaining bounded progress state.
metadata:
  skill-state: ./state.schema.json     # path relative to SKILL.md
---
```

Invoking `/skill:warehouse-audit aisle=7` arms the runtime automatically;
`/skill-state start warehouse-audit aisle=7` does the same explicitly. The
schema file is snapshotted (bytes + hash) at entry: **editing the schema during
a run does not take effect** — patches fail with `schema-changed` until you
stop and restart the episode.

## Designing the state schema

The schema is a **closed JSON object tree**: `"additionalProperties": false` is
required at every object level, and only a supported keyword subset is
accepted (the skill refuses to arm otherwise, with path-addressed errors):

| Context | Allowed keywords |
|---|---|
| every node | `type`, `title`, `description`, `default`, `enum`, `const`, `x-skill-state` |
| object | `properties`, `required`, `additionalProperties`, `minProperties`, `maxProperties` |
| array | `items` (single schema), `minItems`, `maxItems`, `uniqueItems` |
| string | `minLength`, `maxLength`, `pattern` |
| number / integer | `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `multipleOf` |
| root only | `$schema`, `$id` |

No `$ref`, `oneOf`/`allOf`, `patternProperties`, tuple items, or nullable
unions. The initial state Σ₀ is built by applying `default`s recursively (a
`required` object child without a default is synthesized empty); if the result
does not validate, the skill refuses to arm — so give every required leaf a
default.

### Merge policies: the core design decision

Each field carries a merge policy via `"x-skill-state": {"merge": …}`
(omitted = `lww`). The policy decides which patch actions the field accepts,
which makes destructive updates **unrepresentable** rather than discouraged.
This is the direct answer to the paper's dominant measured failure: 68% of
open-model state errors were premature overwrites/deletions of existing keys;
another 20% were type confusion in nested structures.

| Policy | Field type | Action / payload | Semantics |
|---|---|---|---|
| `lww` | any | `lww-set` full value · `lww-delete` null | replace / delete |
| `append` | array | `append` array of new items | ordered log, duplicates kept |
| `union` | array of scalars | `union` array of items | canonical set union |
| `sum` | integer | `sum` integer delta | exact safe-integer addition (overflow rejected) |
| `max` | number | `max` candidate | high-water mark |
| `once` | any | `once` value | write-once; re-writing the same value is a no-op, a different value is an error |

Selection checklist — go down the list and take the first match:

- **Facts you discover and must never lose** (items processed, flags found,
  files touched) → `union` for scalar identifiers, `append` for structured
  records (`{shelf, issue}`-style objects).
- **Tallies** → `sum`. **Best-so-far** → `max`.
- **Run constants** established once (baseline commit, chosen strategy,
  resolved config) → `once`.
- **Cursors that are supposed to be replaced** (current phase, next action
  note, working directory) → `lww`.

Rule of thumb: if a correct update would ever be "the old value plus a bit
more", `lww` is wrong — pick the accumulator whose delta is the bit more. Keep
`lww` only where replacement *is* the meaning.

### Shape guidance

- **Flat beats nested.** The paper's second failure class was nested
  list/dict confusion. Prefer top-level fields; nest only `lww` objects, and
  know that patch paths cannot descend into arrays or *through* a policy
  field — operations address whole fields (`/defects_found`, not
  `/defects_found/0/issue`). An `lww` object containing policy fields cannot
  be set or deleted wholesale (that would bypass its protected children).
- **State is for the future, not the past.** Include "only information
  required for future execution" (paper §3.1). No narration, no reasoning —
  reasoning is discarded by design; state that merely restates the procedure
  is budget spent twice.
- **Small budgets are fine.** Rendered Σ is capped (default 4000 estimated
  tokens, `--skill-state-budget-tokens`). The paper's budget-matched ablation
  is the reassurance: at an identical ~1.8k-token budget, structured state
  scored 0.94 where sliding-window truncation scored 0.18 and statistical
  compression 0.22. If a patch would exceed the budget it is rejected with the
  heaviest fields named — prune `lww` fields or restructure (e.g. replace an
  ever-growing `append` log of raw output with a `union` of identifiers plus
  a `sum` count).
- Field names containing `/` or `~` must be addressed with RFC 6901 escapes
  (`~1`, `~0`) — simplest to avoid such names.

### Worked example

The paper's CTF schema (reused verbatim across 100 tasks), expressed with
policies:

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "working_dir":       { "type": "string" },
    "cmd_summary":       { "type": "string" },
    "discovered_flags":  { "type": "array", "items": { "type": "string" },
                           "default": [], "x-skill-state": { "merge": "union" } },
    "active_files":      { "type": "array", "items": { "type": "string" },
                           "default": [], "x-skill-state": { "merge": "union" } },
    "tested_hypotheses": { "type": "array", "default": [],
                           "items": { "type": "object", "additionalProperties": false,
                                      "properties": { "hypothesis": { "type": "string" },
                                                      "verdict":    { "type": "string" } },
                                      "required": ["hypothesis", "verdict"] },
                           "x-skill-state": { "merge": "append" } }
  }
}
```

`working_dir` and `cmd_summary` are replaceable cursors; discoveries and the
hypothesis log are structurally protected. A ruled-out hypothesis can never be
silently dropped and retried forever — the exact long-horizon pathology the
accumulators exist to prevent. See `skills/warehouse-audit/` in this
repository for the shipped runnable example (`union` + `append` + `sum` +
`once` together).

## Writing the procedure body

The Markdown body below the frontmatter becomes P — the only instructions the
model keeps for the whole episode. Write it for an agent whose memory is Σ:

- **State the loop and its recording obligation together.** "For each shelf:
  inspect it, then in the same turn record the shelf in `shelves_done`, append
  any defects to `defects_found`, and add the item count to `items_counted`."
  Name the exact fields per step; the model should never have to invent a
  state convention. Record **in the same turn as the observation** — the
  window slides, and the runtime's reminder nudge is a backstop, not a plan.
- **Define done.** Give the completion criterion and what the one-line
  `skill_complete` result must contain ("all shelves in the argument list are
  in `shelves_done`; complete with shelf and defect counts").
- **No transcript references.** Never "as discussed above" — there is no
  above. Task-specific input arrives as the invocation arguments, included in
  P verbatim; tell the model how to parse them ("arguments name the aisle,
  e.g. `aisle=7`").
- Relative file references resolve against the skill's directory; the runtime
  tells the model the base directory.
- Keep P short. It is re-sent every turn (it is the prompt-cache-stable
  prefix, so its cost is mostly cached — but Σ and the window pay full price
  after every change).

## Running, inspecting, stopping

| Surface | Meaning |
|---|---|
| `/skill:name args…` | arm automatically (agent must be idle) and run |
| `/skill-state start name args…` | arm explicitly |
| `/skill-state status` | mode, run id, turns, accepted patches, Σ estimate vs budget, window |
| `/skill-state show` | rendered Σ |
| `/skill-state stop` | abort the episode (outcome `stopped`) |
| footer `Σ 1.2k · t47 · p31` | Σ token estimate · turns · accepted patches |
| `--skill-state-window-turns` | observation window k, 1–8, default 2 |
| `--skill-state-budget-tokens` | Σ render budget, default 4000 |
| `--skill-state-constrained-sampling` | provider-side strict JSON schema for patch calls |

During the episode the model gains two tools: `state_patch` (one or more
tagged operations `{path, action, value}`, `value` as JSON text; the whole
call applies atomically or not at all, with accumulated path-addressed errors
as the retry signal) and `skill_complete {result}` (must be the only tool call
in its message).

On completion the episode's transcript span collapses, for all later turns,
to a compact header plus final Σ plus the result — the final state is the
episode's sufficient statistic; no summarizer model is involved. The full
transcript, including discarded reasoning, remains in the session file, and
`/tree` branching into the middle of an episode reconstructs Σ exactly as it
was at that point.

## Debugging rejections

Errors name the operation index, expected form, and found value; typical ones:

| Error contains | Meaning | Fix |
|---|---|---|
| `expected append or union … for <policy> field` | action does not match the field's policy | use the field's own action; check `/skill-state show` |
| `policy append: expected JSON array delta` | payload shape wrong for the action | `append`/`union` take arrays of new items, `sum` an integer delta (the amount to add), `lww-delete` exactly `null` |
| `once-conflict` | second, different write to a `once` field | the first value stands; if it was wrong, the schema's policy choice was wrong — stop, fix, restart |
| `state-budget` (with `field≈Nt` list) | patched Σ would exceed the budget | prune the named heavy `lww` fields or restructure accumulators |
| `schema-changed` | schema file edited or missing mid-run | `/skill-state stop`, then restart |
| `path not descending through a policy field` / `known state field path` | path addresses inside an array/policy field, or a field not in the schema | address whole declared fields only |

## What the paper contributes vs. what this runtime adds

From SKILL.state (arXiv:2608.26263): the bounded prompt (P, Σ, O) with
validated patches and discarded reasoning; one-schema-per-domain; state as
minimal future-relevant facts; the failure taxonomy (68% overwrite/deletion,
20% nested-type confusion, 12% JSON formatting) and the budget-matched
evidence that structured state dominates compression. The paper is silent on
schema field design discipline, pruning, window sizing, and task
decomposition — the merge-policy algebra, the k-turn window, the state
budget with heavy-field reporting, and deterministic episode collapse are
this runtime's answers; their rationale and trade-offs are in `SPEC.md` §14.
