import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Provider } from "../src/types.js";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agentsw-gateway-commands-"));
process.env.HOME = sandbox;
process.env.AGENTSW_HOME = sandbox;
for (const key of ["HERMES_HOME", "WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR", "DSH_HOME", "PI_CODING_AGENT_DIR", "PRIME_AGENT_CODING_AGENT_DIR", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG"]) delete process.env[key];
const { cmdAdd, cmdQuickAdd, cmdDiscover, cmdRefreshMeta, cmdModels, cmdImport, cmdUse, cmdSync } = await import("../src/commands.js");
const { loadStore, saveStore, configDir } = await import("../src/store.js");
const { targets } = await import("../src/targets/index.js");
const modelId = "vendor/model-a";
const endpoint = "https://fixture.example/v1";
const apiKey = "fixture-private-api-key";
let requests: string[] = [];
let output: string[] = [];
let gatewayDown = false;
const primary = { vendor: { id: "vendor", models: { [modelId]: {
  id: modelId, limit: { context: 8192 }, reasoning: false, cost: { input: 0 },
} } } };
const gatewayBody = { data: [modelId, "vendor/catalog-only"].map((id) => ({
  id, name: "Gateway reference name", type: "language", context_window: 4096, max_tokens: 1024,
  tags: ["reasoning", "tool-use"], reasoning_options: [{ type: "effort", values: ["low", "high"] }],
  modalities: { input: ["text", "image"], output: ["text"] }, pricing: { input: "0.000003", output: "0.000015" },
  supported_specifications: ["v2", "v3", "v4"],
})) };
function provider(overrides: Partial<Provider> = {}): Provider {
  return { id: "fixture", name: "Custom name", protocol: "openai", openaiApi: "responses", baseUrl: endpoint, apiKey,
    models: [{ id: modelId }], defaultModel: modelId, ...overrides };
}
function seed(...providers: Provider[]): void {
  saveStore({ version: 1, active: providers[0]?.id, providers: Object.fromEntries(providers.map((p) => [p.id, p])) });
}
function current(): Provider { return loadStore().providers.fixture!; }
function addOptions() {
  return { yes: true, protocol: "openai", baseUrl: endpoint, apiKey, models: modelId };
}
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
beforeEach((t) => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(sandbox);
  seed();
  fs.writeFileSync(path.join(configDir, "models-dev.json"), JSON.stringify(primary));
  requests = [];
  output = [];
  gatewayDown = false;
  t.mock.method(console, "log", (...args: unknown[]) => { output.push(args.join(" ")); });
  t.mock.method(process.stderr, "write", () => true);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (url === "https://models.dev/api.json") return Response.json(primary);
    if (url === "https://ai-gateway.vercel.sh/v1/models") {
      assert.equal(new Headers(init?.headers).has("authorization"), false);
      assert.equal(new Headers(init?.headers).has("x-api-key"), false);
      assert.equal(JSON.stringify(init).includes(apiKey), false);
      if (gatewayDown) throw new Error("fixture network failure");
      return Response.json(gatewayBody);
    }
    if (url === `${endpoint}/models`) {
      return Response.json({ data: [{ id: modelId }] }, { status: new Headers(init?.headers).has("x-api-key") ? 401 : 200 });
    }
    throw new Error(`Unexpected fixture URL: ${url}`);
  });
});

test("opt-in fills only missing specs without changing wire, availability or effective prices", async () => {
  seed(provider());
  await cmdAdd({ ...addOptions(), gatewayMetadata: true });
  const saved = current();
  const spec = saved.models[0]!;
  assert.equal(saved.gatewayMetadata, true);
  assert.equal(saved.id, "fixture");
  assert.equal(saved.name, "Custom name");
  assert.equal(saved.baseUrl, endpoint);
  assert.equal(saved.openaiApi, "responses");
  assert.equal(saved.apiKey, apiKey);
  assert.deepEqual(saved.models.map((m) => m.id), [modelId]);
  assert.equal(spec.contextWindow, 8192);
  assert.equal(spec.maxOutput, 1024);
  assert.equal(spec.reasoning, false);
  assert.equal(spec.reasoningEfforts, undefined);
  assert.equal(spec.imageInput, true);
  assert.equal(spec.cost?.input, 0);
  assert.equal(spec.cost?.output, undefined);
  assert.equal(spec.metadata?.gateway?.referenceCost?.output, 15);
  assert.equal(spec.metadata?.fields?.maxOutput?.source, "ai-gateway");
  assert.ok(spec.metadata?.conflicts?.some((c) => c.field === "contextWindow"));
  assert.equal(requests.filter((url) => url.includes("ai-gateway")).length, 1);
});

