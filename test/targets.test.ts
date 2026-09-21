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
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.CODEX_HOME;
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
const { managedCredentialRef } = await import("../src/provider-identity.js");
const { readJsoncObject } = await import("../src/jsonc.js");
const readJsonc = (file: string): Record<string, unknown> => readJsoncObject(file).value as Record<string, unknown>;

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

test("omp gives gateway-fronted deepseek models the reasoning-replay compat flag", async () => {
  const omp = targets.find((t) => t.id === "omp")!;
  const file = path.join(sandbox, ".omp", "agent", "models.yml");
  // omp's catalog keys the deepseek wire rules by provider name, and a gateway
  // provider matches none of them, so DeepSeek 400s on replayed tool calls.
  fs.writeFileSync(
    file,
    [
      "providers:",
      "  gw:",
      "    baseUrl: https://gw.example/v1",
      "    api: openai-responses",
      "    models:",
      "      - id: deepseek-v4-pro",
      "        compat:",
      "          requiresReasoningContentForToolCalls: false",
      "",
    ].join("\n"),
  );
  const gw = {
    ...provider,
    id: "gw",
    baseUrl: "https://gw.example/v1",
    openaiApi: "responses" as const,
    models: [{ id: "deepseek-v4-flash" }, { id: "deepseek-v4-pro" }, { id: "gpt-5.6-luna" }],
  };
  type CompatModel = { id: string; compat?: Record<string, unknown> };
  const flagOf = (m: CompatModel[], id: string) => m.find((x) => x.id === id)?.compat;

  await omp.apply(gw);
  let models: CompatModel[] = YAML.parse(fs.readFileSync(file, "utf8")).providers.gw.models;
  assert.deepEqual(flagOf(models, "deepseek-v4-flash"), { requiresReasoningContentForToolCalls: true });
  assert.deepEqual(
    flagOf(models, "deepseek-v4-pro"),
    { requiresReasoningContentForToolCalls: false },
    "an explicit user value wins over the default",
  );
  assert.equal(flagOf(models, "gpt-5.6-luna"), undefined, "non-deepseek models get no flag");

  await omp.apply(gw);
  models = YAML.parse(fs.readFileSync(file, "utf8")).providers.gw.models;
  assert.deepEqual(flagOf(models, "deepseek-v4-flash"), { requiresReasoningContentForToolCalls: true }, "re-sync is idempotent");

  await omp.apply({ ...gw, protocol: "anthropic" as const });
  models = YAML.parse(fs.readFileSync(file, "utf8")).providers.gw.models;
  assert.deepEqual(flagOf(models, "deepseek-v4-flash"), { requiresReasoningContentForToolCalls: true }, "an anthropic sync neither re-adds nor drops it");
  await omp.prune({ ...provider, id: "gw" });
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
  assert.equal(route.apiKeyEnv, managedCredentialRef("gateway"));
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
  assert.equal(creds.refs[managedCredentialRef("gateway")], provider.apiKey);
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
  assert.equal(credsAfter.refs[managedCredentialRef("gateway")], undefined);
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
  assert.equal(creds.refs[managedCredentialRef("flat")], provider.apiKey);
  await dsh.prune({ ...provider, id: "flat" });
});

test("codex states the Responses requirement only when the provider does not declare it", async () => {
  const codex = targets.find((t) => t.id === "codex")!;
  const declares = (notes: string[]) => notes.some((n) => n.includes("Responses-compatible"));

  const responses = await codex.apply({ ...provider, id: "wire-responses", openaiApi: "responses" });
  assert.equal(declares(responses.notes), false, "a provider that already declares responses needs no caveat");

  const completions = await codex.apply({ ...provider, id: "wire-completions", openaiApi: "completions" });
  assert.ok(declares(completions.notes), "a chat-completions-only endpoint must still be flagged");

  const undeclared = await codex.apply({ ...provider, id: "wire-unknown" });
  assert.ok(declares(undeclared.notes), "an unknown flavor is written as responses, so it is flagged too");
});

