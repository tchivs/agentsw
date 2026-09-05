import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import YAML from "yaml";
import type { Provider } from "../src/types.js";
import { legacyManagedCredentialRef, localProviderId, managedCredentialRef } from "../src/provider-identity.js";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agentsw-remove-"));
const envNames = ["HOME", "AGENTSW_HOME", "WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG", "HERMES_HOME", "DSH_HOME", "PI_CODING_AGENT_DIR", "PRIME_AGENT_CODING_AGENT_DIR", "FIXTURE_CODEX_KEY", "CUSTOM_KEY", ...Object.keys(process.env).filter((key) => key.startsWith("AGENTSW_"))];
const originalEnv = new Map(envNames.map((name) => [name, process.env[name]]));
for (const name of envNames) delete process.env[name];
process.env.HOME = sandbox;
process.env.AGENTSW_HOME = sandbox;
process.env.WORKBUDDY_CONFIG_DIR = path.join(sandbox, ".workbuddy");
process.env.OPENCODE_CONFIG_DIR = path.join(sandbox, "opencode-custom");
process.env.OPENCODE_CONFIG = path.join(sandbox, "opencode-shared.jsonc");
for (const name of ["CODEBUDDY_CONFIG_DIR", "HERMES_HOME", "DSH_HOME", "PI_CODING_AGENT_DIR", "PRIME_AGENT_CODING_AGENT_DIR"]) delete process.env[name];

// Adapters capture home at module load, so import after sandbox setup.
const { listRemovableProviders, removeProvider } = await import("../src/remove.js");
const { configFile } = await import("../src/store.js");
const { backupsDir, drainPendingWrites, writeFileAtomic } = await import("../src/fsutil.js");
const { targets } = await import("../src/targets/index.js");

const provider: Provider = {
  id: "remove-me", name: "Remove Me", protocol: "openai", baseUrl: "https://remove.example/v1",
  apiKey: "fixture-private-key", models: [{ id: "model-a" }], defaultModel: "model-a",
};

beforeEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(sandbox);
  for (const name of ["PI_CODING_AGENT_DIR", "PRIME_AGENT_CODING_AGENT_DIR", "HERMES_HOME", "DSH_HOME", "FIXTURE_CODEX_KEY", "CUSTOM_KEY"]) delete process.env[name];
  process.env.OPENCODE_CONFIG_DIR = path.join(sandbox, "opencode-custom");
  process.env.OPENCODE_CONFIG = path.join(sandbox, "opencode-shared.jsonc");
});
after(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

function put(relative: string, content: string | object): string {
  const file = path.join(sandbox, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n");
  return file;
}

function store(): string {
  return put(".config/agentsw/config.json", {
    version: 1, language: "en", active: provider.id,
    providers: { [provider.id]: provider, keep: { ...provider, id: "keep", name: "Keep" } },
    unknown: { keep: true },
  });
}

function parsed(file: string): any {
  const text = fs.readFileSync(file, "utf8");
  return /\.ya?ml$/.test(file) ? YAML.parse(text) : file.endsWith(".toml") ? parseToml(text) : parseJsonc(text);
}

function snapshot(): Map<string, string> {
  const files = new Map<string, string>();
  const visit = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else files.set(file, fs.readFileSync(file, "utf8"));
    }
  };
  visit(sandbox);
  return files;
}

test("store-only removal clears active without parsing or changing app configs", async () => {
  store();
  const omp = put(".omp/agent/models.yml", "broken: [\n");
  const result = await removeProvider(provider.id);
  assert.deepEqual(result.files, [configFile]);
  assert.ok(result.backupDir);
  const saved = parsed(configFile);
  assert.equal(saved.providers[provider.id], undefined);
  assert.equal(saved.active, undefined);
  assert.equal(saved.providers.keep.name, "Keep");
  assert.deepEqual(saved.unknown, { keep: true });
  assert.equal(fs.readFileSync(omp, "utf8"), "broken: [\n");
});