test("default auto fills missing specs without flags or manual model mappings", async () => {
  seed(provider());
  await cmdAdd(addOptions());
  assert.equal(current().gatewayMetadata, undefined);
  assert.equal(current().models[0]?.maxOutput, 1024);
  assert.equal(current().models[0]?.metadata?.fields?.maxOutput?.source, "ai-gateway");
  assert.equal(requests.filter((url) => url.includes("ai-gateway")).length, 1);
});

test("explicit false persists and never requests Gateway", async () => {
  seed(provider());
  await cmdAdd({ ...addOptions(), gatewayMetadata: false });
  await cmdDiscover("fixture", {});
  await cmdRefreshMeta({ provider: "fixture" });
  assert.equal(current().gatewayMetadata, false);
  assert.ok(requests.every((url) => !url.includes("ai-gateway")));
});

test("omitted options preserve opt-in and aliases across add, quick, discovery and refresh", async () => {
  const aliases = { [modelId]: modelId };
  seed(provider({ gatewayMetadata: true, gatewayModelAliases: aliases }));
  for (const command of [
    () => cmdAdd(addOptions()),
    () => cmdQuickAdd({ baseUrl: endpoint, apiKey, yes: true }),
    () => cmdDiscover("fixture", {}),
    () => cmdRefreshMeta({ provider: "fixture" }),
  ]) {
    await command();
    assert.equal(current().gatewayMetadata, true);
    assert.deepEqual(current().gatewayModelAliases, aliases);
    assert.deepEqual(current().models.map((m) => m.id), [modelId]);
  }
  await cmdDiscover("fixture", { gatewayMetadata: false });
  requests = [];
  await cmdRefreshMeta({ provider: "fixture" });
  assert.equal(current().models[0]?.maxOutput, 1024);
  assert.ok(requests.every((url) => !url.includes("ai-gateway")));
});

test("targeted refresh changes settings and metadata only for selected provider", async () => {
  const other = provider({ id: "untouched", gatewayMetadata: false, models: [{ id: "other" }] });
  seed(provider(), other);
  await cmdRefreshMeta({ provider: "fixture", gatewayMetadata: true, gatewayModels: JSON.stringify({ [modelId]: modelId }) });
  assert.deepEqual(loadStore().providers.untouched, other);
  assert.equal(current().gatewayMetadata, true);
  assert.equal(current().defaultModel, modelId);
  assert.deepEqual(current().models.map((m) => m.id), [modelId]);
  assert.ok(requests.every((url) => url !== `${endpoint}/models`));
  assert.equal(fs.existsSync(path.join(sandbox, ".pi")), false);
  await cmdRefreshMeta({ provider: "fixture", gatewayModels: "{}" });
  assert.deepEqual(current().gatewayModelAliases, {});
});

test("manual and untracked model fields survive all enrichment paths", async () => {
  const model = { id: modelId, contextWindow: 2048, maxOutput: 512, imageInput: false, reasoning: false,
    cost: { input: 9, cacheRead: 0 }, extension: { owner: "user" } };
  seed(provider({ gatewayMetadata: true, models: [model] }));
  for (const command of [
    () => cmdAdd(addOptions()),
    () => cmdQuickAdd({ baseUrl: endpoint, apiKey, yes: true }),
    () => cmdDiscover("fixture", {}),
    () => cmdRefreshMeta({ provider: "fixture" }),
  ]) {
    await command();
    const actual = current().models[0]! as typeof model;
    for (const field of ["contextWindow", "maxOutput", "imageInput", "reasoning", "cost", "extension"] as const) assert.deepEqual(actual[field], model[field]);
  }
});

test("Gateway outage without cache preserves primary data and existing provider settings", async () => {
  gatewayDown = true;
  seed(provider({ gatewayMetadata: true }));
  await cmdDiscover("fixture", {});
  assert.equal(current().gatewayMetadata, true);
  assert.equal(current().models[0]?.contextWindow, 8192);
  assert.equal(current().models[0]?.maxOutput, undefined);
  assert.deepEqual(current().models.map((m) => m.id), [modelId]);
});

test("invalid aliases reject before network or store writes", async () => {
  seed(provider());
  const before = JSON.stringify(loadStore());
  for (const command of [
    () => cmdAdd({ ...addOptions(), gatewayModels: "[]" }),
    () => cmdQuickAdd({ baseUrl: endpoint, apiKey, yes: true, gatewayModels: "[]" }),
    () => cmdDiscover("fixture", { gatewayModels: "[]" }),
    () => cmdRefreshMeta({ provider: "fixture", gatewayModels: "[]" }),
    () => cmdImport({ all: true, gatewayModels: "[]" }),
  ]) {
    await assert.rejects(command);
    assert.equal(JSON.stringify(loadStore()), before);
  }
  assert.deepEqual(requests, []);
});

