import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import YAML from "yaml";
import type { Provider } from "../src/types.js";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agentsw-adapter-regressions-"));
const envNames = [
  "HOME", "AGENTSW_HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME",
  "WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR", "HERMES_HOME", "DSH_HOME",
  "PI_CODING_AGENT_DIR", "PRIME_AGENT_CODING_AGENT_DIR", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG",
  "AGENTSW_ADAPTER_FIXTURE_ENV", "AGENTSW_ADAPTER_MISSING_ENV",
];
const originalEnv = new Map(envNames.map((key) => [key, process.env[key]]));
for (const key of envNames) delete process.env[key];
process.env.HOME = sandbox;
process.env.AGENTSW_HOME = sandbox;
process.env.WORKBUDDY_CONFIG_DIR = path.join(sandbox, ".workbuddy");

// All path-capturing modules load only after portable HOME and overrides are sandboxed.
const { targets } = await import("../src/targets/index.js");
const { piStyleTarget } = await import("../src/targets/pistyle.js");
const { setDryRun, drainPendingWrites } = await import("../src/fsutil.js");
const { localProviderId } = await import("../src/provider-identity.js");
const codex = targets.find((target) => target.id === "codex")!;
const opencode = targets.find((target) => target.id === "opencode")!;
const workbuddy = targets.find((target) => target.id === "workbuddy")!;

const provider: Provider = {
  id: "fixture-provider",
  name: "Fixture Provider",
  protocol: "openai",
  baseUrl: "https://fixture.example/v1",
  apiKey: "fixture-account-key",
  defaultModel: "model-a",
  models: [{ id: "model-a" }, { id: "model-b" }],
};

function put(relative: string, value: unknown): string {
  const file = path.join(sandbox, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
  return file;
}

function fileTree(dir = sandbox): Record<string, string> {
  const files: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files[`${path.relative(sandbox, file)}/`] = "directory";
      Object.assign(files, fileTree(file));
    } else files[path.relative(sandbox, file)] = fs.readFileSync(file).toString("base64");
  }
  return files;
}

