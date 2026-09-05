import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Provider } from "../src/types.js";
import type { ProviderCandidate } from "../src/targets/types.js";

// Adapters resolve home at module init; isolate before dynamic imports.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "ssw-import-"));
process.env.HOME = sandbox;
process.env.AGENTSW_HOME = sandbox;
delete process.env.HERMES_HOME;
delete process.env.WORKBUDDY_CONFIG_DIR;
delete process.env.CODEBUDDY_CONFIG_DIR;
delete process.env.DSH_HOME;
delete process.env.PI_CODING_AGENT_DIR;
delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
delete process.env.OPENCODE_CONFIG_DIR;
delete process.env.OPENCODE_CONFIG;

const { targets } = await import("../src/targets/index.js");
const { mergeCandidates, normalizeUrl } = await import("../src/import.js");
const { ccSwitchCandidates } = await import("../src/sources/ccswitch.js");

after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

test("adapter candidates round-trip and dedupe by protocol, endpoint, and credentials", async () => {
  for (const dir of [".codex", ".omp/agent", ".pi/agent"]) {
    fs.mkdirSync(path.join(sandbox, dir), { recursive: true });
  }

  const openai: Provider = {
    id: "sub",
    name: "Sub Responses",
    protocol: "openai",
    baseUrl: "https://sub.example/v1",
    apiKey: "sk-sub-openai",
    defaultModel: "gpt-5",
    models: [{ id: "gpt-5" }, { id: "glm-4.6" }],
  };
  const anthropic: Provider = {
    id: "sub-anthropic",
    name: "Sub Anthropic",
    protocol: "anthropic",
    baseUrl: "https://sub.example/v1",
    apiKey: "sk-sub-anthropic",
    defaultModel: "claude-sonnet-4-5",
    models: [{ id: "claude-sonnet-4-5" }],
  };

  const byId = (id: string) => targets.find((t) => t.id === id)!;
  await byId("codex").apply(openai);
  await byId("pi").apply(openai);
  await byId("omp").apply(anthropic);

  const rows: ProviderCandidate[] = ["codex", "pi", "omp"].flatMap((id) => byId(id).candidates?.() ?? []);
  const merged = mergeCandidates(rows, [
    { id: "existing-sub", protocol: "openai", baseUrl: "https://sub.example/v1/", apiKey: "sk-sub-openai" },
  ]);

  assert.equal(merged.length, 2, "same URL is not deduped across different wire protocols");

  const responses = merged.find((c) => c.protocol === "openai")!;
  assert.equal(responses.id, "sub");
  assert.deepEqual(responses.sources.sort(), ["codex", "pi"]);
  assert.deepEqual(responses.models, ["gpt-5", "glm-4.6"]);
  assert.equal(responses.apiKey, "sk-sub-openai");
  assert.equal(responses.openaiApi, "responses", "codex's responses wire wins over pi's chat-completions entry");
  assert.equal(responses.configured, "existing-sub", "trailing slash is ignored for existing-provider dedupe");

  const messages = merged.find((c) => c.protocol === "anthropic")!;
  assert.equal(messages.id, "sub-anthropic");
  assert.deepEqual(messages.sources, ["omp"]);
  assert.deepEqual(messages.models, ["claude-sonnet-4-5"]);
  assert.equal(messages.apiKey, "sk-sub-anthropic");
  assert.equal(messages.configured, undefined);
});

test("every adapter exposes an applied custom provider for import", async () => {
  for (const dir of [
    ".claude",
    ".codex",
    ".omp/agent",
    ".pi/agent",
    ".prime/agent",
    ".config/opencode",
    ".hermes",
    ".workbuddy",
    ".dsh",
  ]) {
    fs.mkdirSync(path.join(sandbox, dir), { recursive: true });
  }

  for (const target of targets) {
    const protocol = target.id === "claude" ? "anthropic" : "openai";
    const baseUrl = `https://${target.id}.import.test/v1`;
    const model = `model-${target.id}`;
    const provider: Provider = {
      id: `round-${target.id}`,
      name: `Round ${target.name}`,
      protocol,
      baseUrl,
      apiKey: `sk-${target.id}`,
      defaultModel: model,
      models: [{ id: model }],
    };

    await target.apply(provider);
    const normUrl = (u: string) => u.replace(/\/v\d+(?:beta\d*)?\/?$/i, "").replace(/\/+$/, "");
    const candidate = target.candidates?.().find((c) => normUrl(c.baseUrl) === normUrl(baseUrl));
    assert.ok(candidate, `${target.id} should expose its written provider`);
    assert.equal(candidate.protocol, protocol, `${target.id} protocol`);
    assert.equal(candidate.apiKey, provider.apiKey, `${target.id} API key`);
    assert.ok(candidate.models.includes(model), `${target.id} model list`);
    assert.equal(candidate.source, target.id, `${target.id} source marker`);
    assert.equal(candidate.generatedId, target.id === "claude" || target.id === "workbuddy" ? true : undefined, `${target.id} generated-ID provenance`);
  }
});