test("metadata inspection emits audit JSON without credentials or fetching", async () => {
  seed(provider({ gatewayMetadata: true }));
  await cmdRefreshMeta({ provider: "fixture" });
  output = [];
  requests = [];
  await cmdModels(undefined, { provider: "fixture", metadata: true });
  const text = output.join("\n");
  const audit = JSON.parse(text);
  assert.equal(audit.gatewayMetadata, true);
  assert.equal(audit.models[0].metadata.gateway.referenceCost.output, 15);
  assert.doesNotMatch(text, /fixture-private-api-key|baseUrl|apiKey/);
  assert.deepEqual(requests, []);
});

test("import opt-in enriches only candidate models and leaves configured providers untouched", async (t) => {
  for (const target of targets) t.mock.method(target, "candidates", () => []);
  t.mock.method(targets[0]!, "candidates", () => [{ id: "fixture", name: "Fixture", protocol: "openai" as const,
    openaiApi: "responses" as const, baseUrl: endpoint, apiKey, models: [modelId], defaultModel: modelId, source: "fixture" }]);
  await cmdImport({ all: true, gatewayMetadata: true });
  assert.equal(current().gatewayMetadata, true);
  assert.equal(current().models[0]?.maxOutput, 1024);
  const before = JSON.stringify(loadStore());
  await cmdImport({ all: true, gatewayMetadata: false });
  assert.equal(JSON.stringify(loadStore()), before);
});

test("sync does not fetch catalogs or emit audit metadata into runtime app configs", async () => {
  seed(provider({ gatewayMetadata: true }));
  await cmdRefreshMeta({ provider: "fixture" });
  requests = [];
  await cmdUse("fixture", { apps: "pi" });
  const file = path.join(sandbox, ".pi/agent/models.json");
  const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(parsed.providers.fixture.models[0].metadata, undefined);
  assert.equal(parsed.providers.fixture.models[0].maxTokens, 1024);
  assert.equal(parsed.providers.fixture.api, "openai-responses");
  await cmdSync({ provider: "fixture", apps: "pi", dryRun: true });
  assert.deepEqual(requests, []);
});

test("discovery retains metadata for selected default and small models absent upstream", async () => {
  const defaultSpec = { id: "missing-default", contextWindow: 16000, extension: "keep-default" };
  const smallSpec = { id: "missing-small", maxOutput: 512, extension: "keep-small" };
  seed(provider({ defaultModel: defaultSpec.id, smallModel: smallSpec.id, models: [defaultSpec, smallSpec], gatewayMetadata: true }));
  await cmdDiscover("fixture", {});
  assert.deepEqual(current().models.find((m) => m.id === defaultSpec.id), defaultSpec);
  assert.deepEqual(current().models.find((m) => m.id === smallSpec.id), smallSpec);
  assert.deepEqual(new Set(current().models.map((m) => m.id)), new Set([modelId, defaultSpec.id, smallSpec.id]));
});

test("all-provider refresh fetches shared Gateway catalog once, not once per account", async () => {
  seed(provider(), provider({ id: "second", apiKey: "different-fixture-key" }));
  await cmdRefreshMeta({ gatewayMetadata: true });
  assert.equal(requests.filter((url) => url.includes("ai-gateway")).length, 1);
  assert.ok(Object.values(loadStore().providers).every((p) => p.gatewayMetadata && p.models[0]?.maxOutput === 1024));
});

test("dual-protocol quick keeps distinct metadata settings and shares one Gateway request", async (t) => {
  const manual = { id: modelId, name: "Manual model", contextWindow: 2048, maxOutput: 256,
    reasoning: false, imageInput: false, cost: { input: 42 }, extension: "retained" };
  const disabled = provider({ id: "anthropic-fixture", protocol: "anthropic", openaiApi: undefined,
    gatewayMetadata: false, gatewayModelAliases: { [modelId]: "vendor/disabled-target" }, models: [manual] });
  seed(provider({ gatewayMetadata: true, gatewayModelAliases: { [modelId]: modelId } }), disabled);
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (url === `${endpoint}/models`) return Response.json({ data: [{ id: modelId }] });
    assert.equal(url, "https://ai-gateway.vercel.sh/v1/models");
    assert.equal(init?.headers, undefined);
    return Response.json(gatewayBody);
  });
  await cmdQuickAdd({ baseUrl: endpoint, apiKey, yes: true });
  assert.equal(requests.filter((url) => url.includes("ai-gateway")).length, 1);
  assert.equal(current().gatewayMetadata, true);
  assert.deepEqual(current().gatewayModelAliases, { [modelId]: modelId });
  assert.equal(current().models[0]?.maxOutput, 1024);
  const retained = loadStore().providers[disabled.id]!;
  assert.equal(retained.gatewayMetadata, false);
  assert.deepEqual(retained.gatewayModelAliases, disabled.gatewayModelAliases);
  const { metadata, ...retainedSpec } = retained.models[0]!;
  assert.deepEqual(retainedSpec, manual);
  assert.equal(metadata?.gateway, undefined);
  assert.equal(retained.protocol, "anthropic");
  assert.equal(retained.defaultModel, modelId);
  assert.equal(retained.apiKey, apiKey);
  assert.equal(retained.openaiApi, undefined);
});