beforeEach(() => {
  setDryRun(false);
  for (const entry of fs.readdirSync(sandbox)) fs.rmSync(path.join(sandbox, entry), { recursive: true, force: true });
  delete process.env.AGENTSW_ADAPTER_FIXTURE_ENV;
  delete process.env.AGENTSW_ADAPTER_MISSING_ENV;
});
after(() => {
  setDryRun(false);
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test("Codex preserves custom transport options and clears only conflicting owned authentication", async () => {
  const file = put(".codex/config.toml", stringifyToml({
    features: { goals: true },
    model_providers: {
      [provider.id]: {
        name: "Previous",
        base_url: "https://previous.example/v1",
        wire_api: "chat",
        env_key: "UNRELATED_EXTERNAL_KEY",
        env_key_instructions: "Use the external key",
        experimental_bearer_token: "fixture-previous-token",
        requires_openai_auth: false,
        http_headers: { "X-Tenant": "tenant-one", Authorization: "Bearer fixture-old", "x-api-key": "fixture-old" },
        env_http_headers: { "X-Region": "EXTERNAL_REGION", authorization: "EXTERNAL_AUTH" },
        query_params: { "api-version": "2026-01-01" },
        request_max_retries: 7,
        stream_max_retries: 9,
        stream_idle_timeout_ms: 45000,
        custom_transport: { enabled: true },
      },
      unrelated: { base_url: "https://unrelated.example/v1", env_key: "EXTERNAL_KEY" },
    },
  }));
  const authFile = put(".codex/auth.json", { tokens: { access_token: "fixture-external-token" }, custom: true });
  await codex.apply(provider);
  const config = parseToml(fs.readFileSync(file, "utf8")) as Record<string, any>;
  const entry = config.model_providers[provider.id];
  assert.deepEqual(entry.http_headers, { "X-Tenant": "tenant-one" });
  assert.deepEqual(entry.env_http_headers, { "X-Region": "EXTERNAL_REGION" });
  assert.deepEqual(entry.query_params, { "api-version": "2026-01-01" });
  assert.equal(entry.request_max_retries, 7);
  assert.equal(entry.stream_max_retries, 9);
  assert.equal(entry.stream_idle_timeout_ms, 45000);
  assert.deepEqual(entry.custom_transport, { enabled: true });
  assert.equal(entry.env_key, undefined);
  assert.equal(entry.env_key_instructions, undefined);
  assert.equal(entry.experimental_bearer_token, undefined);
  assert.equal(entry.requires_openai_auth, true);
  assert.equal(entry.wire_api, "responses");
  assert.equal(config.model_providers.unrelated.env_key, "EXTERNAL_KEY");
  assert.equal(config.features.goals, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(authFile, "utf8")), {
    tokens: { access_token: "fixture-external-token" }, custom: true,
    auth_mode: "apikey", OPENAI_API_KEY: provider.apiKey,
  });
});

test("Codex invalid late auth input leaves config, credentials, backups and previews untouched", async () => {
  put(".codex/config.toml", 'model = "original"\n');
  for (const malformed of ['{"OPENAI_API_KEY":', "null", "[]", "false"]) {
    put(".codex/auth.json", malformed);
    const before = fileTree();
    await assert.rejects(codex.apply(provider));
    assert.deepEqual(fileTree(), before);
    setDryRun(true);
    await assert.rejects(codex.apply(provider));
    assert.deepEqual(drainPendingWrites(), []);
    assert.deepEqual(fileTree(), before);
    setDryRun(false);
  }
});

test("OpenCode keeps Responses npm when unspecified and respects explicit wire changes", async () => {
  const file = put(".config/opencode/opencode.json", {
    theme: "dark",
    provider: {
      [provider.id]: {
        npm: "@ai-sdk/openai", custom: true,
        options: { headers: { "X-Tenant": "fixture" } },
        models: { "model-a": { customModelOption: 12 }, removed: { name: "Removed" } },
      },
    },
  });
  await opencode.apply(provider);
  let config = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(config.provider[provider.id].npm, "@ai-sdk/openai");
  assert.deepEqual(config.provider[provider.id].options.headers, { "X-Tenant": "fixture" });
  assert.equal(config.provider[provider.id].models["model-a"].customModelOption, 12);
  assert.equal(config.provider[provider.id].models.removed, undefined);
  assert.equal(opencode.candidates!()[0]!.openaiApi, "responses");
  await opencode.apply({ ...provider, openaiApi: "completions" });
  config = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(config.provider[provider.id].npm, "@ai-sdk/openai-compatible");
});

test("Pi and OMP import effective model wires, rejecting inherited mixed protocols", () => {
  for (const id of ["omp", "pi", "prime"]) {
    const target = targets.find((candidate) => candidate.id === id)!;
    const config = { providers: {
      mixed: {
        baseUrl: provider.baseUrl, api: "openai-responses", apiKey: "fixture-key",
        models: [{ id: "inherited" }, { id: "override", api: "anthropic-messages" }],
      },
      mixedOpenAI: {
        baseUrl: provider.baseUrl, api: "openai-responses", apiKey: "fixture-key",
        models: [{ id: "inherited" }, { id: "override", api: "openai-completions" }],
      },
      unsupported: {
        baseUrl: provider.baseUrl, api: "openai-responses", apiKey: "fixture-key",
        models: [{ id: "override", api: "google-generative-ai" }],
      },
      responses: {
        baseUrl: provider.baseUrl, api: "openai-responses", apiKey: "fixture-key",
        models: [{ id: "inherited" }, { id: "override", api: "azure-openai-responses" }],
      },
    } };
    put(path.relative(sandbox, target.configPaths[0]!), id === "omp" ? YAML.stringify(config) : config);
    const candidates = target.candidates!();
    assert.deepEqual(candidates.map((candidate) => candidate.id), ["responses"], id);
    assert.equal(candidates[0]!.openaiApi, "responses", id);
  }
});

test("Pi command, file and unresolved env credentials never become literal import keys", () => {
  const marker = path.join(sandbox, "command-must-not-run");
  const rawKeys = [
    `!printf fixture > ${marker}`, "{file:/fixture/secret}", "file:///fixture/secret", "~/fixture/secret",
    "$AGENTSW_ADAPTER_MISSING_ENV", "${AGENTSW_ADAPTER_MISSING_ENV}", "{env:AGENTSW_ADAPTER_MISSING_ENV}",
  ];
  const entries = Object.fromEntries(rawKeys.map((apiKey, index) => [`unresolved-${index}`, {
    apiKey, api: "openai-completions", baseUrl: provider.baseUrl, models: [{ id: "model-a" }],
  }]));
  const pi = targets.find((target) => target.id === "pi")!;
  put(".pi/agent/models.json", { providers: entries });
  const candidates = pi.candidates!();
  assert.equal(candidates.length, rawKeys.length);
  assert.ok(candidates.every((candidate) => candidate.apiKey === undefined));
  assert.equal(fs.existsSync(marker), false);
  process.env.AGENTSW_ADAPTER_FIXTURE_ENV = "fixture-resolved-env";
  put(".pi/agent/models.json", { providers: { resolved: {
    apiKey: "${AGENTSW_ADAPTER_FIXTURE_ENV}", api: "openai-completions", baseUrl: provider.baseUrl,
  } } });
  assert.equal(pi.candidates!()[0]!.apiKey, "fixture-resolved-env");
  const prime = targets.find((target) => target.id === "prime")!;
  put(".prime/agent/models.json", { providers: { literal: {
    apiKey: "AGENTSW_ADAPTER_MISSING_ENV", api: "openai-completions", baseUrl: provider.baseUrl,
  } } });
  assert.equal(prime.candidates!()[0]!.apiKey, "AGENTSW_ADAPTER_MISSING_ENV", "Prime retains its bare-name literal fallback");
});

test("WorkBuddy custom endpoint and query survive import and sync without an injected v1", async () => {
  for (const url of [
    "https://fixture.example/api/chat/completions",
    "https://fixture.example/api/chat/completions?tenant=fixture&version=2",
    "https://fixture.example/api/chat/completions?prefix=fixture/",
    "https://fixture.example/v1/chat/completions",
    "https://fixture.example/chat/completions",
  ]) {
    const file = put(".workbuddy/models.json", [{ id: "model-a", url, apiKey: provider.apiKey }]);
    const candidate = workbuddy.candidates!()[0]!;
    await workbuddy.apply({ ...provider, id: candidate.id, baseUrl: candidate.baseUrl, models: [{ id: "model-a" }] });
    assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).models[0].url, url);
  }
  const file = put(".workbuddy/models.json", []);
  await workbuddy.apply({ ...provider, baseUrl: "https://fixture.example?tenant=fixture", models: [{ id: "model-a" }] });
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).models[0].url, "https://fixture.example/v1/chat/completions?tenant=fixture");
});