test("store plus prune backs up every changed original before removing matching targets", async () => {
  store();
  const omp = put(".omp/agent/models.yml", `# preserve\nproviders:\n  ${provider.id}: {}\n  keep: {auth: none}\n`);
  const ompConfig = put(".omp/agent/config.yml", { modelRoles: { default: `${provider.id}/model-a:max`, smol: "keep/small" }, theme: "dark" });
  const pi = put(".pi/agent/models.json", { providers: { [provider.id]: {}, keep: {} } });
  const piSettings = put(".pi/agent/settings.json", { defaultProvider: provider.id, defaultModel: "model-a", theme: "light" });
  const opencode = put(".config/opencode/opencode.json", { provider: { [provider.id]: {} }, model: `${provider.id}/model-a`, theme: "dark" });
  const ref = managedCredentialRef(provider.id);
  const hermes = put(".hermes/config.yaml", { providers: { [provider.id]: { key_env: ref } }, model: { provider: provider.id, default: "model-a" }, agent: { max_turns: 7 } });
  const env = put(".hermes/.env", `${ref}=${provider.apiKey}\nKEEP=fixture-keep\n`);
  const originals = snapshot();
  const result = await removeProvider(provider.id, { prune: true });
  assert.deepEqual(new Set(result.files), new Set([configFile, omp, ompConfig, pi, piSettings, opencode, hermes, env]));
  assert.ok(result.backupDir);
  const backups = fs.readdirSync(result.backupDir!).map((name) => fs.readFileSync(path.join(result.backupDir!, name), "utf8"));
  for (const file of result.files) assert.ok(backups.includes(originals.get(file)!), `${path.basename(file)} original backed up`);
  assert.equal(parsed(configFile).providers[provider.id], undefined);
  assert.deepEqual(parsed(ompConfig), { modelRoles: { smol: "keep/small" }, theme: "dark" });
  assert.deepEqual(parsed(piSettings), { theme: "light" });
  assert.deepEqual(parsed(opencode), { theme: "dark" });
  assert.equal(parsed(hermes).agent.max_turns, 7);
  assert.equal(fs.readFileSync(env, "utf8"), "KEEP=fixture-keep\n");
});

const localCases = [
  { app: "omp", file: ".omp/agent/models.yml", value: { providers: { local: {}, keep: {} } }, map: ["providers"] },
  { app: "pi", file: ".pi/agent/models.json", value: { providers: { local: { headers: { "X-Custom": "yes" } }, keep: {} } }, map: ["providers"] },
  { app: "prime", file: ".prime/agent/models.json", value: { providers: { local: { modelOverrides: {} }, keep: {} } }, map: ["providers"] },
  { app: "opencode", file: ".config/opencode/opencode.jsonc", value: { provider: { local: { options: {} }, keep: {} } }, map: ["provider"] },
  { app: "hermes", file: ".hermes/config.yaml", value: { providers: { local: { name: "Local Hermes" }, keep: {} } }, map: ["providers"] },
  { app: "dsh", file: ".dsh/settings.yaml", value: { "llm-pi-ai": { providers: { local: { displayName: "Local DSH" }, keep: {} } } }, map: ["llm-pi-ai", "providers"] },
];
for (const fixture of localCases) {
  test(`lists and removes unregistered ${fixture.app} without endpoint, model or API-key metadata`, async () => {
    const file = put(fixture.file, fixture.value);
    const rows = listRemovableProviders();
    assert.equal(rows.filter((row) => row.id === "local" && row.app === fixture.app).length, 1);
    assert.equal(rows.some((row) => row.id === "local" && row.app === undefined), false);
    assert.ok(rows.every((row) => Object.keys(row).every((key) => ["id", "app", "name"].includes(key))));
    const result = await removeProvider("local", { apps: fixture.app });
    assert.deepEqual(result.files, [file]);
    const map = fixture.map.reduce((value, key) => value[key], parsed(file));
    assert.equal(map.local, undefined);
    assert.deepEqual(map.keep, {});
    assert.equal(fs.existsSync(configFile), false);
  });
}

test("app scoping preserves store and same-ID entries at other endpoints and accounts", async () => {
  store();
  const pi = put(".pi/agent/models.json", { providers: { [provider.id]: { baseUrl: "https://pi.example", apiKey: "fixture-pi-account" } } });
  const prime = put(".prime/agent/models.json", { providers: { [provider.id]: { baseUrl: "https://prime.example", apiKey: "fixture-prime-account" } } });
  const before = snapshot();
  const result = await removeProvider(provider.id, { apps: "pi,pi" });
  assert.deepEqual(result.files, [pi]);
  assert.equal(fs.readFileSync(configFile, "utf8"), before.get(configFile));
  assert.equal(fs.readFileSync(prime, "utf8"), before.get(prime));
});

for (const [field, entry] of Object.entries({
  endpoint: { baseUrl: "https://other.example/v1" },
  protocol: { api: "anthropic-messages" },
  credential: { apiKey: "fixture-other-account" },
})) {
  test(`global prune rejects same-ID ${field} conflicts before any mutations; app-only can delete them`, async () => {
    store();
    put(".omp/agent/models.yml", { providers: { [provider.id]: {} } });
    const prime = put(".prime/agent/models.json", { providers: { [provider.id]: entry } });
    const before = snapshot();
    await assert.rejects(removeProvider(provider.id, { prune: true }), new RegExp(`different ${field}`));
    assert.deepEqual(snapshot(), before);
    assert.equal(fs.existsSync(backupsDir), false);
    const result = await removeProvider(provider.id, { apps: "prime" });
    assert.deepEqual(result.files, [prime]);
    assert.equal(fs.readFileSync(configFile, "utf8"), before.get(configFile));
  });
}