test("auto skips Gateway when primary supplies core parameters across every enrichment command", async (t) => {
  const complete = { vendor: { id: "vendor", models: { [modelId]: {
    ...primary.vendor.models[modelId]!, limit: { context: 8192, output: 1024 }, modalities: { input: ["text"] },
  } } } };
  fs.writeFileSync(path.join(configDir, "models-dev.json"), JSON.stringify(complete));
  seed(provider());
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (url === "https://models.dev/api.json") return Response.json(complete);
    assert.equal(url, `${endpoint}/models`);
    return Response.json({ data: [{ id: modelId }] }, { status: new Headers(init?.headers).has("x-api-key") ? 401 : 200 });
  });
  for (const command of [
    () => cmdAdd(addOptions()),
    () => cmdQuickAdd({ baseUrl: endpoint, apiKey, yes: true }),
    () => cmdDiscover("fixture", {}),
    () => cmdRefreshMeta({ provider: "fixture" }),
  ]) {
    await command();
    assert.equal(current().models[0]?.contextWindow, 8192);
    assert.equal(current().models[0]?.maxOutput, 1024);
    assert.equal(current().models[0]?.imageInput, false);
    assert.equal(current().models[0]?.reasoning, false);
    assert.equal(current().models[0]?.cost?.input, 0);
    assert.equal(current().models[0]?.metadata?.gateway, undefined);
  }
  assert.ok(requests.every((url) => !url.includes("ai-gateway")));
});

test("complete manual parameters avoid supplemental queries despite gaps in primary", async () => {
  const model = { id: modelId, contextWindow: 2048, maxOutput: 256, reasoning: false, imageInput: false, cost: { input: 0 } };
  seed(provider({ models: [model] }));
  await cmdRefreshMeta({ provider: "fixture" });
  const { metadata, ...retained } = current().models[0]!;
  assert.deepEqual(retained, model);
  assert.equal(metadata?.gateway, undefined);
  assert.ok(requests.every((url) => !url.includes("ai-gateway")));
});

test("automatic multi-provider refresh shares one failed Gateway load and retains primary metadata", async () => {
  seed(provider(), provider({ id: "second", apiKey: "second-fixture-key" }));
  gatewayDown = true;
  await cmdRefreshMeta();
  assert.equal(requests.filter((url) => url.includes("ai-gateway")).length, 1);
  for (const saved of Object.values(loadStore().providers)) {
    assert.equal(saved.models[0]?.contextWindow, 8192);
    assert.equal(saved.models[0]?.maxOutput, undefined);
    assert.deepEqual(saved.models.map((m) => m.id), [modelId]);
  }
});

test("metadata modes preserve omission and can restore automatic behavior after explicit off", async () => {
  seed(provider({ gatewayMetadata: false }));
  await cmdDiscover("fixture", {});
  assert.equal(current().gatewayMetadata, false);
  assert.ok(requests.every((url) => !url.includes("ai-gateway")));
  await cmdRefreshMeta({ provider: "fixture", metadataMode: "auto" });
  assert.equal(current().gatewayMetadata, "auto");
  assert.equal(current().models[0]?.maxOutput, 1024);
  await cmdAdd(addOptions());
  assert.equal(current().gatewayMetadata, "auto");
  output = [];
  requests = [];
  await cmdModels(undefined, { provider: "fixture", metadata: true });
  const audit = JSON.parse(output.join("\n"));
  assert.equal(audit.metadataMode, "auto");
  assert.equal(audit.gatewayMetadata, "auto");
  assert.deepEqual(requests, []);
});

