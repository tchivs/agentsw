import { test } from "node:test";
import assert from "node:assert/strict";
import { applyModelFilter, snapshotBase } from "../src/filter.js";

test("snapshotBase strips snapshot suffixes only", () => {
  assert.equal(snapshotBase("gpt-5.2-latest"), "gpt-5.2");
  assert.equal(snapshotBase("gpt-5.2-2025-12-11"), "gpt-5.2");
  assert.equal(snapshotBase("claude-sonnet-4-5-20250929"), "claude-sonnet-4-5");
  assert.equal(snapshotBase("glm-4.7-250414"), "glm-4.7");
  assert.equal(snapshotBase("kimi-k2-0905"), "kimi-k2");
  // real variants must NOT be stripped
  assert.equal(snapshotBase("glm-4.7-air"), "glm-4.7-air");
  assert.equal(snapshotBase("kimi-k2-thinking"), "kimi-k2-thinking");
  assert.equal(snapshotBase("gpt-5.2-mini"), "gpt-5.2-mini");
});

test("default dedup drops suffixed duplicates of a listed bare id", () => {
  const { kept, dropped } = applyModelFilter(
    ["gpt-5.2", "gpt-5.2-latest", "gpt-5.2-2025-12-11", "glm-4.7", "glm-4.7-air"],
    undefined,
  );
  assert.deepEqual(kept, ["gpt-5.2", "glm-4.7", "glm-4.7-air"]);
  assert.deepEqual(
    dropped.map((d) => d.id),
    ["gpt-5.2-latest", "gpt-5.2-2025-12-11"],
  );
});

test("snapshot-only models are never collapsed or dropped", () => {
  const { kept } = applyModelFilter(["gpt-4-0125", "gpt-4-0613", "kimi-k2-0905"], undefined);
  assert.deepEqual(kept, ["gpt-4-0125", "gpt-4-0613", "kimi-k2-0905"]);
});

test("dedup: false keeps duplicates", () => {
  const ids = ["gpt-5.2", "gpt-5.2-latest"];
  assert.deepEqual(applyModelFilter(ids, { dedup: false }).kept, ids);
});

test("exclude globs and bare substrings", () => {
  const { kept } = applyModelFilter(
    ["gpt-5.2", "text-embedding-3-small", "grok-imagine-video"],
    { exclude: ["*embedding*", "video"] },
  );
  assert.deepEqual(kept, ["gpt-5.2"]);
});

test("include restricts to matching ids", () => {
  const { kept } = applyModelFilter(["gpt-5.2", "glm-4.7", "kimi-k2.5"], { include: ["gpt-*", "glm-*"] });
  assert.deepEqual(kept, ["gpt-5.2", "glm-4.7"]);
});

test("pinned ids survive every filter stage", () => {
  const { kept } = applyModelFilter(
    ["gpt-5.2", "gpt-5.2-latest", "old-model"],
    { include: ["gpt-*"] },
    ["gpt-5.2-latest", "old-model"],
  );
  assert.deepEqual(kept, ["gpt-5.2", "gpt-5.2-latest", "old-model"]);
});