test("claude and codex resolve their config directories per call from the env vars they honor", async () => {
  const claude = targets.find((t) => t.id === "claude")!;
  const codex = targets.find((t) => t.id === "codex")!;
  const claudeDir = path.join(sandbox, "claude-env");
  const codexDir = path.join(sandbox, "codex-env");
  fs.mkdirSync(claudeDir, { recursive: true });
  fs.mkdirSync(codexDir, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = claudeDir;
  process.env.CODEX_HOME = codexDir;
  const defaultClaudePath = path.join(sandbox, ".claude", "settings.json");
  const defaultBefore = fs.existsSync(defaultClaudePath) ? fs.readFileSync(defaultClaudePath, "utf8") : undefined;
  try {
    assert.deepEqual(claude.configPaths, [path.join(claudeDir, "settings.json")], "configPaths is resolved on access");
    assert.deepEqual(codex.configPaths, [path.join(codexDir, "config.toml"), path.join(codexDir, "auth.json")]);
    assert.equal(claude.detect(), true);
    assert.equal(codex.detect(), true);

    await claude.apply(provider);
    await codex.apply(provider);
    assert.ok(fs.existsSync(path.join(claudeDir, "settings.json")));
    assert.ok(fs.existsSync(path.join(codexDir, "config.toml")));
    const defaultClaude = defaultClaudePath;
    const defaultNow = fs.existsSync(defaultClaude) ? fs.readFileSync(defaultClaude, "utf8") : undefined;
    assert.equal(defaultNow, defaultBefore, "the default directory stays untouched");
    assert.match(codex.current() ?? "", /testprov/);

    await claude.prune(provider);
    await codex.prune(provider);
    const settings = JSON.parse(fs.readFileSync(path.join(claudeDir, "settings.json"), "utf8")) as { env?: Record<string, string> };
    assert.equal(settings.env?.ANTHROPIC_BASE_URL, undefined, "prune removes the env path it wrote");
  } finally {
    delete process.env.CLAUDE_CONFIG_DIR;
    delete process.env.CODEX_HOME;
  }
  assert.deepEqual(claude.configPaths, [path.join(sandbox, ".claude", "settings.json")], "dropping the variable restores the default");
});

test("opencode keeps comments, follows its file names and honors an explicit file", async () => {
  const opencode = targets.find((t) => t.id === "opencode")!;
  const dir = path.join(sandbox, "opencode-env");
  fs.mkdirSync(dir, { recursive: true });
  try {
    // 1. comment-preserving edits in the primary opencode.json
    const jsonFile = path.join(dir, "opencode.json");
    fs.writeFileSync(jsonFile, '{\n  // keep this comment\n  "theme": "dark"\n}\n');
    process.env.OPENCODE_CONFIG_DIR = dir;
    assert.deepEqual(opencode.configPaths, [jsonFile], "the existing file is the primary target");
    await opencode.apply(provider);
    const afterApply = fs.readFileSync(jsonFile, "utf8");
    assert.match(afterApply, /\/\/ keep this comment/);
    assert.match(afterApply, /"theme": "dark"/);
    assert.equal(((readJsonc(jsonFile).provider as Record<string, { options: { baseURL: string } }>).testprov).options.baseURL, provider.baseUrl);
    await opencode.prune(provider);
    const afterPrune = fs.readFileSync(jsonFile, "utf8");
    assert.match(afterPrune, /\/\/ keep this comment/);
    assert.equal(readJsonc(jsonFile).provider, undefined);

    // 2. opencode.jsonc is discovered and edited in place
    fs.rmSync(jsonFile);
    const jsoncFile = path.join(dir, "opencode.jsonc");
    fs.writeFileSync(jsoncFile, '{\n  // jsonc comment\n  "theme": "light"\n}\n');
    assert.deepEqual(opencode.configPaths, [jsoncFile]);
    await opencode.apply(provider);
    const jsoncText = fs.readFileSync(jsoncFile, "utf8");
    assert.match(jsoncText, /\/\/ jsonc comment/);
    assert.equal(((readJsonc(jsoncFile).provider as Record<string, { options: { apiKey: string } }>).testprov).options.apiKey, provider.apiKey);
    assert.equal(fs.existsSync(jsonFile), false, "apply writes the discovered file instead of creating a new one");
    await opencode.prune(provider);

    // 3. config.json is the last supported name in the same directory
    fs.rmSync(jsoncFile);
    const configJson = path.join(dir, "config.json");
    fs.writeFileSync(configJson, '{\n  "theme": "system"\n}\n');
    assert.deepEqual(opencode.configPaths, [configJson]);
    await opencode.apply(provider);
    assert.ok(readJsonc(configJson).provider);
    await opencode.prune(provider);

    // 4. OPENCODE_CONFIG pins an explicit file, even outside the search directories
    fs.rmSync(configJson);
    const explicit = path.join(sandbox, "explicit-config.json");
    fs.writeFileSync(explicit, "{}\n");
    process.env.OPENCODE_CONFIG = explicit;
    assert.deepEqual(opencode.configPaths, [explicit]);
    await opencode.apply(provider);
    assert.ok(readJsonc(explicit).provider);
    await opencode.prune(provider);
  } finally {
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.OPENCODE_CONFIG;
  }
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

test("a re-sync keeps what an entry carries when the store knows nothing about the model", async () => {
  const omp = targets.find((t) => t.id === "omp")!;
  const file = path.join(sandbox, ".omp", "agent", "models.yml");
  const read = (): Record<string, unknown> =>
    (YAML.parse(fs.readFileSync(file, "utf8")).providers.unknown.models as Array<Record<string, unknown>>)
      .find((m) => m.id === "model-a")!;

  await omp.apply({ ...provider, id: "unknown" });
  assert.equal(read().contextWindow, 100000);

  // Enrichment passes an id no catalog row matched through as a bare { id }, so
  // the adapter can only write the derived capability for it. That is silence
  // about the model, not a statement that it has no size — clearing here deleted
  // a previous lookup (or a hand-typed limit) on every miss.
  await omp.apply({ ...provider, id: "unknown", models: [{ id: "model-a" }, { id: "model-b" }] });
  const kept = read();
  assert.equal(kept.contextWindow, 100000);
  assert.equal(kept.maxTokens, 8192);
  assert.equal(kept.reasoning, true);
  assert.equal(kept.name, "Model A", "the stored name survives alongside the limits");

  // An entry that does carry metadata still clears what it omits: dropping
  // maxTokens while keeping a size is a deliberate statement about model-a.
  await omp.apply({ ...provider, id: "unknown", models: [
    { id: "model-a", name: "Model A", reasoning: false, contextWindow: 64000 },
    { id: "model-b" },
  ] });
  const narrowed = read();
  assert.equal(narrowed.reasoning, false);
  assert.equal(narrowed.contextWindow, 64000);
  assert.equal(narrowed.maxTokens, undefined);
  await omp.prune({ ...provider, id: "unknown" });
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

test("a store model with no metadata of its own leaves the config's metadata alone", async () => {
  const omp = targets.find((t) => t.id === "omp")!;
  const file = path.join(sandbox, ".omp", "agent", "models.yml");
  await omp.apply({ ...provider, id: "stub" });
  const before = YAML.parse(fs.readFileSync(file, "utf8")).providers.stub.models[0];
  assert.equal(before.contextWindow, 100000);

  // the store knows only the id — that is ignorance, not a catalog saying the model shrank
  await omp.apply({ ...provider, id: "stub", models: [{ id: "model-a" }] });
  const after = YAML.parse(fs.readFileSync(file, "utf8")).providers.stub.models[0];
  assert.equal(after.name, "Model A");
  assert.equal(after.contextWindow, 100000);
  assert.equal(after.maxTokens, 8192);
  assert.deepEqual(after.input, ["text", "image"]);

  const workbuddy = targets.find((t) => t.id === "workbuddy")!;
  await workbuddy.apply({ ...provider, id: "stub" });
  await workbuddy.apply({ ...provider, id: "stub", models: [{ id: "model-a" }] });
  const wbFile = JSON.parse(fs.readFileSync(path.join(sandbox, ".workbuddy", "models.json"), "utf8"));
  const wbRows = (Array.isArray(wbFile) ? wbFile : wbFile.models) as Array<Record<string, unknown>>;
  const wbModel = wbRows.find((m) => m.id === "model-a")!;
  assert.equal(wbModel.name, "Model A", "workbuddy keeps the row name instead of falling back to the id");
  assert.equal(wbModel.maxInputTokens, 100000);
  assert.equal(wbModel.supportsImages, true);
  await workbuddy.prune({ ...provider, id: "stub" });
  await omp.prune({ ...provider, id: "stub" });
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
  assert.equal(creds.refs[managedCredentialRef("orphan")], undefined);
  assert.equal(creds.refs.KEEP_ME, "sk-keep");
  assert.ok((await dsh.prune({ ...provider, id: "orphan" })).skipped, "second prune has nothing left");
});