test("invalid or conflicting metadata modes reject before requests or store changes", async () => {
  seed(provider());
  const before = JSON.stringify(loadStore());
  for (const opts of [{ metadataMode: "guess" }, { metadataMode: "off", gatewayMetadata: true }]) {
    for (const command of [
      () => cmdAdd({ ...addOptions(), ...opts }),
      () => cmdQuickAdd({ baseUrl: endpoint, apiKey, yes: true, ...opts }),
      () => cmdDiscover("fixture", opts),
      () => cmdRefreshMeta({ provider: "fixture", ...opts }),
      () => cmdImport({ all: true, ...opts }),
    ]) {
      await assert.rejects(command);
      assert.equal(JSON.stringify(loadStore()), before);
    }
  }
  assert.deepEqual(requests, []);
});

test("default-auto import matches a unique bare model ID without creating available models", async (t) => {
  for (const target of targets) t.mock.method(target, "candidates", () => []);
  t.mock.method(targets[0]!, "candidates", () => [{ id: "fixture", protocol: "openai" as const,
    baseUrl: endpoint, apiKey, models: ["model-a"], defaultModel: "model-a", source: "fixture" }]);
  await cmdImport({ all: true });
  assert.equal(current().gatewayMetadata, undefined);
  assert.deepEqual(current().models.map((m) => m.id), ["model-a"]);
  assert.equal(current().models[0]?.contextWindow, 8192);
  assert.equal(current().models[0]?.maxOutput, 1024);
  assert.equal(current().models[0]?.metadata?.gateway?.modelId, modelId);
  assert.equal(current().defaultModel, "model-a");
  assert.equal(requests.filter((url) => url.includes("ai-gateway")).length, 1);
});

test("model inspection distinguishes unknown reasoning from explicitly unsupported reasoning", async () => {
  seed(provider({ models: [{ id: "unknown" }, { id: "unsupported", reasoning: false }, { id: "supported", reasoning: true, reasoningEfforts: [] }] }));
  await cmdModels(undefined, { provider: "fixture" });
  const text = output.join("\n");
  assert.match(text, /unknown\s+-\s+-\s+-\s+-\s+-/);
  assert.match(text, /unsupported\s+-\s+-\s+-\s+no\s+-/);
  assert.match(text, /supported\s+-\s+-\s+-\s+yes\s+-/);
  assert.deepEqual(requests, []);
});

for (const down of [false, true]) {
  test(`default-auto dual-protocol quick shares one ${down ? "failed" : "successful"} Gateway request`, async (t) => {
    t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push(url);
      if (url === `${endpoint}/models`) return Response.json({ data: [{ id: modelId }] });
      assert.equal(url, "https://ai-gateway.vercel.sh/v1/models");
      assert.equal(init?.headers, undefined);
      if (down) throw new Error("fixture offline");
      return Response.json(gatewayBody);
    });
    await cmdQuickAdd({ baseUrl: endpoint, apiKey, yes: true });
    const saved = Object.values(loadStore().providers);
    assert.equal(saved.length, 2);
    assert.deepEqual(new Set(saved.map((p) => p.protocol)), new Set(["openai", "anthropic"]));
    assert.equal(requests.filter((url) => url.includes("ai-gateway")).length, 1);
    for (const p of saved) {
      assert.equal(p.gatewayMetadata, undefined);
      assert.equal(p.models[0]?.contextWindow, 8192);
      assert.equal(p.models[0]?.maxOutput, down ? undefined : 1024);
      assert.deepEqual(p.models.map((model) => model.id), [modelId]);
    }
  });
}

test("reference-only Gateway audit stays timestamped in auto and refreshes when explicitly on", async (t) => {
  const oldFetchedAt = "2026-01-01T00:00:00.000Z";
  const audit = { modelId, fetchedAt: oldFetchedAt, referenceCost: { output: 99 } };
  const model = { id: modelId, name: "Manual name", contextWindow: 2048, maxOutput: 256,
    reasoning: false, imageInput: false, metadata: { gateway: audit } };
  seed(provider({ models: [model] }));
  await cmdRefreshMeta({ provider: "fixture" });
  assert.ok(requests.every((url) => !url.includes("ai-gateway")));
  assert.deepEqual(current().models[0]?.metadata?.gateway, audit);
  requests = [];
  await cmdRefreshMeta({ provider: "fixture", metadataMode: "on" });
  assert.equal(requests.filter((url) => url.includes("ai-gateway")).length, 1);
  assert.equal(current().models[0]?.metadata?.gateway?.referenceCost?.output, 15);
  assert.notEqual(current().models[0]?.metadata?.gateway?.fetchedAt, oldFetchedAt);
  assert.equal(current().models[0]?.maxOutput, 256);
});
