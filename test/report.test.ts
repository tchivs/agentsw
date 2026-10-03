import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appsReport,
  listAppsReport,
  listReport,
  modelsQueryReport,
  providerMetadataReport,
  providerModelsReport,
  statusReport,
} from "../src/report.js";
import type { ModelSpec, Provider, Store } from "../src/types.js";

const SECRET = "fixture-report-api-key";

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "example",
    name: "Example account",
    protocol: "openai",
    openaiApi: "responses",
    baseUrl: "https://api.example.test/v1",
    apiKey: SECRET,
    defaultModel: "model-a",
    models: [
      { id: "model-a", contextWindow: 200_000, maxOutput: 8_000, reasoning: true, reasoningEfforts: ["low", "high"] },
      { id: "model-b" },
    ],
    gatewayMetadata: true,
    gatewayModelAliases: { "model-b": "vendor/model-b" },
    ...overrides,
  };
}

function store(): Store {
  return { version: 1, active: "example", providers: { example: provider() } };
}

/** Every builder must be safe to hand to a machine consumer: no credential material anywhere. */
function assertCredentialFree(payload: unknown): void {
  const text = JSON.stringify(payload);
  assert.doesNotMatch(text, /apiKey|keyEnv|secret|password|token/i, text);
  assert.ok(!text.includes(SECRET), text);
}

test("statusReport names the config file, the active provider and each measured app", () => {
  const report = statusReport("/tmp/config.json", store(), [
    { id: "codex", detected: true, protocols: ["openai"], current: "example", configPath: "/tmp/codex.toml" },
  ]);
  assert.deepEqual(report, {
    configFile: "/tmp/config.json",
    active: "example",
    apps: [{ id: "codex", detected: true, protocols: ["openai"], current: "example", configPath: "/tmp/codex.toml" }],
  });
  assertCredentialFree(report);
});

test("listReport summarizes providers without credentials or model bodies", () => {
  assert.deepEqual(listReport(store()), {
    active: "example",
    providers: [{
      id: "example",
      name: "Example account",
      protocol: "openai",
      baseUrl: "https://api.example.test/v1",
      defaultModel: "model-a",
      modelCount: 2,
    }],
  });
  assertCredentialFree(listReport(store()));
});

test("listReport tolerates a store with no active provider", () => {
  const empty: Store = { version: 1, providers: {} };
  assert.deepEqual(listReport(empty), { active: null, providers: [] });
});

test("providerMetadataReport keeps the legacy shape scripts already parse", () => {
  const report = providerMetadataReport(provider({ models: [{ id: "model-a", metadata: { gateway: { modelId: "vendor/model-a" } } } as ModelSpec] }));
  assert.deepEqual(Object.keys(report), ["provider", "gatewayMetadata", "metadataMode", "gatewayModelAliases", "models"]);
  assert.equal(report.provider, "example");
  assert.equal(report.gatewayMetadata, true);
  assert.equal(report.metadataMode, "on");
  assert.deepEqual(report.gatewayModelAliases, { "model-b": "vendor/model-b" });
  assert.deepEqual(report.models, [{ id: "model-a", metadata: { gateway: { modelId: "vendor/model-a" } } }]);
  assertCredentialFree(report);
});

test("providerModelsReport lists model specs with explicit nulls for unknown fields", () => {
  const report = providerModelsReport(provider(), false) as { models: Array<Record<string, unknown>> };
  assert.equal(report.provider, "example");
  assert.deepEqual(report.models[0], {
    id: "model-a",
    name: null,
    contextWindow: 200_000,
    maxInput: null,
    maxOutput: 8_000,
    reasoning: true,
    reasoningEfforts: ["low", "high"],
    imageInput: null,
    cost: null,
  });
  assert.equal(report.models[1]!.contextWindow, null);
  assertCredentialFree(report);
});

test("modelsQueryReport carries the query and the resolved provider for each hit", () => {
  const report = modelsQueryReport("model", [{ provider: "vendor", spec: { id: "vendor/model-a", contextWindow: 1000 } }]);
  assert.equal(report.query, "model");
  assert.deepEqual(report.models, [{
    provider: "vendor",
    id: "vendor/model-a",
    name: null,
    contextWindow: 1000,
    maxInput: null,
    maxOutput: null,
    reasoning: null,
    reasoningEfforts: null,
    imageInput: null,
    cost: null,
  }]);
});

test("listAppsReport and appsReport expose status without credential fields", () => {
  const listed = listAppsReport("prime,omp", [{ app: "prime", id: "orphan" }, { id: "local" }]);
  assert.deepEqual(listed, {
    apps: "prime,omp",
    entries: [{ app: "prime", id: "orphan", name: null }, { app: null, id: "local", name: null }],
  });
  const apps = appsReport([{
    id: "codex", name: "Codex", installed: "1.0.0", latest: "1.1.0",
    upgradable: true, installable: false, status: "upgradable",
  }]);
  assert.deepEqual(apps, {
    apps: [{ id: "codex", name: "Codex", installed: "1.0.0", latest: "1.1.0", upgradable: true, installable: false, status: "upgradable" }],
  });
  assertCredentialFree(listed);
  assertCredentialFree(apps);
});
