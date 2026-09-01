import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { acceptRuntimePatch } from "../src/core/fold.js";
import {
  enterMode,
  exitMode,
  inactiveMode,
  parseModeEntry,
  type ActiveMode,
  type ModeEnteredV1,
  type ModeExitedV1,
} from "../src/core/mode.js";

for (const fixture of ["mode-entered-v1.json", "mode-exited-v1.json"]) {
  test(`B3 parses golden wire fixture ${fixture}`, async () => {
    const raw = JSON.parse(await readFile(new URL(`./fixtures/${fixture}`, import.meta.url), "utf8"));
    const parsed = parseModeEntry(raw);
    assert.equal(parsed.ok, true);
    if (parsed.ok) assert.equal(parsed.value.v, 1);
  });
}

test("B3 rejects unknown versions loudly", () => {
  const parsed = parseModeEntry({ v: 2, kind: "mode-entered" });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) {
    assert.ok(parsed.errors.some((error) => error.kind === "entry" && error.code === "entry-version"));
  }
});

test("B3 rejects unknown fields within a wire version", async () => {
  const raw = JSON.parse(await readFile(new URL("./fixtures/mode-entered-v1.json", import.meta.url), "utf8"));
  raw.unversionedFutureField = true;
  const parsed = parseModeEntry(raw);
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.ok(parsed.errors.some((error) => "path" in error && error.path === "/unversionedFutureField"));
});

function protocolTransitionTypeWitness(
  active: ActiveMode,
  entered: ModeEnteredV1,
  exited: ModeExitedV1,
): void {
  if (false) {
    // @ts-expect-error Entry requires an inactive protocol witness.
    enterMode(active, "duplicate", entered);
    // @ts-expect-error Exit requires an active protocol witness.
    exitMode(inactiveMode, exited);
    // @ts-expect-error Protocol patching requires a checked ActiveRuntime witness.
    acceptRuntimePatch(inactiveMode, {});
  }
}
void protocolTransitionTypeWitness;

test("B3 accumulates malformed entry fields", () => {
  const parsed = parseModeEntry({
    v: 1,
    kind: "mode-exited",
    runId: 4,
    outcome: "maybe",
    result: null,
    finalState: 7,
  });
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.ok(parsed.errors.length >= 5);
});
