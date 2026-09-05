import { test, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import type { Provider } from "../src/types.js";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agentsw-omp-alias-"));
process.env.AGENTSW_HOME = sandbox;
// fsutil captures home at module load, so import adapters only after setting the sandbox.
const { omp } = await import("../src/targets/omp.js");
const { setDryRun, drainPendingWrites, backupsDir } = await import("../src/fsutil.js");
const dir = path.join(sandbox, ".omp", "agent");
const file = path.join(dir, "models.yml");
const provider: Provider = {
  id: "sub",
  name: "Sub",
  protocol: "openai",
  baseUrl: "https://example.test/v1",
  apiKey: "test-key",
  defaultModel: "model-a",
  models: [{ id: "model-a", imageInput: true }, { id: "model-b" }],
};

beforeEach(() => {
  setDryRun(false);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(backupsDir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
});
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const anchoredModels = `# keep the initialization comment
providers:
  sub:
    api: openai-responses
    baseUrl: https://example.test/v1
    headers: # keep provider options
      x-fixture: enabled
    models:
      - id: model-a
        input: &id001 [text, image]
        customInput: *id001
        thinkingLevelMap: &thinking
          high: enabled
      - id: model-b
        input: *id001
        thinkingLevelMap: *thinking
  other:
    baseUrl: https://other.test/v1
    api: openai-completions
    models:
      - id: unrelated
        input: *id001 # keep alias comment
        thinkingLevelMap: *thinking
`;

function load(filePath = file) {
  return YAML.parse(fs.readFileSync(filePath, "utf8"));
}

test("omp first sync resolves model anchors before replacing their definitions", async () => {
  fs.writeFileSync(file, anchoredModels);
  const unrelated = load().providers.other;
  assert.equal(omp.candidates!().find((p) => p.id === "sub")?.openaiApi, "responses");
  for (let pass = 0; pass < 2; pass++) {
    const applied = await omp.apply(provider);
    assert.ok(applied.changed.includes(file));
    const result = load();
    assert.equal(result.providers.sub.api, "openai-responses");
    assert.deepEqual(result.providers.sub.models[0].customInput, ["text", "image"]);
    assert.deepEqual(result.providers.sub.models[1].thinkingLevelMap, { high: "enabled" });
    assert.deepEqual(result.providers.other, unrelated);
    assert.match(fs.readFileSync(file, "utf8"), /# keep the initialization comment/);
    assert.match(fs.readFileSync(file, "utf8"), /# keep provider options/);
    assert.match(fs.readFileSync(file, "utf8"), /# keep alias comment/);
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /source: (id001|thinking)/);
  }
  await omp.prune(provider);
  assert.equal(load().providers.sub, undefined);
  assert.deepEqual(load().providers.other, unrelated);
});

test("omp prune retains aliases whose anchors belonged to the removed provider", async () => {
  fs.writeFileSync(file, anchoredModels);
  const unrelated = load().providers.other;
  await omp.prune(provider);
  assert.deepEqual(load().providers.other, unrelated);
  assert.equal(load().providers.sub, undefined);
});

test("omp sync and prune do not mutate another provider aliased to the managed entry", async () => {
  const text = `providers:
  sub: &shared
    api: openai-responses
    baseUrl: https://old.test/v1
    apiKey: old-key
    headers: {x-custom: preserved}
    models: [{id: model-a, customOption: true}]
  other: *shared
`;
  for (const action of ["apply", "prune"] as const) {
    fs.writeFileSync(file, text);
    const other = load().providers.other;
    await omp[action](provider);
    assert.deepEqual(load().providers.other, other);
    if (action === "apply") assert.equal(load().providers.sub.apiKey, provider.apiKey);
  }
});

test("omp applies to a provider alias and preserves its unowned fields", async () => {
  const text = `template: &defaults
  api: openai-responses
  baseUrl: https://old.test/v1
  authHeader: true
  headers: {x-custom: preserved}
  models: [{id: model-a, customOption: true}]
providers:
  sub: *defaults # keep provider alias comment
`;
  fs.writeFileSync(file, text);
  const template = load().template;
  await omp.apply(provider);
  const result = load();
  assert.deepEqual(result.template, template);
  assert.equal(result.providers.sub.authHeader, true);
  assert.deepEqual(result.providers.sub.headers, template.headers);
  assert.equal(result.providers.sub.models[0].customOption, true);
  assert.equal(result.providers.sub.api, "openai-responses");
  assert.match(fs.readFileSync(file, "utf8"), /# keep provider alias comment/);
});

test("omp handles an aliased providers map in the models.yaml fallback", async () => {
  const fallback = path.join(dir, "models.yaml");
  fs.writeFileSync(fallback, `defaults: &all
  other:
    api: openai-completions
    baseUrl: https://other.test/v1
    models: [{id: untouched}]
providers: *all
`);
  const defaults = load(fallback).defaults;
  await omp.apply(provider);
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(load(fallback).defaults, defaults);
  assert.equal(load(fallback).providers.sub.apiKey, provider.apiKey);
  await omp.prune(provider);
  assert.deepEqual(load(fallback).providers, defaults);
});

test("omp rejects invalid or cyclic YAML before backups or writes", async () => {
  for (const text of [
    "providers:\n  sub:\n    models: *id001\n",
    "providers:\n  sub:\n    models: [\n",
    "providers:\n  sub: &loop\n    nested: *loop\n",
    "providers: []\n",
    "- not a config object\n",
  ]) {
    for (const action of ["apply", "prune"] as const) {
      fs.writeFileSync(file, text);
      await assert.rejects(omp[action](provider), (error: Error) => {
        assert.ok(error.message.includes(file), "error identifies the affected file");
        return true;
      });
      assert.equal(fs.readFileSync(file, "utf8"), text);
      assert.equal(fs.existsSync(backupsDir), false);
    }
  }
});

test("omp alias dry-run previews a valid config without changing source or backups", async () => {
  fs.writeFileSync(file, anchoredModels);
  setDryRun(true);
  try {
    await omp.apply(provider);
    const writes = drainPendingWrites();
    assert.equal(writes.length, 1);
    assert.equal(writes[0]!.file, file);
    const preview = YAML.parse(writes[0]!.content);
    assert.deepEqual(preview.providers.other, load().providers.other);
    assert.equal(fs.readFileSync(file, "utf8"), anchoredModels);
    assert.equal(fs.existsSync(backupsDir), false);
  } finally {
    setDryRun(false);
  }
});

test("omp initializes an absent models file and remains stable on repeated sync", async () => {
  await omp.apply(provider);
  const first = load();
  await omp.apply(provider);
  assert.deepEqual(load(), first);
  assert.equal(first.providers.sub.baseUrl, provider.baseUrl);
});
