#!/usr/bin/env node
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { formatErrors } from "../src/core/errors.ts";
import { reconstructBranch } from "../src/core/fold.ts";

const [target, constrainedText, expectedFinal] = process.argv.slice(2);
if (!target || !["true", "false"].includes(constrainedText) || expectedFinal === undefined) {
  console.error("usage: tsx scripts/verify-live-session.mjs <session.jsonl|session-dir> <true|false> <expected-final-json>");
  process.exit(2);
}

const files = await jsonlFiles(resolve(target));
if (files.length !== 1) fail(`expected one session JSONL file; found ${files.length}`);
const entries = (await readFile(files[0], "utf8"))
  .split("\n")
  .filter(Boolean)
  .map((line, index) => {
    try {
      return JSON.parse(line);
    } catch (error) {
      fail(`invalid JSON on line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });

const modes = entries.filter((entry) => entry.type === "custom" && entry.customType === "skill-state/mode");
const entered = modes.filter((entry) => entry.data?.kind === "mode-entered");
const exited = modes.filter((entry) => entry.data?.kind === "mode-exited");
if (entered.length !== 1 || exited.length !== 1) fail(`expected one entry and exit; found ${entered.length}/${exited.length}`);
const start = entered[0];
const finish = exited[0];
if (start.data.config?.constrainedSampling !== (constrainedText === "true")) {
  fail(`constrainedSampling mismatch: ${JSON.stringify(start.data.config?.constrainedSampling)}`);
}
if (finish.data.outcome !== "completed") fail(`expected completed outcome; found ${JSON.stringify(finish.data.outcome)}`);
if (finish.data.runId !== start.data.runId || finish.data.schemaHash !== start.data.schemaHash) {
  fail("entry/exit run or schema identity mismatch");
}
const replay = reconstructBranch(entries);
if (!replay.ok) fail(`session replay failed:\n${formatErrors(replay.errors)}`);
if (replay.value.completed.length !== 1 || replay.value.active) {
  fail(`expected one replay-verified completed episode; found ${replay.value.completed.length}`);
}

const calls = [];
const results = [];
for (const [entryIndex, entry] of entries.entries()) {
  if (entry.type !== "message" || !entry.message) continue;
  const message = entry.message;
  if (message.role === "assistant" && Array.isArray(message.content)) {
    const messageCalls = message.content.filter((part) => part?.type === "toolCall");
    for (const call of messageCalls) calls.push({ entryIndex, messageCalls, call });
  }
  if (message.role === "toolResult") results.push({ entryIndex, result: message });
}
const patchCalls = calls.filter(({ call }) => call.name === "state_patch");
const completionCalls = calls.filter(({ call }) => call.name === "skill_complete");
if (patchCalls.length < 1) fail("no state_patch call found");
if (completionCalls.length !== 1) fail(`expected one skill_complete call; found ${completionCalls.length}`);
if (completionCalls[0].messageCalls.length !== 1) fail("skill_complete was not the sole call in its assistant message");

const successfulPatches = results.filter(({ result }) =>
  result.toolName === "state_patch" &&
  result.isError !== true &&
  result.details?.kind === "skill-state/accepted-patch");
if (successfulPatches.length < 1) fail("no accepted state_patch result found");
for (const { result } of successfulPatches) {
  if (result.details.v !== 1 || result.details.runId !== start.data.runId || result.details.schemaHash !== start.data.schemaHash) {
    fail(`invalid accepted-patch details for ${result.toolCallId}`);
  }
  if (!patchCalls.some(({ call }) => call.id === result.toolCallId)) fail(`orphan accepted result ${result.toolCallId}`);
}
const completion = completionCalls[0];
const completionResult = results.find(({ result }) =>
  result.toolCallId === completion.call.id &&
  result.toolName === "skill_complete" &&
  result.isError !== true);
if (!completionResult) fail("successful skill_complete result not found");
const exitIndex = entries.indexOf(finish);
if (exitIndex <= completionResult.entryIndex) fail("mode exit was not delayed until after the completion result");

const canonicalFinal = canonicalJson(JSON.parse(finish.data.finalState));
if (finish.data.finalState !== canonicalFinal) fail("persisted final state is not canonical JSON");
if (canonicalFinal !== canonicalJson(JSON.parse(expectedFinal))) {
  fail(`final state mismatch: ${canonicalFinal}`);
}
console.log(JSON.stringify({
  session: files[0],
  constrainedSampling: constrainedText === "true",
  acceptedPatches: successfulPatches.length,
  completionCalls: completionCalls.length,
  outcome: finish.data.outcome,
  finalState: canonicalFinal,
}));

async function jsonlFiles(path) {
  const info = await stat(path);
  if (info.isFile()) return path.endsWith(".jsonl") ? [path] : [];
  const names = await readdir(path, { withFileTypes: true });
  const nested = await Promise.all(names.map((entry) => jsonlFiles(resolve(path, entry.name))));
  return nested.flat();
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return Object.is(value, -0) ? 0 : value;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