test("app-only removal does not read a malformed unrelated store", async () => {
  put(".config/agentsw/config.json", "[invalid\n");
  const pi = put(".pi/agent/models.json", { providers: { local: {} } });
  await removeProvider("local", { apps: "pi" });
  assert.deepEqual(parsed(pi).providers, {});
  assert.equal(fs.readFileSync(configFile, "utf8"), "[invalid\n");
});

test("OpenCode global, custom and shared layers preserve comments and unrelated references", async () => {
  const paths = [".config/opencode/config.json", ".config/opencode/opencode.json", ".config/opencode/opencode.jsonc", "opencode-custom/opencode.json", "opencode-custom/opencode.jsonc", "opencode-shared.jsonc"];
  const files = paths.map((file) => put(file, `// preserve comment\n${JSON.stringify({
    provider: { local: {}, "local-more": { options: { apiKey: "fixture-unrelated" } } },
    model: "local/model-a", small_model: "local/model-b",
    enabled_providers: ["local", "local-more"], disabled_providers: ["local"],
    agent: { plan: { model: "local/model-a", temperature: 0.2 }, build: { model: "local-more/model-a" } },
    mode: { legacy: { model: "local/model-b", description: "preserve" } }, unknown: { model: "local/free-text" },
  }, null, 2)}\n`));
  assert.equal(listRemovableProviders().filter((row) => row.app === "opencode" && row.id === "local").length, 1);
  const result = await removeProvider("local", { apps: "opencode" });
  assert.deepEqual(new Set(result.files), new Set(files));
  for (const file of files) {
    const data = parsed(file);
    assert.equal(data.provider.local, undefined);
    assert.equal(data.model, undefined);
    assert.equal(data.small_model, undefined);
    assert.deepEqual(data.enabled_providers, ["local-more"]);
    assert.deepEqual(data.disabled_providers, []);
    assert.deepEqual(data.agent.plan, { temperature: 0.2 });
    assert.equal(data.agent.build.model, "local-more/model-a");
    assert.equal(data.mode.legacy.description, "preserve");
    assert.equal(data.unknown.model, "local/free-text");
    assert.match(fs.readFileSync(file, "utf8"), /preserve comment/);
  }
});

test("OMP removes both named layers, expands aliases and clears only known role references", async () => {
  const active = put(".omp/agent/models.yml", "providers:\n  local: &entry {auth: none}\n  keep: *entry\n");
  const fallback = put(".omp/agent/models.yaml", { providers: { local: {} } });
  const refs = put(".omp/agent/config.yml", {
    model: "local/main", defaultProvider: "local", defaultModel: "main",
    modelRoles: { default: "local/main:max", smol: "local/small:auto", slow: "keep/slow" },
    enabledModels: ["local/main", "keep/main"], unknown: { model: "local/free-text" },
  });
  await removeProvider("local", { apps: "omp" });
  assert.deepEqual(parsed(active).providers, { keep: { auth: "none" } });
  assert.deepEqual(parsed(fallback).providers, {});
  assert.deepEqual(parsed(refs), { modelRoles: { slow: "keep/slow" }, enabledModels: ["keep/main"], unknown: { model: "local/free-text" } });
});

test("prune clears dangling defaults and Prime recent models after routes were hand-deleted", async () => {
  store();
  const settings = put(".prime/agent/settings.json", {
    defaultProvider: provider.id, defaultModel: "model-a", theme: "dark",
    recentModels: [`${provider.id}/model-a`, { provider: provider.id, model: "a" }, "keep/a", { provider: "keep", model: "b" }],
  });
  const omp = put(".omp/agent/config.yml", { modelRoles: { default: `${provider.id}/model-a`, smol: "keep/small" } });
  const opencode = put(".config/opencode/opencode.json", { model: `${provider.id}/model-a`, theme: "dark" });
  await removeProvider(provider.id, { prune: true });
  assert.deepEqual(parsed(settings), { theme: "dark", recentModels: ["keep/a", { provider: "keep", model: "b" }] });
  assert.deepEqual(parsed(omp), { modelRoles: { smol: "keep/small" } });
  assert.deepEqual(parsed(opencode), { theme: "dark" });
});

