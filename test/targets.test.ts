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
process.env.AGENTSW_HOME = sandbox;
process.env.WORKBUDDY_CONFIG_DIR = path.join(sandbox, ".workbuddy");
delete process.env.CODEBUDDY_CONFIG_DIR;
delete process.env.HERMES_HOME;
delete process.env.DSH_HOME;
delete process.env.PI_CODING_AGENT_DIR;
delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
delete process.env.OPENCODE_CONFIG_DIR;
delete process.env.OPENCODE_CONFIG;

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
  fs.mkdirSync(path.join(sandbox, ".dsh"), { recursive: true });
  fs.writeFileSync(path.join(sandbox, ".codex", "config.toml"), 'model = "keep-model"\n\n[features]\ngoals = true\n');
  fs.writeFileSync(
    path.join(sandbox, ".omp", "agent", "models.yml"),
    "# keep this comment\nproviders:\n  keepme:\n    baseUrl: http://keep/v1\n    auth: none\n    api: openai-completions\n    models:\n      - id: m\n",
  );
  fs.writeFileSync(path.join(sandbox, ".hermes", "config.yaml"), "# hermes comment\nagent:\n  reasoning_effort: high\n");
  fs.writeFileSync(path.join(sandbox, ".config", "opencode", "opencode.json"), '{"theme": "dark"}\n');
  fs.writeFileSync(
    path.join(sandbox, ".dsh", "settings.yaml"),
    "# dsh comment\napproval:\n  mode: ask\n",
  );
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
  const dshYaml = fs.readFileSync(path.join(sandbox, ".dsh", "settings.yaml"), "utf8");
  assert.match(dshYaml, /# dsh comment/);
  assert.match(dshYaml, /mode: ask/);
  assert.doesNotMatch(dshYaml, /testprov/);
  assert.doesNotMatch(dshYaml, /agent-default-model/);
});

test("omp write carries metadata and stays parseable", async () => {
  const omp = targets.find((t) => t.id === "omp")!;
  await omp.apply(provider);
  const doc = YAML.parse(fs.readFileSync(path.join(sandbox, ".omp", "agent", "models.yml"), "utf8"));
  const entry = doc.providers.testprov;
  assert.equal(entry.api, "openai-completions");
  assert.equal(entry.baseUrl, provider.baseUrl, "OpenAI clients append only the operation path, so keep /v1");
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
  assert.equal(config.providers.testprov.baseUrl, provider.baseUrl, "OpenAI SDK appends /responses, so keep /v1");
  await pi.prune(provider);
});

test("anthropic provider routes to anthropic wire and skips openai-only apps", async () => {
  const anthro: Provider = { ...provider, id: "anthro", protocol: "anthropic" };
  const codex = targets.find((t) => t.id === "codex")!;
  const workbuddy = targets.find((t) => t.id === "workbuddy")!;
  const pi = targets.find((t) => t.id === "pi")!;
  const opencode = targets.find((t) => t.id === "opencode")!;
  const hermes = targets.find((t) => t.id === "hermes")!;
  const claude = targets.find((t) => t.id === "claude")!;
  assert.equal(supportsProtocol(codex, "anthropic"), false);
  assert.equal(supportsProtocol(workbuddy, "anthropic"), false);
  assert.equal(supportsProtocol(claude, "anthropic"), true);

  await claude.apply(anthro);
  const settings = JSON.parse(fs.readFileSync(path.join(sandbox, ".claude", "settings.json"), "utf8"));
  assert.equal(settings.env.ANTHROPIC_BASE_URL, anthro.baseUrl.replace(/\/v\d+(?:beta\d*)?\/?$/i, ""), "claude SDK appends /v1; strip it from ANTHROPIC_BASE_URL");
  assert.equal(settings.env.ANTHROPIC_AUTH_TOKEN, anthro.apiKey);
  await pi.apply(anthro);
  const piModels = JSON.parse(fs.readFileSync(path.join(sandbox, ".pi", "agent", "models.json"), "utf8"));
  assert.equal(piModels.providers.anthro.baseUrl, "https://api.test.example", "Anthropic SDK appends /v1/messages");
  await pi.prune(anthro);
  await opencode.apply(anthro);
  const opencodeConfig = JSON.parse(
    fs.readFileSync(path.join(sandbox, ".config", "opencode", "opencode.json"), "utf8"),
  );
  assert.equal(opencodeConfig.provider.anthro.options.baseURL, anthro.baseUrl, "AI SDK Anthropic appends only /messages");
  await opencode.prune(anthro);
  await hermes.apply(anthro);
  const hermesConfig = YAML.parse(fs.readFileSync(path.join(sandbox, ".hermes", "config.yaml"), "utf8"));
  assert.equal(hermesConfig.providers.anthro.api, "https://api.test.example", "Python Anthropic SDK appends /v1/messages");
  await hermes.prune(anthro);
  assert.equal(settings.env.ANTHROPIC_MODEL, "model-a");
  await claude.prune(anthro);
});