test("WorkBuddy removes stale owned models and keys but retains other accounts and custom data", async () => {
  const url = "https://fixture.example/v1/chat/completions";
  const other = { id: "shared-old", vendor: provider.name, url, apiKey: "fixture-other-account", custom: true };
  const file = put(".workbuddy/models.json", {
    metadata: { custom: true },
    models: [
      { id: "model-a", vendor: provider.name, url, apiKey: provider.apiKey, customOption: 42 },
      { id: "stale", vendor: provider.name, url, apiKey: provider.apiKey },
      { id: "shared-old", vendor: provider.name, url, apiKey: provider.apiKey },
      other, { unknownRow: true },
    ],
    availableModels: ["model-a", "stale", "shared-old", "builtin-unrelated"],
  });
  await workbuddy.apply({ ...provider, models: [{ id: "model-a" }] });
  let config = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(config.metadata, { custom: true });
  assert.deepEqual(config.models.find((row: any) => row.apiKey === "fixture-other-account"), other);
  assert.equal(config.models.find((row: any) => row.id === "model-a").customOption, 42);
  assert.ok(config.models.some((row: any) => row.unknownRow));
  assert.equal(config.models.some((row: any) => row.id === "stale"), false);
  assert.deepEqual(new Set(config.availableModels), new Set(["model-a", "shared-old", "builtin-unrelated"]));
  const rotated = { ...provider, apiKey: "fixture-rotated-key", defaultModel: "fresh", models: [{ id: "fresh" }] };
  await workbuddy.apply(rotated);
  config = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(config.models.some((row: any) => row.apiKey === provider.apiKey), false);
  assert.equal(config.models.some((row: any) => row.id === "model-a"), false);
  assert.deepEqual(new Set(config.availableModels), new Set(["fresh", "shared-old", "builtin-unrelated"]));
  await workbuddy.prune({ ...rotated, models: [{ id: "outdated-store-model" }] });
  config = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(config.models, [other, { unknownRow: true }]);
  assert.deepEqual(new Set(config.availableModels), new Set(["shared-old", "builtin-unrelated"]));
});

test("WorkBuddy refuses unowned model ID collisions without writes and prunes by account not display name", async () => {
  const url = "https://fixture.example/v1/chat/completions";
  const file = put(".workbuddy/models.json", { models: [
    { id: "model-a", vendor: provider.name, url, apiKey: "fixture-other-account" },
    { id: "model-a", vendor: provider.name, url, apiKey: provider.apiKey },
  ], availableModels: ["model-a"] });
  const settingsFile = put(".workbuddy/settings.json", { model: "model-a", custom: true });
  const before = fileTree();
  await assert.rejects(workbuddy.apply(provider), /belongs to another account/);
  assert.deepEqual(fileTree(), before);
  await workbuddy.prune(provider);
  const config = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(config.models.length, 1);
  assert.equal(config.models[0].apiKey, "fixture-other-account");
  assert.deepEqual(config.availableModels, ["model-a"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(settingsFile, "utf8")), { model: "model-a", custom: true });
});