test("Hermes and DSH keep shared and custom credentials and clear owned selections", async () => {
  const hermes = put(".hermes/config.yaml", {
    providers: { local: { key_env: "CUSTOM_KEY" }, keep: { key_env: "AGENTSW_LOCAL_API_KEY" } },
    model: { provider: "local", default: "a", model: "a", temperature: 0.4 },
  });
  const env = put(".hermes/.env", "CUSTOM_KEY=fixture-custom\nAGENTSW_LOCAL_API_KEY=fixture-shared\n");
  const dsh = put(".dsh/settings.yaml", {
    "llm-pi-ai": { providers: { local: {}, keep: { apiKeyEnv: "AGENTSW_LOCAL_API_KEY" } }, unknown: true },
    "agent-default-model": { provider: "local", model: "a", reasoningEffort: "high" }, approval: { mode: "ask" },
  });
  const creds = put(".dsh/.credentials.yaml", { version: 1, refs: { AGENTSW_LOCAL_API_KEY: "fixture-shared", CUSTOM_KEY: "fixture-custom" } });
  const before = snapshot();
  await removeProvider("local", { apps: "hermes,dsh" });
  assert.deepEqual(parsed(hermes).model, { temperature: 0.4 });
  assert.equal(parsed(dsh)["agent-default-model"], undefined);
  assert.equal(parsed(dsh)["llm-pi-ai"].unknown, true);
  assert.equal(fs.readFileSync(env, "utf8"), before.get(env));
  assert.equal(fs.readFileSync(creds, "utf8"), before.get(creds));
});

test("DSH JSON settings remove an unregistered route and managed credential transactionally", async () => {
  const dsh = put(".dsh/settings.json", { "llm-pi-ai": { providers: { local: {} } }, "agent-default-model": { provider: "local", model: "a" }, approval: { mode: "ask" } });
  const credentials = put(".dsh/.credentials.yaml", "version: 1\nrefs:\n  AGENTSW_LOCAL_API_KEY: fixture-private\n  KEEP: fixture-keep\n");
  const result = await removeProvider("local", { apps: "dsh" });
  assert.deepEqual(new Set(result.files), new Set([dsh, credentials]));
  assert.deepEqual(parsed(dsh), { approval: { mode: "ask" } });
  assert.deepEqual(parsed(credentials), { version: 1, refs: { KEEP: "fixture-keep" } });
});

test("Codex removes local maps and profile selections without touching shared auth", async () => {
  const codex = put(".codex/config.toml", 'model_provider = "local"\nmodel = "a"\nmodel_reasoning_effort = "high"\n[model_providers.local]\nname = "Local"\n[model_providers.keep]\nname = "Keep"\n[profiles.work]\nmodel_provider = "local"\nmodel = "b"\n[profiles.other]\nmodel_provider = "keep"\nmodel = "c"\n');
  const auth = put(".codex/auth.json", { OPENAI_API_KEY: "fixture-shared-auth" });
  const before = fs.readFileSync(auth, "utf8");
  await removeProvider("local", { apps: "codex" });
  const data = parsed(codex);
  assert.equal(data.model_providers.local, undefined);
  assert.equal(data.model_provider, undefined);
  assert.equal(data.model, undefined);
  assert.deepEqual(data.profiles.work, {});
  assert.equal(data.profiles.other.model_provider, "keep");
  assert.equal(fs.readFileSync(auth, "utf8"), before);
});

test("Claude candidate fallback deletes only provider env and accepts custom central IDs", async () => {
  const file = put(".claude/settings.json", { env: { ANTHROPIC_BASE_URL: "https://claude.example", ANTHROPIC_API_KEY: "fixture-claude", ANTHROPIC_MODEL: "a", KEEP: "yes" }, permissions: { keep: true } });
  const local = listRemovableProviders().find((row) => row.app === "claude")!;
  assert.ok(local.id);
  await removeProvider(local.id, { apps: "claude" });
  assert.deepEqual(parsed(file), { env: { KEEP: "yes" }, permissions: { keep: true } });
  put(".claude/settings.json", { env: { ANTHROPIC_BASE_URL: "https://claude.example", ANTHROPIC_AUTH_TOKEN: "fixture-claude", ANTHROPIC_MODEL: "a" } });
  put(".config/agentsw/config.json", { version: 1, providers: { custom: { ...provider, id: "custom", protocol: "anthropic", baseUrl: "https://claude.example/v1", apiKey: "fixture-claude" } } });
  const before = fs.readFileSync(configFile, "utf8");
  await removeProvider("custom", { apps: "claude" });
  assert.deepEqual(parsed(file).env, {});
  assert.equal(fs.readFileSync(configFile, "utf8"), before);
});

test("WorkBuddy preserves unknown data and same-model selection from another account", async () => {
  const file = put(".workbuddy/models.json", {
    models: [
      { id: "a", vendor: "First", url: "https://wb.example/v1/chat/completions", apiKey: "fixture-a" },
      { id: "a", vendor: "Other", url: "https://other.example/v1/chat/completions", apiKey: "fixture-b" }, { unknown: true },
    ], availableModels: ["a", "untouched"], unknown: { keep: true },
  });
  const settings = put(".workbuddy/settings.json", { model: "a", theme: "dark" });
  const row = listRemovableProviders().find((row) => row.app === "workbuddy" && row.name === "First")!;
  await removeProvider(row.id, { apps: "workbuddy" });
  const data = parsed(file);
  assert.equal(data.models.length, 2);
  assert.equal(data.models[0].vendor, "Other");
  assert.deepEqual(data.models[1], { unknown: true });
  assert.deepEqual(data.availableModels, ["a", "untouched"]);
  assert.deepEqual(data.unknown, { keep: true });
  assert.equal(parsed(settings).model, "a");
});

