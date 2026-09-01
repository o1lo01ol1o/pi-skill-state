import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseModeEntry } from "../src/core/mode.js";

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