test("WorkBuddy local selectors stay stable, account-qualified, opaque and separate empty credentials", () => {
  const rows = [
    { id: "model-a", vendor: "Account", apiKey: "fixture-first-key" },
    { id: "model-b", vendor: "Account", apiKey: "fixture-second-key" },
    { id: "model-c", vendor: "Account", apiKey: "" },
    { id: "model-d", vendor: "Account" },
  ].map((row) => ({ ...row, url: "https://fixture.example/v1/chat/completions" }));
  put(".workbuddy/models.json", rows);
  const first = workbuddy.candidates!();
  assert.equal(first.length, 4);
  assert.equal(new Set(first.map((candidate) => candidate.id)).size, 1, "central generated IDs are unchanged");
  assert.equal(new Set(first.map((candidate) => candidate.localId)).size, 4);
  assert.ok(first.every((candidate) => candidate.localId === localProviderId(candidate)));
  assert.ok(first.every((candidate) => /^local-[a-f0-9]+$/.test(candidate.localId!)));
  put(".workbuddy/models.json", [...rows].reverse());
  const second = workbuddy.candidates!();
  for (const candidate of first) {
    assert.equal(second.find((row) => row.apiKey === candidate.apiKey)!.localId, candidate.localId);
  }
});

test("every exported target and Pi factory stages apply and prune previews without filesystem changes", async () => {
  const factory = piStyleTarget({ id: "factory-fixture", name: "Factory Fixture", configDirName: ".factory/agent", dirEnvVar: "AGENTSW_ADAPTER_MISSING_ENV" });
  for (const target of [...targets, factory]) {
    const supported = { ...provider, protocol: target.protocols[0]! };
    setDryRun(true);
    const absent = fileTree();
    const preview = await target.apply(supported);
    assert.ok(preview.changed.length > 0, target.id);
    assert.ok(drainPendingWrites().length > 0, target.id);
    assert.deepEqual(fileTree(), absent, `${target.id} preview created files or backups`);
    setDryRun(false);
    await target.apply(supported);
    const existing = fileTree();
    setDryRun(true);
    await target.apply({ ...supported, apiKey: "fixture-preview-rotation" });
    assert.ok(drainPendingWrites().length > 0, target.id);
    assert.deepEqual(fileTree(), existing, `${target.id} apply preview modified existing files`);
    await target.prune(supported);
    assert.ok(drainPendingWrites().length > 0, target.id);
    assert.deepEqual(fileTree(), existing, `${target.id} prune preview modified existing files`);
    setDryRun(false);
  }
});

test("WorkBuddy explicit ownership wins over identical endpoint and credential fallback", async () => {
  const a = { ...provider, id: "owner-a", defaultModel: "only-a", models: [{ id: "only-a" }] };
  const b = { ...provider, id: "owner-b", defaultModel: "only-b", models: [{ id: "only-b" }] };
  await workbuddy.apply(a);
  await workbuddy.apply(b);
  const file = path.join(sandbox, ".workbuddy/models.json");
  let config = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(new Set(config.models.map((model: { agentswProviderId: string }) => model.agentswProviderId)), new Set(["owner-a", "owner-b"]));
  assert.deepEqual(new Set(config.availableModels), new Set(["only-a", "only-b"]));
  await workbuddy.prune(b);
  config = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(config.models.map((model: { id: string }) => model.id), ["only-a"]);
  assert.deepEqual(config.availableModels, ["only-a"]);
});

test("removing mixed-wire overrides preserves the explicit provider Responses default", async () => {
  for (const id of ["pi", "prime", "omp"]) {
    const target = targets.find((candidate) => candidate.id === id)!;
    const relative = id === "omp" ? ".omp/agent/models.yml" : `.${id}/agent/models.json`;
    const config = { providers: { [provider.id]: { api: "openai-responses", baseUrl: provider.baseUrl, apiKey: provider.apiKey,
      models: [{ id: "keep" }, { id: "drop", api: "anthropic-messages" }] } } };
    const file = put(relative, id === "omp" ? YAML.stringify(config) : config);
    assert.equal(target.candidates!().some((candidate) => candidate.id === provider.id), false, "mixed imports remain rejected");
    await target.apply({ ...provider, openaiApi: undefined, defaultModel: "keep", models: [{ id: "keep" }] });
    const text = fs.readFileSync(file, "utf8");
    const result = id === "omp" ? YAML.parse(text) : JSON.parse(text);
    assert.equal(result.providers[provider.id].api, "openai-responses", id);
    assert.deepEqual(result.providers[provider.id].models.map((model: { id: string }) => model.id), ["keep"]);
  }
});
