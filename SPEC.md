# pi-skill-state — Specification

**Status:** Implemented v1. The code and automated verification suite in this repository are normative together with this document.

A [pi](https://github.com/badlogic/pi-mono) extension implementing the runtime of
*SKILL.state: Scalable Long-Horizon Agent Skills* (arXiv:2608.26263v2, Badhe, Tiwari
& Chung) on pi's extension API (`@earendil-works/pi-coding-agent` ≥ 0.84.2).

During execution of a procedural skill, the append-only transcript sent to the model
is replaced by a bounded prompt

> **A_t = (P, Σ_t, O_t)**

where **P** is the immutable procedure (the skill plus task arguments), **Σ_t** is
explicit, schema-validated, mutable execution state, and **O_t** is a bounded window
of recent observations. The model updates Σ via validated tagged operations
(**Σ_{t+1} = Σ_t ⊕ ΔΣ_t**); its chain-of-thought and prose (**R_t**) are persisted in
the session file for audit but **never re-enter model context**. Prompt size is O(1)
in the execution horizon; cumulative tokens are O(T) instead of O(T²).

The session log remains the source of truth. The bounded prompt is a *view*: pi's
`context` event receives a deep copy of the transcript before each LLM call and the
handler returns a replacement message array; session persistence is untouched. Full
auditability and branch replay are retained for free.

---

## 1. Mapping the paper onto pi

| Paper construct | pi realization |
|---|---|
| Procedural spec P | Skill body (`SKILL.md`) + the task arguments from the invoking prompt; frozen at mode entry |
| Domain state schema | JSON Schema shipped with the skill (`state.schema.json`, pointed to by skill `metadata`), parsed at mode entry into a checked `StateSchema` |
| Execution state Σ_t | JSON value conforming to `StateSchema`; derived by folding accepted patches along the active session branch |
| State update ΔΣ_t | `state_patch` tool call containing strict-compatible tagged operations (`path`, `action`, JSON-encoded `value`) |
| Merge operator ⊕ | Sequential interpretation of tagged field operations under per-field merge policies (§3) |
| Action a_t | pi's ordinary tool calls (bash, read, edit, write, extension tools), unchanged |
| Observation O_t | Tool results of the last *k* turns, kept verbatim in the prompt window (k configurable, default 2) |
| Discarded reasoning R_t | Assistant text/thinking blocks: persisted in the session, stripped from every subsequent context |
| Episode termination | `skill_complete` tool call, or user `/skill-state stop` |
| Validated transitions | Patch boundary rejects violations with structured, accumulated errors returned as tool errors (the model's retry channel) |
| Grammar-constrained decoding (paper §Limitations) | `ToolDefinition.constrainedSampling` on `state_patch`, opt-in per model |

**Departures from the paper** (each argued in §14):

1. Observation window k ≥ 1 turns rather than strictly the latest observation.
2. User steering messages sent during the mode are retained verbatim (growth is
   human-bounded, not agent-bounded).
3. ΔΣ travels as a strict-compatible tagged-operation tool call, not as a structured
   segment of the assistant message. The operation payload is canonical JSON text so
   every tool-argument property can remain required under pi 0.84.2 constrained sampling.
4. Per-field merge policies extend the paper's uniform last-writer-wins ⊕ — a
   representational fix for the paper's dominant measured failure mode (68% of
   open-model errors were premature overwrites/deletions).
5. On completion, the episode's transcript span is *deterministically compacted*: it
   is replaced in all later contexts by (P-header, final Σ, result). Later pi
   compaction is owned by this extension and summarizes that safe view, never the raw
   episode span. The paper does not address what follows an episode; pi sessions continue.

---

## 2. Architecture overview

```
                       ┌────────────────────────────────────────────┐
                       │ session file (append-only, full fidelity)  │
                       │  user msgs · assistant msgs (R_t, a_t)     │
                       │  tool results (O_t) · custom entries       │
                       └───────────────┬────────────────────────────┘
                                       │ deep copy, per turn
                                       ▼
   mode Inactive ──────────── context handler ──────────── mode Active(run)
   pass through, but                                       assemble bounded view:
   collapse completed            fold accepted               [ system + runtime contract ]
   episode spans to              state_patch calls           [ P: skill body + task args ]
   (P-header, Σ_final,           along active branch         [ Σ_t rendered canonically  ]
    result)                          │                       [ user steers since entry   ]
                                     ▼                       [ window: last k turns'     ]
                                  Σ_t (cached                [   a_t + O_t, prose        ]
                                  per leaf)                  [   stripped                ]
```

Model-visible surface while Active: the `state_patch` and `skill_complete` tools,
plus the unchanged action toolset. The runtime contract (appendix A) tells the model:
*anything not recorded in Σ before the window slides is gone.*

---

## 3. The state algebra

This section is normative; every law stated here becomes a property test (§13).

### 3.1 Types

```
State       ::= JSON object conforming to StateSchema (checked, canonical form)
PatchWire   ::= { operations: [ { path, action, value } ... ] }
Operation   ::= checked (RFC6901 path, policy action, decoded JSON value)
Patch       ::= free sequence of Operation
StateSchema ::= closed supported schema; every field carries a MergePolicy
MergePolicy ::= lww | append | union | sum | max | once
```

`PatchWire.value` is a JSON string. This deliberate second boundary makes the outer
TypeBox schema strict-compatible: `operations`, `path`, `action`, and `value` are all
required, while the decoded payload retains the full JSON value language.

- The state schema **must** be an object schema with `additionalProperties: false`
  at every object level (closed world).
- Σ_0 is defaults applied recursively to the empty root object and must validate.
  Optional absent parent objects are not synthesized solely for child defaults.
- Policies are declared per property via an `x-skill-state` annotation
  (`{"x-skill-state": {"merge": "append"}}`); omitted ⇒ `lww`.
- `sum` fields use JSON Schema `integer`; every state and delta must be a JavaScript
  safe integer, and overflow is rejected atomically.
- Operations may descend only through `lww` object fields. Paths into arrays or
  through policy fields are rejected.

### 3.2 The merge operator ⊕

Each operation names one field and an action compatible with that field's policy:

| Policy | Action | Decoded payload | ⊕ on the field | Neutral payload |
|---|---|---|---|---|
| `lww` | `lww-set` / `lww-delete` | full replacement / `null` | replace / delete | n/a |
| `append` | `append` | array of new items | `xs ++ Δ` | `[]` |
| `union` | `union` | array of scalars | canonical set union | `[]` |
| `sum` | `sum` | safe integer delta | exact checked addition | `0` |
| `max` | `max` | finite number candidate | `max(x, Δ)` | absent state |
| `once` | `once` | value | set if unset; same value is a no-op; different value errors | existing equal value |

Neutral append/union/sum operations do not materialize absent optional fields.
Every multi-operation tool call is atomic: static path/action/payload errors are
accumulated first, state-dependent guards next, then closure and budget are checked.
No unchecked candidate escapes.

### 3.3 Laws

A single RFC 7386 object is not closed under composition (delete an object, then set
one child is the minimal counterexample). Therefore Patch is the free sequence of
checked operations, and composition `⋄` is sequence concatenation rather than an
unsound flattened object.

1. **Identity:** `apply(σ, []) = σ`.
2. **Action law:** `apply(σ, p ⋄ q) = apply(apply(σ, p), q)` for accepted sequences.
3. **Free-monoid law:** sequence concatenation is associative with `[]` as identity.
4. **Closure:** successful application always returns a new checked `State`; failed
   guards, schema closure, unsafe arithmetic, or budget checks return structured
   errors and leave the source state unchanged.
5. **Canonical form:** `render(σ)` is canonical JSON (sorted keys, finite normalized
   numbers, `union` fields in canonical element order) and `parse(render(σ)) = σ`.

`once`, closure, and budget make acceptance state-dependent. Algebraic claims are
therefore over accepted operation programs, not over arbitrary wire payloads.

---

## 4. Boundaries

Per the correct-by-construction discipline, each boundary names its raw type,
checked type, parse, print, and round-trip law. Raw types appear **only** in these
boundary modules.

| # | Boundary | Raw (wire) | Checked | Parse | Errors |
|---|---|---|---|---|---|
| B1 | Skill schema | `state.schema.json` bytes | `StateSchema` | JSON → structural walk → policy table + derived `PatchSchema` + Σ_0 | accumulated, path-addressed; skill refuses to arm |
| B2 | Model patch | strict-compatible tagged operation args (unknown) | `Patch` | TypeBox outer validation → JSON payload parse → path/policy validation → state-dependent guards/closure/budget | **applicative by dependency phase**; rejected atomically with structured path-addressed issues |
| B3 | Session entries | persisted custom-entry JSON | versioned entry types (`V1`, append-only decoders) | tagged-union parse; unknown version ⇒ loud failure, mode refuses to reconstruct | structured; never silently skipped |
| B4 | Prompt render | — (print direction) | — | `render : State → CanonicalJson`; `parse ∘ render = id` (law 3.3.5) | n/a |
| B5 | Task arguments | invoking prompt text | `TaskParams` (frozen string, part of P) | captured verbatim at mode entry | n/a |

B2 details, since it is the load-bearing boundary:

- Errors use RFC 6901 paths and name the expected action/payload and what was
  found — e.g. `/operations/0/value: policy append: expected JSON array delta;
  found object` — because the tool error *is* the model's retry signal.
- A patch that fails any check is rejected **atomically**: no partial application.
- Schema-hash guard: every `state_patch` execution re-checks that the armed
  `StateSchema` hash matches the hash pinned at mode entry; a mid-run change of the
  skill's schema file fails loudly with instructions to stop and restart the mode.
- Budget guard: if `render(apply(σ, p))` exceeds the configured state-token budget
  (estimated; §7), the patch is rejected with a structured error telling the model
  the budget and the current heaviest fields, so it can prune (`lww` delete /
  restructure) before continuing.

---

## 5. Runtime protocol (mode state machine)

```
ModeState ::= Inactive
            | Active { runId, skillName, schemaHash, frozen(P, schema, config), enteredAtEntryId }
            | -- terminal transitions back to Inactive:
            --   Completed { result } via skill_complete
            --   Stopped             via /skill-state stop
```

The machine is a pure transition function in the core; the extension shell holds the
current `ModeState` and reconstructs it after `session_start` / branch navigation by
folding B3 entries along the active branch (the same branch-aware reconstruction
pattern as pi-loop-antidote's statistics). Illegal transitions (patch while
Inactive, double entry) are unrepresentable in the core's types; at the shell they
surface as structured tool errors.

**Entry** — either path:
- `/skill-state start <skill> [args…]` (explicit), or
- automatic arming when a skill whose metadata declares a state schema is invoked
  via `/skill:name` (interception at the `input` event).

On entry: parse B1; freeze the skill body, arguments, schema bytes, schema hash,
and run configuration into the versioned `mode-entered` entry; Σ := Σ_0. Snapshotting
is required for deterministic replay after skill files change or disappear.

**Steady state** — per turn, the `context` handler assembles, from the transcript
copy it receives plus the folded Σ (pure function; no hidden state):

1. System prompt: pi's base prompt (unchanged) + the runtime contract (appendix A),
   appended via `before_agent_start`'s `systemPrompt` chain while Active.
2. One user message containing P — byte-stable across the whole episode
   (prompt-cache-friendly prefix).
3. One user message containing `render(Σ_t)` with its schema-derived field notes.
4. All *steering* user messages sent since mode entry, verbatim, in order. The
   invoking `/skill:name` message is excluded because its body and arguments are P.
5. The observation window: the last **k** turns' assistant messages with prose and
   thinking blocks **stripped** but tool-call blocks retained, each followed by its
   tool results — retaining a_t and O_t while discarding R_t, and keeping
   call/result pairing valid for every provider.

Anything older than the window and not folded into Σ is absent. That absence is the
paper's forcing function and is stated plainly in the runtime contract.

**Patch turns:** `state_patch` executes in sequential mode. Each call carries one or
more tagged operations; calls in one assistant message apply in emission order.
Successful result details attest version, run, schema hash, and state token estimate;
the fold replays only matching non-error results and their recorded call arguments.
Persisted results must occur in proposal-emission order; duplicate or out-of-order
results are malformed B3 input and block reconstruction.

**Nudge:** if a turn ends with tool executions but no accepted `state_patch`, and the
next turn's window would evict unrecorded observations, the context handler injects a
one-line reminder into the observation window. Deterministic, bounded, no LLM judge.

**Exit:**
- `skill_complete { result }` must be the only tool call in its assistant message.
  It returns `terminate: true`; after the successful result is persisted, `turn_end`
  appends `mode-exited` carrying `outcome`, `result`, and final rendered Σ. Delaying
  the boundary preserves valid call/result pairing.
- `/skill-state stop` → same entry with `outcome: "stopped"`.

**After exit** (mode Inactive): the context handler replaces the episode's span —
every message between `mode-entered` and `mode-exited` — with a single synthetic
pair: a compact P-header ("executed skill X with args Y") and the final Σ + result.
This projection uses no summarizer model: final state is the episode's sufficient
statistic. If later pi compaction is requested, the extension summarizes this
projected safe view with the active model and returns a custom compaction result;
the raw episode reasoning is never supplied to that summarizer.

---

## 6. Extension surface

**Tools** (registered only surface-relevant; both carry `promptSnippet`):

- `state_patch` — parameters: strict-compatible tagged operations
  `{ operations: [{ path, action, value }] }`; `value` is JSON text. `executionMode:
  "sequential"`. Optional required JSON-schema constrained sampling is flag-gated.
- `skill_complete` — parameters: `{ result: string }` (concise outcome the
  post-episode transcript keeps).

Deliberately **no** `state_get` tool: Σ is always fully present in the prompt; a
read-back tool would be a second source of the same truth.

**Commands:**

- `/skill-state start <skill> [args…]` · `/skill-state stop` · `/skill-state status`
  (mode, turns, patches, Σ token estimate, budget) · `/skill-state show` (rendered
  Σ via the mode-appropriate notification surface).

**CLI flags** (pi 0.84.2 exposes no extension settings-registration API):

| Flag | Type | Default | Meaning |
|---|---|---|---|
| `skill-state-window-turns` | string (int 1–8) | `2` | observation window k |
| `skill-state-budget-tokens` | string (int) | `4000` | max estimated tokens for rendered Σ |
| `skill-state-constrained-sampling` | boolean | `false` | require JSON-schema constrained sampling for tagged operations |

**UI:** footer status via `ctx.ui.setStatus`, e.g. `Σ 1.2k · t47 · p31` (state
token estimate, turns in episode, accepted patches); entry renderers for
`mode-entered` / `mode-exited`; `state_patch` gets a `renderCall`/`renderResult`
showing the delta compactly.

**Skill declaration** (Agent Skills-conformant — `metadata` is the spec's arbitrary
key-value escape hatch, so nothing here violates the standard):

```yaml
name: warehouse-audit
description: …
metadata:
  skill-state: ./state.schema.json     # path relative to SKILL.md
```

---

## 7. Persistence, branching, replay

- **Source of truth for Σ:** the session log itself. Recorded `state_patch` calls are
  proposals; a matching non-error result with versioned acceptance details is the
  acceptance fact. The fold pairs them by call ID, requires result order to match
  proposal-emission order, and re-applies operations in that order. Duplicate,
  orphaned, or out-of-order results fail loudly. No duplicate patch custom entry is
  written.
- **Custom entries (B3)** record facts not otherwise reconstructible: `mode-entered`
  snapshots run ID, skill identity, exact P, schema bytes/hash, source, and run config;
  `mode-exited` stores outcome, result, and final rendered Σ. Both are wire-versioned
  (`v: 1`) with append-only decoders and golden fixtures.
- **Branching:** pi sessions are trees. Σ and ModeState are always reconstructed by
  folding along the *active* branch — fork/`navigateTree` into the middle of an
  episode yields exactly the Σ at that point, by construction. The in-memory Σ is a
  per-leaf cache, invalidated on `session_start`, `session_tree`, and branch
  switches; recomputation is a fast pure fold.
- **Token estimation:** chars/4 heuristic, labeled as an estimate everywhere it
  surfaces. pi does not expose a tokenizer to extensions; the budget is a guard
  rail, not an accounting system.

---

## 8. Compatibility and interactions

- **Compaction and tree summaries:** `session_before_compact` cancels while Active.
  After exit, branches containing completed episodes use a custom compaction over the
  deterministic collapsed view, with cuts adjusted so episodes are never split.
  `session_before_tree` likewise detects abandoned spans touching active/completed
  episodes and summarizes an abandoned-span-only safe bounded/collapsed view instead
  of raw entries; unrelated common-prefix messages are excluded.
  Either path fails closed by cancelling when a safe summary cannot be produced.
- **Other history/summary-rewriting extensions:** `context` and `session_before_*`
  handlers chain in extension load order. skill-state is **not composition-safe**
  with another extension that rewrites model history or independently summarizes
  raw branches: a later result can replace the bounded view, while an earlier
  summarizer may already have observed raw episode entries. The privacy contract
  therefore requires skill-state to be the sole history/compaction/tree-summary
  rewriter. Tool-level extensions that merely request pi's normal compaction remain
  compatible because this extension still owns the resulting event; context-mode's
  tool-result indexing does not rewrite session history.
- **pi-loop-antidote:** operates on assistant-stream pathology and quarantines
  messages; quarantined messages are simply absent from the transcript copy the fold
  sees. No coupling.
- **Modes:** works in TUI, `--print`, and RPC modes (no TUI-only dependencies in the
  core path; UI surface is guarded by `ctx.hasUI` / `mode === "tui"`).
- **Subagents:** out of scope for v1 (§15).

---

## 9. Failure modes → design responses

Mapping the paper's measured error taxonomy (its Experiment 7) to this design:

| Paper failure (share) | Design response |
|---|---|
| Premature overwrite/deletion (68%) | Policy fields make overwrite/delete unrepresentable (§3.2); `lww` remains only where replacement is the intended semantics |
| Schema type mismatch (20%) | Strict-compatible outer TypeBox schema plus path/policy/payload validation with accumulated retry errors |
| JSON formatting (12%) | Outer operation structure uses native tool arguments and optional constrained sampling; malformed inner JSON payload text is rejected precisely at `/operations/i/value` |
| Model forgets to record before window slides | Deterministic nudge (§5); window k ≥ 1 gives one turn of grace |
| Model never calls `skill_complete` | Runtime contract instruction + `/skill-state stop` escape hatch; status surface shows the episode is still open |

---

## 10. Complexity and cache behavior

- Prompt size per turn: O(|P| + |Σ| + k·|turn| + |steers|). |Σ| is budget-capped;
  k is constant; steers are human-bounded. Independent of episode horizon T —
  the paper's bounded-footprint property.
- Cumulative episode tokens: O(T).
- Prefix stability: system prompt + P are byte-identical across the episode and sit
  first, so provider prompt caching covers the largest fixed block. Σ (which
  changes) is placed after the stable prefix, before the window.

---

## 11. Module layout and effect discipline

Pure core, thin imperative shell — the shell registers hooks and owns I/O; every
decision is a pure function the tests can call directly. Same layout and test
harness pattern as pi-loop-antidote (this machine's existing local extension).

```
pi-skill-state/
  package.json            # "pi": { "extensions": ["./src/index.ts"] }, peer dep pi-coding-agent >= 0.84.2
  SPEC.md                 # this document
  src/
    core/
      json.ts             # one canonical JSON implementation and JSON value boundary helpers
      schema.ts           # B1: raw JSON -> StateSchema; policy tree; strict PatchSchema; Σ0
      state.ts            # checked State, tagged Patch program, apply/compose, canonical render/parse
      fold.ts             # branch scan -> accepted patches -> Σ; ModeState reconstruction
      prompt.ts           # (transcript, ModeState, Σ) -> bounded message array; episode collapse
      mode.ts             # ModeState machine, pure transitions
      errors.ts           # structured error sums (schema, patch, version), rendering to tool errors
    index.ts              # shell: hooks (context, before_agent_start, input, session_*), tools, commands, flags, UI
  skills/
    warehouse-audit/      # bundled long-horizon smoke/acceptance skill and schema
  scripts/
    verify-live-session.mjs # persisted real-pi protocol-evidence checker
  tests/
    acceptance.test.ts    # 50-turn bounded-footprint and ground-truth acceptance
    state.test.ts         # generated accepted traces, laws, closure, policies, render round-trip
    schema.test.ts        # B1 accept/reject corpus; derivation golden files
    fold.test.ts          # determinism, branch reconstruction, error-result exclusion
    prompt.test.ts        # window assembly, prose stripping keeps call/result pairing, collapse
    entries.test.ts       # B3 golden wire fixtures (v1), unknown-version rejection
    extension.test.ts     # shell wiring against a scripted session harness
    live-session.test.ts  # exact persisted-evidence checker accept/reject corpus
```

Effect notes: `Date.now`/randomness only for runIds in the shell; the core takes
them as arguments. No filesystem access in core (schema bytes are read by the shell,
parsed by the core). Errors are sums, never strings; every boundary error renders to
both a tool error (model-facing) and a UI notification (human-facing) from the same
structured value. A mode-entry/exit persistence failure is converted to a structured
`boundary-io` error and blocks tools/context for that session, so a host write that
fails after mutating in-memory session state cannot start an undurable episode.

---

## 12. What the model sees (contract summary)

Appendix A carries the full runtime-contract text. Its obligations, which the design
enforces rather than requests wherever possible:

1. Record every fact you will need later into state via `state_patch` — the
   transcript window slides and unrecorded observations disappear. *(Enforced by
   construction of the context; softened by the nudge.)*
2. Policy fields accept deltas only. *(Enforced at B2.)*
3. When the procedure's goal is met, call `skill_complete` with a concise result.
   *(Requested; escape hatch exists.)*

---

## 13. Verification plan

- **Law properties (fast-check):** §3.3 laws 1–5 over accepted tagged-operation
  programs, including neutral deltas, exact safe-integer arithmetic, atomic once
  conflicts, closure, and the delete/rebuild counterexample that forbids flattening.
- **Boundary tests:** B1/B2 accept and *reject* corpora with exact error paths; B3
  golden wire fixtures committed and version-pinned; B4 render/parse round-trip as a
  property.
- **Fold tests:** replay determinism; branch fork mid-episode reconstructs the
  correct Σ; failed `state_patch` results are excluded; out-of-order/duplicate
  results and schema-hash mismatches are detected.
- **Prompt assembly tests:** window slicing keeps provider-valid call/result
  pairing; prose/thinking stripped; collapse of a completed span; steer retention.
- **Integration:** scripted session harness (as in pi-loop-antidote's
  `extension.test.ts`) driving the shell end to end without a live model, including
  headless UI guards, schema disappearance, safe tree/compaction spans, and
  fail-closed mode-entry persistence.
- **Long-horizon acceptance:** the bundled warehouse-style harness runs 50 accepted
  turns, asserts the projected message count and serialized footprint remain flat,
  and checks final ground truth. This deterministic test avoids paying for 50
  redundant live model turns.
- **Live pi acceptance:** run the bundled skill through the real pi 0.84.2 CLI both
  normally and with `--skill-state-constrained-sampling`; use
  `scripts/verify-live-session.mjs` to check persisted evidence for mode entry,
  tagged patch, acceptance details, sole completion call, delayed exit, and exact
  final state.

---

## 14. Decisions and stated trade-offs

1. **Window k = 2 turns (configurable), not the paper's single latest observation.**
   Cost: a constant token factor. Buys: one turn of grace when the model acts before
   recording — the failure the paper's own error analysis says dominates. Still O(1).
2. **User steers retained verbatim.** Deviates from a pure (P, Σ, O) prompt; growth
   is bounded by human typing rate, and folding user directives into Σ via the model
   would risk losing exactly the instructions that must not be lost.
3. **ΔΣ is a strict-compatible tagged-operation tool call.** Cost: each payload is
   JSON text and parsed once at B2. Buys: all outer fields remain required under pi
   0.84.2 strict conversion, path/action intent is explicit, and malformed payloads
   receive a precise retry error.
4. **Per-field merge policies extend the paper's ⊕.** Cost: a small action vocabulary
   the skill author/model must learn. Buys: overwrite and deletion are structurally
   unavailable for append/union/sum/max/once fields.
5. **Patch composition is a free operation program, not a flattened merge object.**
   RFC object patches are not closed under delete-then-rebuild composition. Sequence
   retention costs one tiny wrapper and makes identity/action/associativity true by
   construction.
6. **Not composition-safe with other history or summary rewriters.** This includes
   `context`, `session_before_compact`, and `session_before_tree` handlers that inspect
   or replace the same history. The privacy guarantee requires skill-state to be the
   sole handler in those categories; tool-level extensions that only trigger pi's
   normal paths remain compatible.
7. **Reasoning is dropped from context but kept on disk.** Session files grow as
   normal pi sessions do; the paper's storage frugality is not a goal here —
   auditability and branch replay are worth more in an interactive agent.
8. **Final Σ is denormalized into the `mode-exited` entry** even though it is
   derivable by fold. Justification: the post-episode collapsed view must remain
   byte-stable across future extension upgrades that might change fold details; this
   is the same reason pi's compaction entries store their summaries. Within a live
   episode the fold remains the only truth.
9. **`once`, closure, and budgets make acceptance state-dependent.** Laws are over
   accepted free programs; tool calls remain atomic transitions.
10. **Episodes own later compaction and branch summarization.** Cost: one summarizer
    call using the active model when pi compacts or summarizes an affected `/tree`
    branch. Buys: raw episode reasoning never re-enters through either pi path;
    failures cancel safely.
11. **Run entries snapshot P, schema bytes, and configuration.** One larger entry per
    episode buys deterministic branch replay after source changes.
12. **Configuration is CLI-only in v1.** Pi 0.84.2 has no extension settings
    registration API; shadow-reading settings would duplicate trust and precedence.
13. **Completion is explicit** (`skill_complete`), not inferred by a judge model —
   consistent with the local doctrine (cf. pi-loop-antidote) that no LLM arbitrates
   control flow.

## 15. Out of scope (v1) / future work

- **Ad-hoc episodes** (no pre-authored schema): the model proposes a schema at
  entry, B1-checks it, then it freezes and becomes part of P. Addresses the paper's
  "schema unknown a priori" limitation; deferred so v1 stays small.
- **Multi-writer state** (pi-subagents): `union` and `max` are candidates for
  order-independent merging; lww/append/once and bounded exact sums need explicit
  ordering/conflict decisions. The paper flags this as open; revisit after v1.
- **Schema migrations** across skill versions (V1→V2 total migrations at B3).
- **SkillExecBench-style evaluation harness** replicating the paper's scaling and
  noise experiments against pi runtimes.

---

## Appendix A — runtime contract (sketch, injected while Active)

> You are executing the procedure below under a bounded-state runtime. Your context
> contains only: the procedure, the current execution state, your instructions from
> the user, and your last few actions with their results. **Older history is not
> visible and will not return.** Any fact you need later — discoveries, decisions,
> progress, hypotheses ruled out — must be written into state with `state_patch`
> before it leaves the window. Keep state minimal and current: remove or compact
> entries that no longer matter (fields marked append/union/sum/max take deltas and
> cannot be overwritten). When the procedure's goal is achieved, call
> `skill_complete` with a concise result.

## Appendix B — example skill schema

```json
{
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "working_dir":        { "type": "string" },
    "phase":              { "type": "string", "enum": ["scan", "fix", "verify"], "default": "scan" },
    "shelves_done":       { "type": "array", "items": { "type": "string" }, "default": [],
                            "x-skill-state": { "merge": "union" } },
    "defects_found":      { "type": "array",
                            "items": { "type": "object", "additionalProperties": false,
                                       "properties": { "shelf": {"type": "string"},
                                                        "issue": {"type": "string"} },
                                       "required": ["shelf", "issue"] },
                            "default": [], "x-skill-state": { "merge": "append" } },
    "items_counted":      { "type": "integer", "default": 0,
                            "x-skill-state": { "merge": "sum" } },
    "baseline_commit":    { "type": "string",
                            "x-skill-state": { "merge": "once" } },
    "notes":              { "type": "string" }
  }
}
```

`working_dir`, `phase`, `notes` are `lww` (replaceable cursors); the sweep's
accumulators cannot be clobbered; the baseline is write-once.

## Appendix C — episode walkthrough (abridged)

1. User: `/skill-state start warehouse-audit aisle=7` → B1 parses schema, P frozen,
   `mode-entered` appended, Σ = defaults.
2. Turn 1: model reads a shelf list, then calls
   `state_patch {operations:[{path:"/shelves_done",action:"union",value:"[\\"7-01\\"]"},{path:"/items_counted",action:"sum",value:"42"}]}`.
3. Turn 5: model emits action `lww-delete` for `/shelves_done` — **rejected at B2**
   because that path has policy `union`; the retry error names the action and path.
4. Turn 6: context = system+contract · P · Σ (5 shelves, 214 items) · window of
   turns 4–5. Turn 1's transcript is gone; its facts live in Σ.
5. Turn 41: `skill_complete {result: "aisle 7 audited; 3 defects"}` →
   `mode-exited` appended with final Σ.
6. Later turns see one compact block: procedure header, final Σ, result. Normal
   transcript semantics resume.