test("omp keeps provider-level keys, wire flavor and per-model extras across a sync", async () => {
  const omp = targets.find((t) => t.id === "omp")!;
  const file = path.join(sandbox, ".omp", "agent", "models.yml");
  // an omp provider the user hand-tuned: Bearer auth, responses wire, per-model thinking levels
  fs.writeFileSync(
    file,
    [
      "providers:",
      "  reseller:",
      "    baseUrl: https://reseller.example/v1",
      "    api: openai-responses",
      "    apiKey: sk-old",
      "    authHeader: true",
      "    compat:",
      "      supportsStore: false",
      "    models:",
      "      - id: model-a",
      "        thinkingLevelMap:",
      "          max: max",
      "",
    ].join("\n"),
  );

  const candidate = omp.candidates!().find((c) => c.id === "reseller")!;
  assert.equal(candidate.protocol, "openai", "openai-responses must not be skipped on import");
  assert.equal(candidate.openaiApi, "responses");

  await omp.apply({ ...provider, id: "reseller", baseUrl: "https://reseller.example/v1", openaiApi: candidate.openaiApi });
  const entry = YAML.parse(fs.readFileSync(file, "utf8")).providers.reseller;
  assert.equal(entry.api, "openai-responses", "sync must not downgrade a responses endpoint");
  assert.equal(entry.authHeader, true, "Authorization: Bearer opt-in must survive");
  assert.equal(entry.compat.supportsStore, false);
  assert.equal(entry.apiKey, provider.apiKey);
  const modelA = entry.models.find((m: { id: string }) => m.id === "model-a");
  assert.equal(modelA.thinkingLevelMap.max, "max", "per-model keys agentsw does not model must survive");
  assert.equal(modelA.contextWindow, 100000, "owned metadata is still refreshed");
  await omp.prune({ ...provider, id: "reseller" });
});

test("omp keeps an existing responses wire when the store carries no flavor", async () => {
  const omp = targets.find((t) => t.id === "omp")!;
  const file = path.join(sandbox, ".omp", "agent", "models.yml");
  fs.writeFileSync(file, "providers:\n  azure:\n    baseUrl: https://azure.example\n    api: azure-openai-responses\n    models:\n      - id: model-a\n");
  await omp.apply({ ...provider, id: "azure", baseUrl: "https://azure.example" });
  assert.equal(
    YAML.parse(fs.readFileSync(file, "utf8")).providers.azure.api,
    "azure-openai-responses",
    "the more specific existing variant is kept",
  );
  await omp.apply({ ...provider, id: "azure", baseUrl: "https://azure.example", openaiApi: "completions" });
  assert.equal(
    YAML.parse(fs.readFileSync(file, "utf8")).providers.azure.api,
    "openai-completions",
    "an explicit store flavor still wins",
  );
  await omp.prune({ ...provider, id: "azure" });
});