test("cc-switch's own store imports, one row shape per managed app", async () => {
  fs.mkdirSync(path.join(sandbox, ".cc-switch"), { recursive: true });
  const db = new DatabaseSync(path.join(sandbox, ".cc-switch", "cc-switch.db"));
  db.exec(
    "CREATE TABLE providers (id TEXT NOT NULL, app_type TEXT NOT NULL, name TEXT NOT NULL," +
      " settings_config TEXT NOT NULL, meta TEXT NOT NULL DEFAULT '{}', PRIMARY KEY (id, app_type))",
  );
  const insert = db.prepare("INSERT INTO providers (id, app_type, name, settings_config, meta) VALUES (?, ?, ?, ?, ?)");
  // claude / claude-desktop: env block
  insert.run("uuid-1", "claude", "Zhipu GLM", JSON.stringify({
    env: { ANTHROPIC_BASE_URL: "https://open.bigmodel.cn/api/anthropic", ANTHROPIC_AUTH_TOKEN: "sk-zhipu", ANTHROPIC_MODEL: "glm-5.1" },
  }), "{}");
  // codex: literal config.toml text plus auth.json contents
  insert.run("uuid-2", "codex", "sub", JSON.stringify({
    auth: { OPENAI_API_KEY: "sk-codex" },
    config: 'model_provider = "custom"\nmodel = "gpt-5.6-sol"\n\n[model_providers]\n[model_providers.custom]\nwire_api = "responses"\nbase_url = "https://new.vfing.de/v1"\n',
  }), "{}");
  // opencode / openclaw / hermes / pi: the pi-family shape
  insert.run("uuid-3", "openclaw", "Reseller", JSON.stringify({
    api: "openai-completions",
    apiKey: "sk-openclaw",
    baseUrl: "https://gateway.example/v1",
    models: [{ id: "model-a" }, { id: "model-b" }],
  }), "{}");
  // an official/empty row carries no endpoint and must be skipped, not imported blank
  insert.run("uuid-4", "claude", "Claude Official", JSON.stringify({ env: {} }), "{}");
  db.close();

  const rows = ccSwitchCandidates();
  assert.equal(rows.length, 3, "the keyless official row is skipped");
  assert.ok(rows.every((r) => r.source === "cc-switch"));

  const claude = rows.find((r) => r.id === "zhipu-glm")!;
  assert.equal(claude.protocol, "anthropic");
  assert.equal(claude.apiKey, "sk-zhipu");
  assert.deepEqual(claude.models, ["glm-5.1"]);

  const codex = rows.find((r) => r.id === "sub")!;
  assert.equal(codex.protocol, "openai");
  assert.equal(codex.openaiApi, "responses", "codex rows carry their wire");
  assert.equal(codex.baseUrl, "https://new.vfing.de/v1");
  assert.equal(codex.apiKey, "sk-codex");
  assert.equal(codex.defaultModel, "gpt-5.6-sol");

  const openclaw = rows.find((r) => r.id === "reseller")!;
  assert.equal(openclaw.protocol, "openai");
  assert.equal(openclaw.openaiApi, "completions");
  assert.deepEqual(openclaw.models, ["model-a", "model-b"]);

  // a cc-switch row and an app config pointing at the same endpoint are one provider
  const merged = mergeCandidates(
    [...rows, { id: "gw", name: "gw", protocol: "openai", baseUrl: "https://gateway.example/v1", apiKey: "sk-openclaw", models: ["model-c"], source: "omp" }],
    [],
  );
  const gateway = merged.find((c) => c.baseUrl === "https://gateway.example/v1")!;
  assert.deepEqual(gateway.sources.sort(), ["cc-switch", "omp"]);
  assert.deepEqual(gateway.models, ["model-a", "model-b", "model-c"]);
});