test("dry-run returns only file paths without writes, credentials or backups", async () => {
  store();
  const pi = put(".pi/agent/models.json", { providers: { [provider.id]: {} } });
  const before = snapshot();
  const result = await removeProvider(provider.id, { prune: true, dryRun: true });
  assert.deepEqual(new Set(result.files), new Set([configFile, pi]));
  assert.equal(result.backupDir, undefined);
  assert.doesNotMatch(JSON.stringify(result), /fixture-private-key/);
  assert.deepEqual(snapshot(), before);
  assert.equal(fs.existsSync(backupsDir), false);
  assert.deepEqual(drainPendingWrites(), []);
});

test("unknown IDs, ambiguous scopes and empty scopes cause no unrelated changes", async () => {
  store();
  put(".config/opencode/opencode.json", { provider: {}, theme: "dark" });
  put(".hermes/config.yaml", { providers: {}, model: {} });
  const before = snapshot();
  await assert.rejects(removeProvider("absent"), /not found/);
  await assert.rejects(removeProvider("absent", { apps: "opencode" }), /not found.*selected apps/);
  await assert.rejects(removeProvider("absent", { prune: true }), /not found/);
  await assert.rejects(removeProvider(provider.id, { apps: "pi", prune: true }), /cannot be combined/);
  await assert.rejects(removeProvider(provider.id, { apps: " " }), /at least one app/);
  await assert.rejects(removeProvider(provider.id, { apps: ",," }), /at least one app/);
  await assert.rejects(removeProvider(provider.id, { apps: "unknown" }), /unknown app/);
  assert.deepEqual(snapshot(), before);
  await removeProvider(provider.id, { prune: true });
  for (const [file, text] of before) if (file !== configFile) assert.equal(fs.readFileSync(file, "utf8"), text);
});

for (const [name, invalid] of Object.entries({ syntax: "broken: [\n", shape: "providers: []\n", alias: "providers:\n  local: *missing\n", duplicate: "providers:\n  local: {}\n  local: {}\n" })) {
  test(`malformed YAML ${name} aborts all prune changes`, async () => {
    store();
    put(".pi/agent/models.json", { providers: { [provider.id]: {} } });
    put(".hermes/config.yaml", invalid);
    const before = snapshot();
    await assert.rejects(removeProvider(provider.id, { prune: true }), /invalid configuration|expected.*mapping/);
    assert.deepEqual(snapshot(), before);
    assert.equal(fs.existsSync(backupsDir), false);
  });
}

test("malformed companion settings fail without exposing source text or writing files", async () => {
  store();
  put(".pi/agent/models.json", { providers: { [provider.id]: {} } });
  put(".pi/agent/settings.json", '{"defaultProvider":"fixture-private-key",');
  const before = snapshot();
  await assert.rejects(removeProvider(provider.id, { prune: true }), (error: Error) => {
    assert.doesNotMatch(error.message, /fixture-private-key/);
    return /invalid configuration/.test(error.message);
  });
  assert.deepEqual(snapshot(), before);
});

test("adapter failure after queuing a write resets dry-run state and commits nothing", async () => {
  store();
  const models = put(".pi/agent/models.json", { providers: { [provider.id]: {} } });
  const target = targets.find((target) => target.id === "pi")!;
  const previous = target.prune;
  const before = snapshot();
  target.prune = async () => { writeFileAtomic(models, "{}\n"); throw new Error("fixture-private-key"); };
  try {
    await assert.rejects(removeProvider(provider.id, { prune: true }), (error: Error) => {
      assert.doesNotMatch(error.message, /fixture-private-key/);
      return /unable to prepare/.test(error.message);
    });
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(drainPendingWrites(), []);
    const proof = path.join(sandbox, "dry-run-reset-proof");
    writeFileAtomic(proof, "written\n");
    assert.equal(fs.readFileSync(proof, "utf8"), "written\n");
  } finally { target.prune = previous; }
});

test("identical shared Pi and Prime plans deduplicate instead of conflicting", async () => {
  const dir = path.join(sandbox, "shared-agent");
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.PRIME_AGENT_CODING_AGENT_DIR = dir;
  const file = put("shared-agent/models.json", { providers: { local: {}, keep: {} } });
  const settings = put("shared-agent/settings.json", { defaultProvider: "local", defaultModel: "a" });
  const result = await removeProvider("local", { apps: "pi,prime" });
  assert.deepEqual(new Set(result.files), new Set([file, settings]));
  assert.equal(result.files.length, 2);
  assert.deepEqual(parsed(file).providers, { keep: {} });
});

