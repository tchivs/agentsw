import { test, before } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";

// Adapters resolve paths from os.homedir()/process.env.HOME at import time,
// so the sandbox HOME must be set before importing them.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ssw-test-"));
process.env.HOME = sandbox;
process.env.WORKBUDDY_CONFIG_DIR = path.join(sandbox, ".workbuddy");
delete process.env.CODEBUDDY_CONFIG_DIR;
delete process.env.HERMES_HOME;
delete process.env.PI_CODING_AGENT_DIR;
delete process.env.PRIME_AGENT_CODING_AGENT_DIR;

// Dynamic import is intentional: fsutil captures os.homedir() at module init,
// so the sandbox HOME above must be exported before the adapters load.
const { targets, supportsProtocol } = await import("../src/targets/index.js");

import type { Provider } from "../src/types.js";

const provider: Provider = {
  id: "testprov",
  name: "Test Provider",
  protocol: "openai",
  baseUrl: "https://api.test.example/v1",
  apiKey: "sk-test",
  defaultModel: "model-a",
  models: [
    { id: "model-a", name: "Model A", reasoning: true, reasoningEfforts: ["low", "high"], contextWindow: 100000, maxOutput: 8192, imageInput: true },
    { id: "model-b" },
  ],
};

before(() => {
  // pre-existing content that every adapter must preserve
  fs.mkdirSync(path.join(sandbox, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(sandbox, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(sandbox, ".omp", "agent"), { recursive: true });
  fs.mkdirSync(path.join(sandbox, ".pi", "agent"), { recursive: true });
  fs.mkdirSync(path.join(sandbox, ".prime", "agent"), { recursive: true });
  fs.mkdirSync(path.join(sandbox, ".config", "opencode"), { recursive: true });
  fs.mkdirSync(path.join(sandbox, ".hermes"), { recursive: true });
  fs.mkdirSync(path.join(sandbox, ".workbuddy"), { recursive: true });
  fs.writeFileSync(path.join(sandbox, ".codex", "config.toml"), 'model = "keep-model"\n\n[features]\ngoals = true\n');
  fs.writeFileSync(
    path.join(sandbox, ".omp", "agent", "models.yml"),
    "# keep this comment\nproviders:\n  keepme:\n    baseUrl: http://keep/v1\n    auth: none\n    api: openai-completions\n    models:\n      - id: m\n",
  );
  fs.writeFileSync(path.join(sandbox, ".hermes", "config.yaml"), "# hermes comment\nagent:\n  reasoning_effort: high\n");
  fs.writeFileSync(path.join(sandbox, ".config", "opencode", "opencode.json"), '{"theme": "dark"}\n');
});

test("apply + prune roundtrip preserves unrelated config for every app", async () => {
  for (const target of targets) {
    if (!supportsProtocol(target, provider.protocol)) continue;
    const applied = await target.apply(provider);
    assert.ok(applied.changed.length > 0, `${target.id} apply wrote nothing`);
    const pruned = await target.prune(provider);
    assert.ok(pruned.changed.length > 0, `${target.id} prune found nothing to remove`);
    // second prune is a no-op
    const again = await target.prune(provider);
    assert.ok(again.skipped, `${target.id} second prune should skip`);
  }

  // unrelated content survived the roundtrip
  const codexToml = fs.readFileSync(path.join(sandbox, ".codex", "config.toml"), "utf8");
  assert.match(codexToml, /goals = true/);
  const ompYml = fs.readFileSync(path.join(sandbox, ".omp", "agent", "models.yml"), "utf8");
  assert.match(ompYml, /# keep this comment/);
  assert.match(ompYml, /keepme/);
  const hermesYaml = fs.readFileSync(path.join(sandbox, ".hermes", "config.yaml"), "utf8");
  assert.match(hermesYaml, /# hermes comment/);
  assert.match(hermesYaml, /reasoning_effort: high/);
  assert.doesNotMatch(hermesYaml, /model: \{\}/);
  assert.doesNotMatch(hermesYaml, /testprov/);
  const opencodeJson = JSON.parse(fs.readFileSync(path.join(sandbox, ".config", "opencode", "opencode.json"), "utf8"));
  assert.equal(opencodeJson.theme, "dark");
  assert.equal(opencodeJson.provider, undefined);
});

test("omp write carries metadata and stays parseable", async () => {
  const omp = targets.find((t) => t.id === "omp")!;
  await omp.apply(provider);
  const doc = YAML.parse(fs.readFileSync(path.join(sandbox, ".omp", "agent", "models.yml"), "utf8"));
  const entry = doc.providers.testprov;
  assert.equal(entry.api, "openai-completions");
  const modelA = entry.models.find((m: { id: string }) => m.id === "model-a");
  assert.equal(modelA.contextWindow, 100000);
  assert.equal(modelA.maxTokens, 8192);
  assert.deepEqual(modelA.input, ["text", "image"]);
  await omp.prune(provider);
});

test("pi write maps reasoning efforts to thinkingLevelMap", async () => {
  const pi = targets.find((t) => t.id === "pi")!;
  await pi.apply(provider);
  const config = JSON.parse(fs.readFileSync(path.join(sandbox, ".pi", "agent", "models.json"), "utf8"));
  const modelA = config.providers.testprov.models.find((m: { id: string }) => m.id === "model-a");
  assert.equal(modelA.thinkingLevelMap.low, "low");
  assert.equal(modelA.thinkingLevelMap.high, "high");
  assert.equal(modelA.thinkingLevelMap.medium, null);
  assert.equal(config.providers.testprov.api, "openai-completions");
  await pi.prune(provider);
});

test("anthropic provider routes to anthropic wire and skips openai-only apps", async () => {
  const anthro: Provider = { ...provider, id: "anthro", protocol: "anthropic" };
  const codex = targets.find((t) => t.id === "codex")!;
  const workbuddy = targets.find((t) => t.id === "workbuddy")!;
  const claude = targets.find((t) => t.id === "claude")!;
  assert.equal(supportsProtocol(codex, "anthropic"), false);
  assert.equal(supportsProtocol(workbuddy, "anthropic"), false);
  assert.equal(supportsProtocol(claude, "anthropic"), true);

  await claude.apply(anthro);
  const settings = JSON.parse(fs.readFileSync(path.join(sandbox, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.env.ANTHROPIC_BASE_URL, anthro.baseUrl);
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, anthro.apiKey);
  assert.equal(settings.env.ANTHROPIC_MODEL, "model-a");
  await claude.prune(anthro);
});