test("a base URL with and without the /v1 segment is one provider", () => {
  // OpenAI-compatible clients carry `/v1`; URL matching also recognizes an
  // unversioned candidate from clients that append the version themselves.
  const merged = mergeCandidates(
    [
      { id: "sub", name: "sub", protocol: "openai", openaiApi: "responses", baseUrl: "https://new.vfing.de", apiKey: "sk-codex", models: ["gpt-5.6-sol"], source: "cc-switch" },
      { id: "sub", name: "sub", protocol: "openai", baseUrl: "https://new.vfing.de/v1", apiKey: "sk-codex", models: ["glm-5.3-flash"], source: "omp" },
    ],
    [],
  );
  assert.equal(merged.length, 1, "the /v1 suffix must not split one endpoint in two");
  assert.equal(merged[0]!.baseUrl, "https://new.vfing.de/v1", "the variant naming the version wins");
  assert.deepEqual(merged[0]!.sources.sort(), ["cc-switch", "omp"]);
  assert.deepEqual(merged[0]!.models, ["gpt-5.6-sol", "glm-5.3-flash"]);
  assert.equal(merged[0]!.openaiApi, "responses");

  // an already-configured provider is recognized across the same difference
  const again = mergeCandidates(
    [{ id: "sub", name: "sub", protocol: "openai", baseUrl: "https://new.vfing.de", apiKey: "sk-same", models: [], source: "cc-switch" }],
    [{ id: "vfing", protocol: "openai", baseUrl: "https://new.vfing.de/v1", apiKey: "sk-same" }],
  );
  assert.equal(again[0]!.configured, "vfing");

  // a different protocol on the same host still stays its own provider
  const split = mergeCandidates(
    [
      { id: "a", name: "a", protocol: "openai", baseUrl: "https://new.vfing.de/v1", models: [], source: "omp" },
      { id: "b", name: "b", protocol: "anthropic", baseUrl: "https://new.vfing.de", models: [], source: "omp" },
    ],
    [],
  );
  assert.equal(split.length, 2);
});

function candidate(overrides: Partial<ProviderCandidate> = {}): ProviderCandidate {
  return {
    id: "custom-account",
    name: "Custom account",
    protocol: "openai",
    baseUrl: "https://API.Example.COM/Tenant/v1/",
    apiKey: "fixture-account-a",
    models: ["model-a"],
    source: "omp",
    ...overrides,
  };
}

test("same endpoint with distinct literal credentials remains distinct regardless of row order", () => {
  const rows = [candidate(), candidate({ id: "second-account", apiKey: "fixture-account-b", models: ["model-b"], source: "pi" })];
  for (const ordered of [rows, [...rows].reverse()]) {
    const merged = mergeCandidates(ordered, [
      { id: "existing-a", protocol: "openai", baseUrl: "https://api.example.com/Tenant", apiKey: "fixture-account-a" },
      { id: "existing-b", protocol: "openai", baseUrl: "https://api.example.com/Tenant/v1", apiKey: "fixture-account-b" },
    ]);
    assert.equal(merged.length, 2);
    assert.equal(merged.find((c) => c.id === "custom-account")!.configured, "existing-a");
    assert.equal(merged.find((c) => c.id === "second-account")!.configured, "existing-b");
    assert.deepEqual(merged.find((c) => c.id === "custom-account")!.models, ["model-a"]);
    assert.deepEqual(merged.find((c) => c.id === "second-account")!.models, ["model-b"]);
  }
});

test("unknown credentials never attach to a resolved account, including an ambiguous endpoint", () => {
  const unknown = candidate({ id: "unresolved", apiKey: undefined, keyEnv: "MISSING_ACCOUNT_KEY", source: "codex" });
  const resolved = [candidate(), candidate({ id: "second-account", apiKey: "fixture-account-b", source: "pi" })];
  for (const accounts of [resolved.slice(0, 1), resolved]) {
    for (const rows of [[unknown, ...accounts], [...accounts, unknown]]) {
      const merged = mergeCandidates(rows, accounts);
      assert.equal(merged.length, accounts.length + 1);
      const missing = merged.find((c) => c.id === "unresolved")!;
      assert.equal(missing.apiKey, undefined);
      assert.equal(missing.configured, undefined);
      assert.deepEqual(missing.sources, ["codex"]);
    }
  }
});

test("unresolved credential references only merge with that same reference", () => {
  const merged = mergeCandidates([
    candidate({ apiKey: undefined, keyEnv: "SHARED_KEY", source: "omp" }),
    candidate({ id: "same-reference", apiKey: undefined, keyEnv: "SHARED_KEY", source: "pi", models: ["model-b"] }),
    candidate({ id: "other-reference", apiKey: undefined, keyEnv: "OTHER_KEY", source: "codex" }),
    candidate({ id: "unknown-one", apiKey: undefined, source: "claude" }),
    candidate({ id: "unknown-two", apiKey: undefined, source: "workbuddy" }),
  ], []);
  assert.equal(merged.length, 4);
  assert.deepEqual(merged.find((c) => c.keyEnv === "SHARED_KEY")!.models, ["model-a", "model-b"]);
  assert.ok(merged.every((c) => c.configured === undefined && c.apiKey === undefined));
});

test("existing-store matching requires resolved credentials rather than endpoint alone", () => {
  for (const apiKey of [undefined, "", "fixture-account-b"]) {
    const merged = mergeCandidates([candidate()], [
      { id: "not-this-account", protocol: "openai", baseUrl: "https://api.example.com/Tenant", apiKey },
    ]);
    assert.equal(merged[0]!.configured, undefined);
  }
});