test("pi keeps provider-level keys and the responses wire across a sync", async () => {
  const pi = targets.find((t) => t.id === "pi")!;
  const file = path.join(sandbox, ".pi", "agent", "models.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      providers: {
        reseller: {
          baseUrl: "https://reseller.example/v1",
          api: "openai-responses",
          apiKey: "sk-old",
          authHeader: true,
          headers: { "X-Team": "platform" },
          models: [{ id: "model-a", api: "openai-responses" }],
        },
      },
    }),
  );

  const candidate = pi.candidates!().find((c) => c.id === "reseller")!;
  assert.equal(candidate.protocol, "openai");
  assert.equal(candidate.openaiApi, "responses");

  await pi.apply({ ...provider, id: "reseller", baseUrl: "https://reseller.example/v1", openaiApi: "responses" });
  const entry = JSON.parse(fs.readFileSync(file, "utf8")).providers.reseller;
  assert.equal(entry.api, "openai-responses");
  assert.equal(entry.authHeader, true);
  assert.equal(entry.headers["X-Team"], "platform");
  assert.equal(entry.baseUrl, "https://reseller.example/v1");
  const modelA = entry.models.find((m: { id: string }) => m.id === "model-a");
  assert.equal(modelA.api, "openai-responses");
  assert.equal(modelA.maxTokens, 8192);
  await pi.prune({ ...provider, id: "reseller" });
});