test("explicit all-app scope removes an app-exclusive provider without creating a store or reading historical sessions", async () => {
  const file = put(".omp/agent/models.yml", { providers: { local: {} } });
  const session = put(".omp/agent/sessions/history.jsonl", '{"providers":{"historical-only":{}}}\n');
  assert.equal(listRemovableProviders().some((row) => row.id === "historical-only"), false);
  const before = fs.readFileSync(session, "utf8");
  await removeProvider("local", { apps: "all" });
  assert.deepEqual(parsed(file).providers, {});
  assert.equal(fs.existsSync(configFile), false);
  assert.equal(fs.readFileSync(session, "utf8"), before);
});

test("raw listing does not require parseable companion credentials or settings", async () => {
  put(".dsh/settings.yaml", { "llm-pi-ai": { providers: { local: {} } } });
  put(".dsh/.credentials.yaml", "broken: [\n");
  put(".pi/agent/models.json", { providers: { local: {} } });
  put(".pi/agent/settings.json", "not json");
  const rows = listRemovableProviders();
  assert.deepEqual(new Set(rows.filter((row) => row.id === "local").map((row) => row.app)), new Set(["pi", "dsh"]));
  const before = snapshot();
  await assert.rejects(removeProvider("local", { apps: "dsh" }), /invalid configuration/);
  await assert.rejects(removeProvider("local", { apps: "pi" }), /invalid configuration/);
  assert.deepEqual(snapshot(), before);
});

test("malformed shared OpenCode JSONC aborts previously planned removals", async () => {
  store();
  put(".pi/agent/models.json", { providers: { [provider.id]: {} } });
  put("opencode-shared.jsonc", '{"provider":{"remove-me":{}},"provider":{}}');
  const before = snapshot();
  await assert.rejects(removeProvider(provider.id, { prune: true }), /invalid configuration/);
  assert.deepEqual(snapshot(), before);
});

test("unknown DSH credential versions are not rewritten", async () => {
  put(".dsh/settings.yaml", { "llm-pi-ai": { providers: { local: {} } } });
  put(".dsh/.credentials.yaml", { version: 2, refs: { AGENTSW_LOCAL_API_KEY: "fixture-private" } });
  const before = snapshot();
  await assert.rejects(removeProvider("local", { apps: "dsh" }), /unsupported credential layout/);
  assert.deepEqual(snapshot(), before);
});

test("conflicting shared-file plans fail rather than silently taking the last write", async () => {
  const dir = path.join(sandbox, "shared-agent");
  process.env.PI_CODING_AGENT_DIR = dir;
  process.env.PRIME_AGENT_CODING_AGENT_DIR = dir;
  const file = put("shared-agent/models.json", { providers: { local: {}, keep: {} } });
  const prime = targets.find((target) => target.id === "prime")!;
  const original = prime.prune;
  prime.prune = async () => {
    writeFileAtomic(file, JSON.stringify({ providers: { keep: {} }, conflicting: true }));
    return { app: "prime", changed: [file], notes: [] };
  };
  const before = snapshot();
  try {
    await assert.rejects(removeProvider("local", { apps: "pi,prime" }), /conflicting removal plans/);
    assert.deepEqual(snapshot(), before);
    assert.deepEqual(drainPendingWrites(), []);
  } finally { prime.prune = original; }
});

test("global prune never broadens a missing central ID into arbitrary local accounts", async () => {
  put(".omp/agent/models.yml", { providers: { local: { baseUrl: "https://one.example/v1" } } });
  put(".prime/agent/models.json", { providers: { local: { baseUrl: "https://two.example/v1" } } });
  const before = snapshot();
  await assert.rejects(removeProvider("local", { prune: true }), /not found in agentsw store/);
  assert.deepEqual(snapshot(), before);
});

test("scoped listing ignores malformed store and other-agent configurations", () => {
  put(".config/agentsw/config.json", "broken");
  put(".omp/agent/models.yml", "broken: [");
  put(".prime/agent/models.json", { providers: { local: {} } });
  assert.deepEqual(listRemovableProviders("prime"), [{ id: "local", app: "prime" }]);
});

test("Hermes credential removal preserves lookalike assignment lines inside other multiline values", async () => {
  put(".hermes/config.yaml", { providers: { local: { key_env: "AGENTSW_LOCAL_API_KEY" } } });
  const kept = 'OTHER="first\nAGENTSW_LOCAL_API_KEY=part-of-value\nlast"\n';
  const env = put(".hermes/.env", kept + ' export AGENTSW_LOCAL_API_KEY="fixture-key" # managed\n');
  await removeProvider("local", { apps: "hermes" });
  assert.equal(fs.readFileSync(env, "utf8"), kept);
});