test("URL normalization folds hostname only and preserves path, port, and query distinctions", () => {
  assert.equal(normalizeUrl("HTTPS://API.Example.COM:443/Tenant/v1///?route=/v1#Part"), "https://api.example.com:443/Tenant/v1?route=/v1#Part");
  assert.equal(normalizeUrl("https://User:Pass@API.Example.COM:8443/Tenant/"), "https://User:Pass@api.example.com:8443/Tenant");
  const equivalent = mergeCandidates([
    candidate(),
    candidate({ id: "different-explicit-id", baseUrl: "https://api.example.com/Tenant", source: "pi" }),
    candidate({ baseUrl: "https://api.example.com/Tenant/v2beta1", source: "codex" }),
  ], []);
  assert.equal(equivalent.length, 1);
  assert.equal(equivalent[0]!.id, "custom-account", "imports preserve the first explicit candidate ID");
  assert.equal(equivalent[0]!.name, "Custom account");
  for (const baseUrl of [
    "https://api.example.com/tenant/v1",
    "https://api.example.com:8443/Tenant/v1",
    "https://api.example.com:443/Tenant/v1",
    "http://api.example.com/Tenant/v1",
    "https://api.example.com/Tenant/V1",
    "https://api.example.com/Tenant/v1?account=b",
    "https://api.example.com/Tenant/v1/child",
  ]) {
    assert.equal(mergeCandidates([candidate(), candidate({ baseUrl, source: "pi" })], []).length, 2, baseUrl);
  }
  assert.equal(mergeCandidates([
    candidate({ baseUrl: "https://api.example.com/Tenant?route=/v1" }),
    candidate({ baseUrl: "https://api.example.com/Tenant?route=", source: "pi" }),
  ], []).length, 2, "a version-looking query value is not an endpoint suffix");
});

test("WorkBuddy import preserves per-model accounts on a shared endpoint", () => {
  const target = targets.find((t) => t.id === "workbuddy")!;
  const dir = path.dirname(target.configPaths[0]!);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "models.json"), JSON.stringify({ models: [
    { id: "account-a-one", url: "https://api.shared.example/v1/chat/completions", apiKey: "fixture-account-a" },
    { id: "account-a-two", url: "https://api.shared.example/v1/chat/completions", apiKey: "fixture-account-a" },
    { id: "account-b", url: "https://api.shared.example/v1/chat/completions", apiKey: "fixture-account-b" },
    { id: "missing-key", url: "https://api.shared.example/v1/chat/completions" },
  ] }));
  const rows = target.candidates!();
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.id === "api-shared-example-openai"));
  assert.ok(rows.every((r) => r.generatedId === true));
  assert.ok(rows.every((r) => r.name === "api.shared.example (openai)"));
  assert.deepEqual(rows.find((r) => r.apiKey === "fixture-account-a")!.models, ["account-a-one", "account-a-two"]);
  assert.deepEqual(rows.find((r) => r.apiKey === "fixture-account-b")!.models, ["account-b"]);
  assert.deepEqual(rows.find((r) => !r.apiKey)!.models, ["missing-key"]);
  assert.equal(mergeCandidates(rows, []).length, 3);
});

test("Claude's generated ID never replaces OMP's explicit sub identity for the same account", () => {
  const generated = candidate({
    id: "new-vfing-de-anthropic",
    generatedId: true,
    name: "new.vfing.de (anthropic)",
    protocol: "anthropic",
    baseUrl: "https://new.vfing.de",
    source: "claude",
  });
  const explicit = candidate({
    id: "sub",
    name: "My Sub provider",
    protocol: "anthropic",
    baseUrl: "https://new.vfing.de/v1",
    models: ["model-b"],
    source: "omp",
  });
  for (const rows of [[generated, explicit], [explicit, generated]]) {
    const merged = mergeCandidates(rows, []);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.id, "sub");
    assert.equal(merged[0]!.name, "My Sub provider");
    assert.equal(merged[0]!.generatedId, undefined);
    assert.deepEqual([...merged[0]!.models].sort(), ["model-a", "model-b"]);
  }
  const existing = [{ id: "stable-store-id", protocol: "anthropic" as const, baseUrl: explicit.baseUrl, apiKey: explicit.apiKey }];
  assert.equal(mergeCandidates([generated, explicit], existing)[0]!.configured, "stable-store-id", "existing store identity still wins over every candidate");
  assert.equal(mergeCandidates([explicit, { ...explicit, id: "second-explicit", name: "Second explicit" }], [])[0]!.id, "sub", "two explicit identities retain first-candidate precedence");
});