test("dsh writes an llm-pi-ai route, the picked default and a credential reference", async () => {
  const dsh = targets.find((t) => t.id === "dsh")!;
  const settings = path.join(sandbox, ".dsh", "settings.yaml");
  const credentials = path.join(sandbox, ".dsh", ".credentials.yaml");
  fs.writeFileSync(
    settings,
    [
      "# dsh comment",
      "llm-pi-ai:",
      "  providers:",
      "    gateway:",
      "      apiKeyEnv: GATEWAY_API_KEY",
      "      api: openai-completions",
      "      baseURL: https://gateway.example/v1",
      "      compat:",
      "        maxTokensField: max_tokens",
      "      modelOverrides:",
      "        model-a:",
      "          name: Old",
      "      models:",
      "        - id: model-a",
      "",
    ].join("\n"),
  );
  fs.writeFileSync(credentials, "version: 1\nrefs:\n  KEEP_ME: sk-keep\n", { mode: 0o600 });

  const candidate = dsh.candidates!().find((c) => c.id === "gateway")!;
  assert.equal(candidate.protocol, "openai");
  assert.equal(candidate.openaiApi, "completions");
  assert.equal(candidate.apiKey, undefined, "an unstored reference resolves to no key");

  await dsh.apply({ ...provider, id: "gateway", baseUrl: "https://gateway.example/v1", openaiApi: "responses" });
  const doc = YAML.parse(fs.readFileSync(settings, "utf8"));
  const route = doc["llm-pi-ai"].providers.gateway;
  assert.equal(route.api, "openai-responses", "an explicit store flavor rewrites the route");
  assert.equal(route.baseURL, "https://gateway.example/v1", "OpenAI client appends only /responses, so keep /v1");
  assert.equal(route.apiKeyEnv, "AGENTSW_GATEWAY_API_KEY");
  assert.equal(route.compat.maxTokensField, "max_tokens", "compat switches survive a sync");
  assert.equal(route.modelOverrides, undefined, "llm-pi-ai refuses modelOverrides beside a models list");
  const modelA = route.models.find((m: { id: string }) => m.id === "model-a");
  assert.equal(modelA.contextWindow, 100000);
  assert.equal(modelA.maxTokens, 8192);
  assert.deepEqual(modelA.input, ["text", "image"]);
  assert.deepEqual(modelA.reasoningEfforts, { low: "low", high: "high" });
  assert.deepEqual(doc["agent-default-model"], { provider: "gateway", model: "model-a" });
  assert.match(fs.readFileSync(settings, "utf8"), /# dsh comment/);

  // llm-pi-ai refuses a key its profile schema does not declare; keep the written
  // surface inside it (packages/llm/llm-pi-ai/src/config.ts `profile`, `modelFields`).
  const ROUTE_KEYS = ["apiKeyEnv", "displayName", "api", "baseURL", "models", "modelOverrides", "compat", "defaultContextWindow", "defaultMaxTokens", "defaultInput", "headers", "reasoning", "thinkingBudgets", "cacheRetention", "transport", "timeoutMs", "websocketConnectTimeoutMs", "streamIdleTimeoutMs", "maxRequestImageBytes", "requestImagePixelBudget", "requestImageMaxBytes", "retryPolicy"];
  const MODEL_KEYS = ["id", "name", "contextWindow", "maxTokens", "input", "reasoningEfforts", "compat"];
  const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  for (const key of Object.keys(route)) assert.ok(ROUTE_KEYS.includes(key), `unknown route key ${key}`);
  for (const model of route.models as Array<Record<string, unknown>>) {
    for (const key of Object.keys(model)) assert.ok(MODEL_KEYS.includes(key), `unknown model key ${key}`);
    for (const modality of (model.input as string[]) ?? []) assert.ok(["text", "image"].includes(modality));
    for (const level of Object.keys((model.reasoningEfforts as object) ?? {})) assert.ok(LEVELS.includes(level));
  }
  assert.match(route.apiKeyEnv, /^[A-Za-z_][A-Za-z0-9_]*$/, "apiKeyEnv must be a POSIX identifier");

  const creds = YAML.parse(fs.readFileSync(credentials, "utf8"));
  assert.equal(creds.version, 1);
  assert.equal(creds.refs.AGENTSW_GATEWAY_API_KEY, provider.apiKey);
  assert.equal(creds.refs.KEEP_ME, "sk-keep", "other credentials survive");
  if (process.platform !== "win32")
    assert.equal(fs.statSync(credentials).mode & 0o077, 0, "dsh refuses a document readable beyond its owner");

  // the written route imports back with its key resolved through the managed store
  const back = dsh.candidates!().find((c) => c.id === "gateway")!;
  assert.equal(back.openaiApi, "responses");
  assert.equal(back.apiKey, provider.apiKey);
  assert.equal(back.defaultModel, "model-a");

  await dsh.prune({ ...provider, id: "gateway" });
  const after = YAML.parse(fs.readFileSync(settings, "utf8"));
  assert.equal(after["llm-pi-ai"], undefined, "an empty route dict is removed");
  assert.equal(after["agent-default-model"], undefined, "the default selection followed the pruned provider");
  const credsAfter = YAML.parse(fs.readFileSync(credentials, "utf8"));
  assert.equal(credsAfter.refs.AGENTSW_GATEWAY_API_KEY, undefined);
  assert.equal(credsAfter.refs.KEEP_ME, "sk-keep");
});

test("dsh migrates a pre-release flat credentials document", async () => {
  const dsh = targets.find((t) => t.id === "dsh")!;
  const credentials = path.join(sandbox, ".dsh", ".credentials.yaml");
  fs.writeFileSync(credentials, "DEEPSEEK_API_KEY: sk-legacy\n", { mode: 0o600 });
  await dsh.apply({ ...provider, id: "flat" });
  const creds = YAML.parse(fs.readFileSync(credentials, "utf8"));
  assert.equal(creds.version, 1, "an unversioned document is refused by dsh; migrate it");
  assert.equal(creds.refs.DEEPSEEK_API_KEY, "sk-legacy");
  assert.equal(creds.refs.AGENTSW_FLAT_API_KEY, provider.apiKey);
  await dsh.prune({ ...provider, id: "flat" });
});

test("opencode and hermes keep keys agentsw does not model", async () => {
  const opencode = targets.find((t) => t.id === "opencode")!;
  const hermes = targets.find((t) => t.id === "hermes")!;
  const opencodeFile = path.join(sandbox, ".config", "opencode", "opencode.json");
  fs.writeFileSync(
    opencodeFile,
    JSON.stringify({
      provider: {
        keepme: { npm: "@ai-sdk/openai-compatible", options: { headers: { "X-Team": "platform" } }, models: { "model-a": { tool_call: false } } },
      },
    }),
  );
  await opencode.apply({
    ...provider,
    id: "keepme",
    models: [...provider.models, { id: "context-only", contextWindow: 64000 }],
  });
  const entry = JSON.parse(fs.readFileSync(opencodeFile, "utf8")).provider.keepme;
  assert.equal(entry.options.headers["X-Team"], "platform");
  assert.equal(entry.options.apiKey, provider.apiKey);
  assert.equal(entry.options.baseURL, provider.baseUrl);
  assert.equal(entry.npm, "@ai-sdk/openai-compatible");
  await opencode.apply({ ...provider, id: "responses", openaiApi: "responses" });
  const responsesEntry = JSON.parse(fs.readFileSync(opencodeFile, "utf8")).provider.responses;
  assert.equal(responsesEntry.npm, "@ai-sdk/openai");
  await opencode.prune({ ...provider, id: "responses" });
  assert.equal(entry.models["model-a"].tool_call, false, "per-model extras survive");
  assert.equal(entry.models["model-a"].limit.context, 100000);
  assert.equal(entry.models["model-a"].limit.output, 8192);
  assert.equal(entry.models["context-only"].limit, undefined, "OpenCode requires both limit.context and limit.output");
  await opencode.prune({ ...provider, id: "keepme" });

  const hermesFile = path.join(sandbox, ".hermes", "config.yaml");
  fs.writeFileSync(
    hermesFile,
    "providers:\n  keepme:\n    api: https://keep.example/v1\n    transport: chat_completions\n    max_retries: 7\n    models:\n      model-a:\n        note: keep\n",
  );
  await hermes.apply({ ...provider, id: "keepme" });
  const cfg = YAML.parse(fs.readFileSync(hermesFile, "utf8"));
  assert.equal(cfg.providers.keepme.max_retries, 7);
  await hermes.apply({ ...provider, id: "responses", openaiApi: "responses" });
  const responsesCfg = YAML.parse(fs.readFileSync(hermesFile, "utf8"));
  assert.equal(responsesCfg.providers.responses.transport, "codex_responses");
  await hermes.prune({ ...provider, id: "responses" });
  assert.equal(cfg.providers.keepme.models["model-a"].note, "keep");
  assert.equal(cfg.providers.keepme.models["model-a"].context_length, 100000);
  assert.equal(cfg.providers.keepme.api, provider.baseUrl, "Hermes OpenAI client requires the versioned base URL");
  assert.equal(cfg.model.provider, "keepme");
  await hermes.prune({ ...provider, id: "keepme" });
});

test("the wire is read from per-model api when the provider declares none", async () => {
  const omp = targets.find((t) => t.id === "omp")!;
  const file = path.join(sandbox, ".omp", "agent", "models.yml");
  fs.writeFileSync(
    file,
    "providers:\n  permodel:\n    baseUrl: https://permodel.example/v1\n    models:\n      - id: model-a\n        api: openai-responses\n",
  );

  const candidate = omp.candidates!().find((c) => c.id === "permodel")!;
  assert.equal(candidate.openaiApi, "responses", "a model-level wire is still a wire");

  // store carries no flavor (added by hand / imported from an app that reports none)
  await omp.apply({ ...provider, id: "permodel", baseUrl: "https://permodel.example/v1" });
  const entry = YAML.parse(fs.readFileSync(file, "utf8")).providers.permodel;
  assert.equal(entry.api, "openai-responses", "apply must not contradict the models it keeps");
  await omp.prune({ ...provider, id: "permodel" });
});

test("a mixed-protocol entry is skipped instead of being imported as one wire", async () => {
  const omp = targets.find((t) => t.id === "omp")!;
  const file = path.join(sandbox, ".omp", "agent", "models.yml");
  fs.writeFileSync(
    file,
    "providers:\n  mixed:\n    baseUrl: https://mixed.example\n    models:\n      - id: a\n        api: openai-completions\n      - id: b\n        api: anthropic-messages\n",
  );
  assert.equal(omp.candidates!().find((c) => c.id === "mixed"), undefined);
});

test("a re-sync clears owned per-model keys it no longer writes", async () => {
  const pi = targets.find((t) => t.id === "pi")!;
  const file = path.join(sandbox, ".pi", "agent", "models.json");
  await pi.apply({ ...provider, id: "stale" });
  const first = JSON.parse(fs.readFileSync(file, "utf8")).providers.stale.models[0];
  assert.ok(first.thinkingLevelMap, "model-a starts out as a reasoning model");

  // the catalog now describes model-a as non-reasoning with no size
  await pi.apply({ ...provider, id: "stale", models: [{ id: "model-a", reasoning: false }, { id: "model-b" }] });
  const after = JSON.parse(fs.readFileSync(file, "utf8")).providers.stale.models[0];
  assert.equal(after.reasoning, false);
  assert.equal(after.thinkingLevelMap, undefined, "a stale thinking map beside reasoning: false is not a state we write");
  assert.equal(after.maxTokens, undefined);
  assert.equal(after.contextWindow, undefined);
  await pi.prune({ ...provider, id: "stale" });
});

test("omp drops anthropic-only and stale per-model overrides when the wire changes", async () => {
  const omp = targets.find((t) => t.id === "omp")!;
  const file = path.join(sandbox, ".omp", "agent", "models.yml");
  await omp.apply({ ...provider, id: "flip", protocol: "anthropic" });
  assert.equal(YAML.parse(fs.readFileSync(file, "utf8")).providers.flip.disableStrictTools, true);

  // the same id now serves the openai wire of a proxy that exposes both
  const applied = await omp.apply({ ...provider, id: "flip", protocol: "openai", openaiApi: "responses" });
  const entry = YAML.parse(fs.readFileSync(file, "utf8")).providers.flip;
  assert.equal(entry.api, "openai-responses");
  assert.equal(entry.disableStrictTools, undefined, "an anthropic-only flag must not outlive the protocol");

  // a per-model override left over from another endpoint would silently win over the route
  const doc = YAML.parse(fs.readFileSync(file, "utf8"));
  Object.assign(doc.providers.flip.models[0], { baseUrl: "https://old.example/v1", api: "openai-completions" });
  fs.writeFileSync(file, YAML.stringify(doc));
  const second = await omp.apply({ ...provider, id: "flip", protocol: "openai", openaiApi: "responses" });
  const modelA = YAML.parse(fs.readFileSync(file, "utf8")).providers.flip.models.find((m: { id: string }) => m.id === "model-a");
  assert.equal(modelA.baseUrl, undefined);
  assert.equal(modelA.api, undefined);
  assert.ok(second.notes.some((n) => n.includes("model-a.baseUrl")), "the drop is reported");
  assert.ok(applied.changed.length > 0);
  await omp.prune({ ...provider, id: "flip" });
});

test("dsh refuses a credentials document it cannot prove it understands", async () => {
  const dsh = targets.find((t) => t.id === "dsh")!;
  const credentials = path.join(sandbox, ".dsh", ".credentials.yaml");

  // an unversioned refs-shaped document must not be re-rooted under a second refs
  fs.writeFileSync(credentials, "refs:\n  KEEP_ME: sk-keep\n", { mode: 0o600 });
  await assert.rejects(() => dsh.apply({ ...provider, id: "guard" }), /pre-release flat document/);
  assert.equal(YAML.parse(fs.readFileSync(credentials, "utf8")).refs.KEEP_ME, "sk-keep", "nothing was buried");

  fs.writeFileSync(credentials, "version: 2\nrefs:\n  KEEP_ME: sk-keep\n", { mode: 0o600 });
  await assert.rejects(() => dsh.apply({ ...provider, id: "guard" }), /declares version 2/);
});

test("dsh prune removes the stored key even when the route is already gone", async () => {
  const dsh = targets.find((t) => t.id === "dsh")!;
  const settings = path.join(sandbox, ".dsh", "settings.yaml");
  const credentials = path.join(sandbox, ".dsh", ".credentials.yaml");
  fs.writeFileSync(credentials, "version: 1\nrefs:\n  KEEP_ME: sk-keep\n", { mode: 0o600 });
  await dsh.apply({ ...provider, id: "orphan" });

  // the user deletes the route by hand (or through dsh itself)
  const doc = YAML.parse(fs.readFileSync(settings, "utf8"));
  delete doc["llm-pi-ai"].providers.orphan;
  fs.writeFileSync(settings, YAML.stringify(doc));

  const pruned = await dsh.prune({ ...provider, id: "orphan" });
  assert.ok(!pruned.skipped, "a leftover secret is still work to do");
  const creds = YAML.parse(fs.readFileSync(credentials, "utf8"));
  assert.equal(creds.refs.AGENTSW_ORPHAN_API_KEY, undefined);
  assert.equal(creds.refs.KEEP_ME, "sk-keep");
  assert.ok((await dsh.prune({ ...provider, id: "orphan" })).skipped, "second prune has nothing left");
});