test("global Hermes removal resolves quoted dotenv credentials consistently", async () => {
  store();
  put(".hermes/config.yaml", { providers: { [provider.id]: { api: provider.baseUrl, transport: "codex_responses", key_env: "AGENTSW_REMOVE_ME_API_KEY" } } });
  const env = put(".hermes/.env", 'export AGENTSW_REMOVE_ME_API_KEY="fixture-private-key" # managed\n');
  await removeProvider(provider.id, { prune: true });
  assert.equal(fs.readFileSync(env, "utf8"), "");
});

test("OpenCode removal clears command model references without deleting the command", async () => {
  const file = put(".config/opencode/opencode.json", { provider: { local: {} }, command: { custom: { model: "local/model-a", template: "keep this" } } });
  await removeProvider("local", { apps: "opencode" });
  assert.deepEqual(parsed(file).command.custom, { template: "keep this" });
});

test("WorkBuddy account-qualified listing removes the selected account, never the first endpoint match", async () => {
  const file = put(".workbuddy/models.json", { models: [
    { id: "shared", vendor: "First", url: "https://wb.example/v1/chat/completions?tenant=fixture", apiKey: "fixture-first" },
    { id: "shared", vendor: "Second", url: "https://wb.example/v1/chat/completions?tenant=fixture", apiKey: "fixture-second" },
  ], availableModels: ["shared"] });
  const settings = put(".workbuddy/settings.json", { model: "shared", custom: true });
  const rows = listRemovableProviders("workbuddy");
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((row) => row.id)).size, 2);
  assert.doesNotMatch(JSON.stringify(rows), /fixture-first|fixture-second|https:/);
  const candidates = targets.find((target) => target.id === "workbuddy")!.candidates!();
  assert.equal(candidates[0]!.id, candidates[1]!.id);
  const before = snapshot();
  for (const dryRun of [true, false]) {
    await assert.rejects(removeProvider(candidates[0]!.id, { apps: "workbuddy", dryRun }), /ambiguous/);
    assert.deepEqual(snapshot(), before);
  }
  const selected = rows.find((row) => row.name === "Second")!;
  await removeProvider(selected.id, { apps: "workbuddy", dryRun: true });
  assert.deepEqual(snapshot(), before);
  await removeProvider(selected.id, { apps: "workbuddy" });
  assert.deepEqual(parsed(file).models.map((row: { vendor: string }) => row.vendor), ["First"]);
  assert.deepEqual(parsed(file).availableModels, ["shared"]);
  assert.equal(parsed(settings).model, "shared");
});

test("WorkBuddy keyless removal preserves empty-string and authenticated accounts", async () => {
  const file = put(".workbuddy/models.json", [
    { id: "keyless", vendor: "Keyless", url: "https://wb.example/v1/chat/completions" },
    { id: "empty", vendor: "Empty", url: "https://wb.example/v1/chat/completions", apiKey: "" },
    { id: "private", vendor: "Private", url: "https://wb.example/v1/chat/completions", apiKey: "fixture-private" },
  ]);
  const rows = listRemovableProviders("workbuddy");
  assert.equal(rows.length, 3);
  await removeProvider(rows.find((row) => row.name === "Keyless")!.id, { apps: "workbuddy" });
  assert.deepEqual(parsed(file).map((row: { id: string }) => row.id), ["empty", "private"]);
});

test("WorkBuddy legacy IDs remain removable only when unambiguous", async () => {
  const file = put(".workbuddy/models.json", [{ id: "a", vendor: "Only", url: "https://wb.example/v1/chat/completions" }]);
  const candidate = targets.find((target) => target.id === "workbuddy")!.candidates!()[0]!;
  assert.equal(candidate.localId, localProviderId(candidate));
  await removeProvider(candidate.id, { apps: "workbuddy" });
  assert.deepEqual(parsed(file), []);
});

test("WorkBuddy global prune selects the store account from colliding legacy IDs", async () => {
  const file = put(".workbuddy/models.json", [
    { id: "a", vendor: "First", url: "https://wb.example/v1/chat/completions", apiKey: "fixture-first" },
    { id: "b", vendor: "Second", url: "https://wb.example/v1/chat/completions", apiKey: "fixture-second" },
  ]);
  const candidate = targets.find((target) => target.id === "workbuddy")!.candidates!().find((row) => row.name === "Second")!;
  put(".config/agentsw/config.json", { version: 1, providers: { [candidate.id]: {
    ...provider, id: candidate.id, baseUrl: candidate.baseUrl, apiKey: candidate.apiKey,
  } } });
  await removeProvider(candidate.id, { prune: true });
  assert.deepEqual(parsed(file).map((row: { vendor: string }) => row.vendor), ["First"]);
});

for (const credential of ["auth", "env"] as const) test(`Codex global prune rejects a different ${credential} account before every write`, async () => {
  store();
  put(".pi/agent/models.json", { providers: { [provider.id]: {} } });
  put(".codex/config.toml", `model_provider = "${provider.id}"\nmodel = "a"\n[model_providers.${provider.id}]\nbase_url = "${provider.baseUrl}"\nrequires_openai_auth = true\n${credential === "env" ? 'env_key = "FIXTURE_CODEX_KEY"\n' : ""}`);
  put(".codex/auth.json", { OPENAI_API_KEY: credential === "auth" ? "fixture-other-account" : provider.apiKey });
  if (credential === "env") process.env.FIXTURE_CODEX_KEY = "fixture-other-account";
  const before = snapshot();
  for (const dryRun of [true, false]) {
    await assert.rejects(removeProvider(provider.id, { prune: true, dryRun }), /different credential/);
    assert.deepEqual(snapshot(), before);
  }
  assert.equal(fs.existsSync(backupsDir), false);
});

test("Codex global prune retains matching shared auth and does not attribute inactive auth", async () => {
  store();
  const config = put(".codex/config.toml", `model_provider = "${provider.id}"\n[model_providers.${provider.id}]\nbase_url = "${provider.baseUrl}"\nrequires_openai_auth = true\n`);
  const auth = put(".codex/auth.json", { OPENAI_API_KEY: provider.apiKey, tokens: { keep: true } });
  const authBefore = fs.readFileSync(auth, "utf8");
  await removeProvider(provider.id, { prune: true });
  assert.equal(fs.readFileSync(auth, "utf8"), authBefore);
  assert.equal(parsed(config).model_provider, undefined);
  store();
  put(".codex/config.toml", `model_provider = "other"\n[model_providers.${provider.id}]\nbase_url = "${provider.baseUrl}"\nrequires_openai_auth = true\n`);
  put(".codex/auth.json", { OPENAI_API_KEY: "fixture-other-account" });
  await removeProvider(provider.id, { prune: true });
  assert.equal(parsed(auth).OPENAI_API_KEY, "fixture-other-account");
});

for (const refFor of [managedCredentialRef, legacyManagedCredentialRef]) test(`removal recognizes ${refFor.name} and preserves colliding or custom credential users`, async () => {
  const ref = refFor("foo-bar");
  const otherRef = refFor("foo_bar");
  put(".hermes/config.yaml", { providers: { "foo-bar": { key_env: ref }, foo_bar: { key_env: otherRef } } });
  const env = put(".hermes/.env", `${ref}=fixture-one\n${ref === otherRef ? "" : `${otherRef}=fixture-two\n`}`);
  await removeProvider("foo-bar", { apps: "hermes" });
  assert.equal(fs.readFileSync(env, "utf8"), `${otherRef}=${ref === otherRef ? "fixture-one" : "fixture-two"}\n`);
});

test("custom credential routes retain unrelated generated secrets", async () => {
  const ref = managedCredentialRef("local");
  put(".hermes/config.yaml", { providers: { local: { key_env: "CUSTOM_KEY" } } });
  const env = put(".hermes/.env", `CUSTOM_KEY=fixture-custom\n${ref}=fixture-other\n`);
  put(".dsh/settings.yaml", { "llm-pi-ai": { providers: { local: { apiKeyEnv: "CUSTOM_KEY" } } } });
  const credentials = put(".dsh/.credentials.yaml", { version: 1, refs: { CUSTOM_KEY: "fixture-custom", [ref]: "fixture-other" } });
  const before = snapshot();
  await removeProvider("local", { apps: "hermes,dsh" });
  assert.equal(fs.readFileSync(env, "utf8"), before.get(env));
  assert.equal(fs.readFileSync(credentials, "utf8"), before.get(credentials));
});

test("WorkBuddy global prune rejects a changed account carrying the central ownership marker", async () => {
  store();
  put(".workbuddy/models.json", [{ id: "model-a", agentswProviderId: provider.id, vendor: "Custom label", url: `${provider.baseUrl}/chat/completions`, apiKey: "fixture-other-account" }]);
  const before = snapshot();
  for (const dryRun of [true, false]) {
    await assert.rejects(removeProvider(provider.id, { prune: true, dryRun }), /different credential/);
    assert.deepEqual(snapshot(), before);
  }
});

test("DSH removes canonical locally owned refs without deleting external refs", async () => {
  const ref = managedCredentialRef("local");
  put(".dsh/settings.yaml", { "llm-pi-ai": { providers: { local: { apiKeyEnv: ref } } } });
  const credentials = put(".dsh/.credentials.yaml", { version: 1, refs: { [ref]: "fixture-private", CUSTOM_KEY: "fixture-external" } });
  await removeProvider("local", { apps: "dsh" });
  assert.deepEqual(parsed(credentials).refs, { CUSTOM_KEY: "fixture-external" });
});
