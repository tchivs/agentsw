import { after, beforeEach, test, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { isManagedCredentialRef, legacyManagedCredentialRef, managedCredentialRef } from "../src/provider-identity.js";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agentsw-rename-"));
const envNames = ["HOME", "AGENTSW_HOME", "PI_CODING_AGENT_DIR", "PRIME_AGENT_CODING_AGENT_DIR", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG", "HERMES_HOME", "DSH_HOME", "WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR", "UPPERCASE_LITERAL_KEY", "FIXTURE_LOOKUP_KEY", "MY_EXTERNAL_KEY", "CUSTOM_KEY", ...Object.keys(process.env).filter((key) => key.startsWith("AGENTSW_")), managedCredentialRef("OldID"), managedCredentialRef("api-example-openai"), legacyManagedCredentialRef("OldID"), legacyManagedCredentialRef("api-example-openai")];
const originalEnv = new Map(envNames.map((key) => [key, process.env[key]]));
for (const key of envNames) delete process.env[key];
process.env.HOME = sandbox;
process.env.AGENTSW_HOME = sandbox;
process.env.WORKBUDDY_CONFIG_DIR = path.join(sandbox, ".workbuddy");
// Adapters capture home at module load, so load after installing sandbox overrides.
const { renameProvider } = await import("../src/rename.js");
const { commitFileChanges } = await import("../src/config-transaction.js");
const { configFile } = await import("../src/store.js");
const { backupsDir } = await import("../src/fsutil.js");

const oldId = "OldID";
const newId = "api-example-openai";
const oldKey = managedCredentialRef(oldId);
const newKey = managedCredentialRef(newId);
const provider = {
  id: oldId, name: oldId, protocol: "openai", openaiApi: "responses",
  baseUrl: "https://api.example/v1", apiKey: "test-key", defaultModel: "m-a",
  smallModel: "m-b", reasoningEffort: "high", modelsDevId: "openai",
  models: [{ id: "m-a", name: "Model A", contextWindow: 123456, custom: { retain: true } }, { id: "m-b" }],
  custom: { note: oldId }, modelFilter: { include: ["m-*"] },
};
const file = (...segments: string[]) => path.join(sandbox, ...segments);
function write(name: string, content: string): string {
  const target = path.isAbsolute(name) ? name : file(name);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
  return target;
}
const text = (name: string) => fs.readFileSync(path.isAbsolute(name) ? name : file(name), "utf8");
const json = (name: string) => parseJsonc(text(name));
const yaml = (name: string) => YAML.parse(text(name));
function seedStore(extra: Record<string, unknown> = {}, name = oldId): void {
  write(configFile, JSON.stringify({ version: 1, active: oldId, language: "zh-CN", custom: { id: oldId }, providers: { [oldId]: { ...provider, name }, ...extra } }, null, 2) + "\n");
}
function tree(dir = sandbox): Record<string, string> {
  const output: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const location = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(output, tree(location));
    else output[path.relative(sandbox, location)] = fs.readFileSync(location, "utf8");
  }
  return output;
}

beforeEach(() => {
  mock.restoreAll();
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(sandbox);
  for (const key of envNames) delete process.env[key];
  process.env.HOME = sandbox;
  process.env.AGENTSW_HOME = sandbox;
  process.env.WORKBUDDY_CONFIG_DIR = path.join(sandbox, ".workbuddy");
  seedStore();
});
after(() => {
  mock.restoreAll();
  fs.rmSync(sandbox, { recursive: true, force: true });
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("rename preserves complete data and selections across all adapter schemas", async () => {
  write(".codex/config.toml", `model_provider = "${oldId}"\nmodel = "m-a"\nmodel_reasoning_effort = "high"\n[profiles.review]\nmodel_provider = "${oldId}"\nmodel = "m-b"\n[model_providers.${oldId}]\nname = "${oldId}"\nbase_url = "https://api.example/v1"\nwire_api = "responses"\ncustom_option = true\n`);
  write(".codex/auth.json", '{"OPENAI_API_KEY":"test-key","custom":"keep"}\n');
  write(".omp/agent/models.yml", `# preserve document comment\nproviders:\n  # preserve key comment\n  ${oldId}: &provider\n    name: ${oldId}\n    api: openai-responses\n    baseUrl: https://api.example/v1\n    apiKey: test-key\n    headers: &headers {x-custom: keep}\n    models:\n      - id: m-a\n        compat: {keep: true}\n  other:\n    headers: *headers # preserve alias comment\nmetadata: *provider\n`);
  write(".omp/agent/config.yml", `model: ${oldId}/m-a:max\nmodelRoles:\n  advisor: ${oldId}/m-b:auto\n  vision: ${oldId}/vendor/model\n  smol: another/m\nnotes: ${oldId}/m-a\n`);
  for (const dir of [".pi/agent", ".prime/agent"]) {
    write(`${dir}/models.json`, `\uFEFF{\r\n  // provider comment\r\n  "providers": {"${oldId}": {"name":"${oldId}","api":"openai-responses","baseUrl":"https://api.example/v1","apiKey":"test-key",/* custom */"headers":{"x-user":"${oldId}"},"models":[{"id":"m-a","custom":42}],},},\r\n}\r\n`);
    write(`${dir}/settings.json`, `{"defaultProvider":"${oldId}","defaultModel":"m-a","thinkingLevel":"high","recentModels":["${oldId}/m-b:max",{"provider":"${oldId}","modelId":"m-a"},"other/m"],"note":"${oldId}"}\n`);
  }
  write(".config/opencode/opencode.json", JSON.stringify({ provider: { [oldId]: { name: oldId, npm: "@ai-sdk/openai", options: { baseURL: provider.baseUrl, apiKey: provider.apiKey, custom: true }, models: { "m-a": { limit: { context: 123456 }, custom: "stay" } } } }, model: `${oldId}/m-a`, small_model: `${oldId}/m-b`, agent: { review: { model: `${oldId}/m-b`, prompt: `${oldId}/do-not-edit` } }, mode: { plan: { model: `${oldId}/m-a` } }, command: { check: { model: `${oldId}/vendor/model` } }, enabled_providers: [oldId], disabled_providers: ["other"], note: oldId }));
  write(".hermes/config.yaml", `# Hermes comment\nproviders:\n  ${oldId}:\n    name: ${oldId}\n    api: https://api.example/v1\n    key_env: ${oldKey}\n    transport: codex_responses\n    default_model: m-b\n    options: {keep: true}\nmodel: {provider: ${oldId}, default: m-a, reasoning: high}\n`);
  write(".hermes/.env", `# Keep ${oldKey} in comments\nexport ${oldKey} = "test-key" # retain comment\nOTHER="first\n${oldKey}=inside-a-value\nlast"\n`);
  write(".dsh/settings.yaml", `llm-pi-ai:\n  providers:\n    ${oldId}:\n      displayName: ${oldId}\n      api: openai-responses\n      baseURL: https://api.example/v1\n      apiKeyEnv: ${oldKey}\n      retryPolicy: {attempts: 7}\n      models: [{id: m-a, custom: true}]\nagent-default-model: {provider: ${oldId}, model: m-b, reasoningEffort: high}\n`);
  write(".dsh/.credentials.yaml", `# credential comment\nversion: 1\nrefs:\n  ${oldKey}: &key test-key\n  SHARED: *key\n`);
  write(".workbuddy/models.json", JSON.stringify({ models: [{ id: "m-a", vendor: oldId, url: "https://api.example/v1/chat/completions", apiKey: provider.apiKey, custom: true }, { id: "m-b", vendor: oldId, url: "https://other.example/v1/chat/completions", apiKey: "another-key" }], availableModels: ["m-a", "m-b"], metadata: { note: oldId } }));
  write(".workbuddy/settings.json", '{"model":"m-a","custom":true}\n');
  write(".claude/settings.json", `{"env":{"ANTHROPIC_MODEL":"${oldId}"}}\n`);
  const before = tree();
  const result = await renameProvider(oldId, newId);
  assert.ok(result.backupDir);
  const store = json(configFile);
  assert.deepEqual(store.providers[newId], { ...provider, id: newId, name: newId });
  assert.equal(store.providers[oldId], undefined);
  assert.equal(store.active, newId);
  assert.deepEqual(store.custom, { id: oldId });
  assert.equal(store.language, "zh-CN");
  const codex = parseToml(text(".codex/config.toml")) as any;
  assert.equal(codex.model_provider, newId);
  assert.equal(codex.model, "m-a");
  assert.equal(codex.profiles.review.model_provider, newId);
  assert.equal(codex.profiles.review.model, "m-b");
  assert.equal(codex.model_providers[newId].custom_option, true);
  const omp = yaml(".omp/agent/models.yml");
  assert.equal(omp.providers[newId].name, newId);
  assert.deepEqual(omp.providers.other.headers, { "x-custom": "keep" });
  assert.equal(omp.providers[newId].models[0].compat.keep, true);
  assert.equal(omp.metadata, omp.providers[newId]);
  assert.match(text(".omp/agent/models.yml"), /# preserve key comment/);
  assert.match(text(".omp/agent/models.yml"), /&provider/);
  assert.match(text(".omp/agent/models.yml"), /\*headers/);
  const roles = yaml(".omp/agent/config.yml");
  assert.equal(roles.model, `${newId}/m-a:max`);
  assert.deepEqual(roles.modelRoles, { advisor: `${newId}/m-b:auto`, vision: `${newId}/vendor/model`, smol: "another/m" });
  assert.equal(roles.notes, `${oldId}/m-a`);
  for (const dir of [".pi/agent", ".prime/agent"]) {
    const modelsText = text(`${dir}/models.json`);
    const models = parseJsonc(modelsText.slice(1));
    assert.equal(models.providers[newId].models[0].custom, 42);
    assert.equal(models.providers[newId].headers["x-user"], oldId);
    assert.match(modelsText, /\/\/ provider comment\r\n/);
    assert.match(modelsText, /\/\* custom \*\//);
    const settings = json(`${dir}/settings.json`);
    assert.equal(settings.defaultProvider, newId);
    assert.equal(settings.defaultModel, "m-a");
    assert.deepEqual(settings.recentModels, [`${newId}/m-b:max`, { provider: newId, modelId: "m-a" }, "other/m"]);
    assert.equal(settings.note, oldId);
  }
  const oc = json(".config/opencode/opencode.json");
  assert.equal(oc.provider[newId].options.custom, true);
  assert.equal(oc.provider[newId].models["m-a"].custom, "stay");
  assert.equal(oc.agent.review.model, `${newId}/m-b`);
  assert.equal(oc.agent.review.prompt, `${oldId}/do-not-edit`);
  assert.equal(oc.command.check.model, `${newId}/vendor/model`);
  assert.deepEqual(oc.enabled_providers, [newId]);
  assert.equal(yaml(".hermes/config.yaml").providers[newId].key_env, newKey);
  assert.equal(yaml(".hermes/config.yaml").providers[newId].default_model, "m-b");
  assert.equal(yaml(".hermes/config.yaml").model.default, "m-a");
  assert.match(text(".hermes/.env"), new RegExp(`export ${newKey} = "test-key" # retain comment`));
  assert.match(text(".hermes/.env"), new RegExp(`${oldKey}=inside-a-value`));
  const dsh = yaml(".dsh/settings.yaml");
  assert.equal(dsh["llm-pi-ai"].providers[newId].apiKeyEnv, newKey);
  assert.deepEqual(dsh["agent-default-model"], { provider: newId, model: "m-b", reasoningEffort: "high" });
  assert.equal(yaml(".dsh/.credentials.yaml").refs[newKey], provider.apiKey);
  assert.equal(yaml(".dsh/.credentials.yaml").refs.SHARED, provider.apiKey);
  assert.match(text(".dsh/.credentials.yaml"), /&key/);
  const wb = json(".workbuddy/models.json");
  assert.equal(wb.models[0].vendor, newId);
  assert.equal(wb.models[0].custom, true);
  assert.equal(wb.models[1].vendor, oldId);
  assert.deepEqual(wb.availableModels, ["m-a", "m-b"]);
  for (const untouched of [".codex/auth.json", ".workbuddy/settings.json", ".claude/settings.json"]) assert.equal(text(untouched), before[path.normalize(untouched)]);
  const manifest = JSON.parse(text(path.join(result.backupDir!, "manifest.json")));
  assert.equal(manifest.length, result.files.length);
  for (const entry of manifest) assert.equal(text(path.join(result.backupDir!, entry.backup)), before[path.relative(sandbox, entry.file)]);
});

test("rename uses environment overrides and migrates both global and shared OpenCode layers", async () => {
  process.env.PI_CODING_AGENT_DIR = "~/portable/pi";
  process.env.PRIME_AGENT_CODING_AGENT_DIR = file("portable/prime");
  process.env.HERMES_HOME = file("portable/hermes");
  process.env.DSH_HOME = "~/portable/dsh";
  process.env.WORKBUDDY_CONFIG_DIR = file("portable/workbuddy");
  process.env.OPENCODE_CONFIG_DIR = file("portable/opencode");
  process.env.OPENCODE_CONFIG = file("shared.jsonc");
  const paths = [".config/opencode/config.json", ".config/opencode/opencode.json", ".config/opencode/opencode.jsonc", "portable/opencode/opencode.json", "portable/opencode/opencode.jsonc", "shared.jsonc"];
  for (const name of paths) write(name, `{// retained\n"provider":{"${oldId}":{"name":"A custom label","options":{"extra":17}}},"model":"${oldId}/model"}\n`);
  for (const dir of ["portable/pi", "portable/prime"]) write(`${dir}/models.json`, `{"providers":{"${oldId}":{"name":"Custom","headers":{"keep":true}}}}`);
  write("portable/hermes/config.yaml", `providers: {${oldId}: {name: Custom}}\n`);
  write("portable/dsh/settings.json", `{"llm-pi-ai":{"providers":{"${oldId}":{"displayName":"Custom"}}},"agent-default-model":{"provider":"${oldId}","model":"m-a"}}`);
  write("portable/workbuddy/models.json", JSON.stringify([{ id: "m-a", vendor: oldId, url: "https://api.example/v1/chat/completions", apiKey: provider.apiKey }]));
  await renameProvider(oldId, newId);
  for (const name of paths) {
    assert.equal(json(name).model, `${newId}/model`);
    assert.equal(json(name).provider[newId].name, "A custom label");
    assert.match(text(name), /\/\/ retained/);
  }
  assert.equal(json("portable/pi/models.json").providers[newId].name, "Custom");
  assert.equal(json("portable/prime/models.json").providers[newId].name, "Custom");
  assert.equal(yaml("portable/hermes/config.yaml").providers[newId].name, "Custom");
  assert.equal(json("portable/dsh/settings.json")["agent-default-model"].provider, newId);
  assert.equal(json("portable/workbuddy/models.json")[0].vendor, newId);
  assert.equal(fs.existsSync(file(".pi")), false);
  assert.equal(fs.existsSync(file(".hermes")), false);
});

test("custom display names and unrelated model identifiers remain unchanged", async () => {
  seedStore({}, "Hand-picked Name");
  write(".pi/agent/models.json", `{"providers":{"${oldId}":{"name":"Custom","models":[{"id":"${oldId}","name":"${oldId}"}]}}}`);
  write(".pi/agent/settings.json", `{"defaultProvider":"another","defaultModel":"${oldId}"}`);
  write(".workbuddy/models.json", JSON.stringify([{ id: "m-a", vendor: "Hand-picked Name", url: "https://api.example/v1/chat/completions", apiKey: provider.apiKey }]));
  const wbBefore = text(".workbuddy/models.json");
  await renameProvider(oldId, newId);
  assert.equal(json(configFile).providers[newId].name, "Hand-picked Name");
  assert.deepEqual(json(".pi/agent/models.json").providers[newId].models, [{ id: oldId, name: oldId }]);
  assert.equal(json(".pi/agent/settings.json").defaultModel, oldId);
  assert.equal(text(".workbuddy/models.json"), wbBefore);
});

test("YAML fallback and aliased provider maps preserve reference semantics", async () => {
  write(".omp/agent/models.yaml", `defaults: &all\n  ${oldId}: {name: Custom, models: [{id: m-a}]}\nproviders: *all # preserve alias comment\n`);
  write(".omp/agent/config.yaml", `selected: &selected ${oldId}/m-a:auto\nmodelRoles: {advisor: *selected}\n`);
  await renameProvider(oldId, newId);
  const models = yaml(".omp/agent/models.yaml");
  assert.equal(models.providers[newId].name, "Custom");
  assert.equal(models.defaults[oldId].name, "Custom");
  assert.equal(yaml(".omp/agent/config.yaml").selected, `${oldId}/m-a:auto`);
  assert.equal(yaml(".omp/agent/config.yaml").modelRoles.advisor, `${newId}/m-a:auto`);
  assert.match(text(".omp/agent/models.yaml"), /# preserve alias comment/);
  assert.equal(fs.existsSync(file(".omp/agent/models.yml")), false);
});

test("shared local credential references remain intact during rename", async () => {
  const legacyKey = legacyManagedCredentialRef(oldId);
  write(".dsh/.credentials.yaml", `${legacyKey}: test-key\nUNRELATED: keep\n`);
  write(".dsh/settings.yml", `llm-pi-ai:\n  providers:\n    ${oldId}: {apiKeyEnv: ${legacyKey}}\n    shared: {apiKeyEnv: ${legacyKey}}\n`);
  const before = text(".dsh/.credentials.yaml");
  await renameProvider(oldId, newId);
  assert.equal(text(".dsh/.credentials.yaml"), before);
  assert.equal(yaml(".dsh/settings.yml")["llm-pi-ai"].providers.shared.apiKeyEnv, legacyKey);
  assert.equal(yaml(".dsh/settings.yml")["llm-pi-ai"].providers[newId].apiKeyEnv, legacyKey);
});

test("external-only and custom credential references are retained without creating secrets", async () => {
  process.env[oldKey] = provider.apiKey;
  write(".hermes/config.yaml", `providers:\n  ${oldId}: {key_env: ${oldKey}}\n  custom: {key_env: MY_EXTERNAL_KEY}\nmodel: {provider: ${oldId}, default: m-a}\n`);
  write(".dsh/settings.yaml", `llm-pi-ai:\n  providers:\n    ${oldId}: {apiKeyEnv: ${oldKey}}\n`);
  await renameProvider(oldId, newId);
  assert.equal(yaml(".hermes/config.yaml").providers[newId].key_env, oldKey);
  assert.equal(yaml(".hermes/config.yaml").providers.custom.key_env, "MY_EXTERNAL_KEY");
  assert.equal(yaml(".dsh/settings.yaml")["llm-pi-ai"].providers[newId].apiKeyEnv, oldKey);
  assert.equal(process.env[oldKey], provider.apiKey);
  assert.equal(process.env[newKey], undefined);
  assert.equal(fs.existsSync(file(".hermes/.env")), false);
  assert.equal(fs.existsSync(file(".dsh/.credentials.yaml")), false);
});

test("dry-run and no-op rename do not create files, backups or directories", async () => {
  const before = tree();
  const preview = await renameProvider(oldId, newId, { dryRun: true });
  assert.deepEqual(preview.files, [configFile]);
  assert.equal(preview.backupDir, undefined);
  assert.deepEqual(tree(), before);
  await renameProvider(oldId, newId);
  const after = tree();
  assert.deepEqual(await renameProvider(newId, newId), { files: [] });
  assert.deepEqual(tree(), after);
  assert.equal(fs.existsSync(file(".codex")), false);
  assert.equal(fs.existsSync(file(".workbuddy")), false);
});

test("invalid destination slugs and store collisions reject without writes", async () => {
  for (const id of ["", "UPPER", "../escape", "-prefix", "has.dot", "contains space"]) {
    const before = tree();
    await assert.rejects(renameProvider(oldId, id), /lowercase slug/);
    assert.deepEqual(tree(), before);
  }
  seedStore({ [newId]: { ...provider, id: newId } });
  const before = tree();
  await assert.rejects(renameProvider(oldId, newId), /destination provider ID/);
  assert.deepEqual(tree(), before);
});

for (const [name, contents] of [
  [".codex/config.toml", 'model_provider = "unterminated'],
  [".omp/agent/models.yml", `providers: {${oldId}: {apiKey: private-marker, models: [}}`],
  [".omp/agent/models.yml", `providers: {${oldId}: *missing}`],
  [".omp/agent/models.yml", `providers: {${oldId}: &cycle {value: *cycle}}`],
  [".pi/agent/settings.json", '{"defaultProvider":"private-marker",'],
  [".prime/agent/models.json", `{"providers":{"${oldId}":{},"${oldId}":{}}}`],
  [".config/opencode/opencode.json", '{"provider":[] }'],
  [".hermes/.env", `${oldKey}="private-marker`],
  [".dsh/.credentials.yaml", 'version: 2\nrefs: {}\n'],
  [".workbuddy/models.json", '{"models":{}}'],
] as const) test(`malformed ${name} aborts the complete plan without backups`, async () => {
  write(".pi/agent/models.json", `{"providers":{"${oldId}":{}}}`);
  write(name, contents);
  const before = tree();
  await assert.rejects(renameProvider(oldId, newId), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(error.message.includes(name.split("/").at(-1)!));
    assert.equal(error.message.includes("private-marker"), false);
    return true;
  });
  assert.deepEqual(tree(), before);
  assert.equal(fs.existsSync(backupsDir), false);
});

for (const [name, contents] of [
  [".codex/config.toml", `[model_providers.${newId}]\nname = "existing"\n`],
  [".omp/agent/models.yml", `providers: {${newId}: {}}\n`],
  [".prime/agent/models.json", `{"providers":{"${newId}":{}}}`],
  [".config/opencode/opencode.jsonc", `{"provider":{"${newId}":{}}}`],
  [".hermes/config.yaml", `providers: {${newId}: {}}\n`],
  [".hermes/.env", `${oldKey}=test-key\n${newKey}=test-key\n`],
  [".dsh/.credentials.yaml", `version: 1\nrefs: {${oldKey}: test-key, ${newKey}: test-key}\n`],
  [".dsh/settings.json", `{"llm-pi-ai":{"providers":{"${newId}":{}}}}`],
] as const) test(`destination collision in ${name} aborts every file`, async () => {
  write(name, contents);
  const before = tree();
  await assert.rejects(renameProvider(oldId, newId), /destination/);
  assert.deepEqual(tree(), before);
  assert.equal(fs.existsSync(backupsDir), false);
});

for (const entry of [
  { baseUrl: "https://different.example/v1" },
  { baseUrl: "https://api.example:443/v1" },
  { baseUrl: "https://api.example/V1" },
  { api: "anthropic-messages" },
  { apiKey: "different-account-private-marker" },
]) test(`same ID with a different connection rejects instead of stealing an app entry (${Object.keys(entry)[0]})`, async () => {
  write(".pi/agent/models.json", JSON.stringify({ providers: { [oldId]: entry } }));
  const before = tree();
  await assert.rejects(renameProvider(oldId, newId), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /conflicts? with the store/);
    assert.equal(error.message.includes("private-marker"), false);
    return true;
  });
  assert.deepEqual(tree(), before);
});

test("inherited destination credentials and conflicting local credentials prevent rename", async () => {
  write(".hermes/.env", `${oldKey}=test-key\n`);
  process.env[newKey] = "other-account";
  const before = tree();
  await assert.rejects(renameProvider(oldId, newId), /destination credential/);
  assert.deepEqual(tree(), before);
  delete process.env[newKey];
  write(".hermes/config.yaml", `providers: {${oldId}: {key_env: ${oldKey}}}\n`);
  write(".hermes/.env", `${oldKey}=other-account\n`);
  const conflicted = tree();
  await assert.rejects(renameProvider(oldId, newId), /credentials conflict/);
  assert.deepEqual(tree(), conflicted);
});

test("transaction validates stale and duplicate plans before backups, including no-op plans", () => {
  const target = write("transaction/config.json", "original");
  const before = tree();
  assert.throws(() => commitFileChanges([{ file: target, before: "stale", after: "next" }]), /changed since/);
  assert.throws(() => commitFileChanges([{ file: target, before: "original", after: "original" }, { file: path.join(path.dirname(target), ".", "config.json"), before: "original", after: "next" }]), /duplicate/);
  assert.deepEqual(tree(), before);
  assert.deepEqual(commitFileChanges([{ file: target, before: "original", after: "original" }]), { files: [] });
  assert.equal(fs.existsSync(backupsDir), false);
});

test("transaction dry-run previews creation and deletion without writing", () => {
  const target = write("transaction/config.json", "original");
  const created = file("absent/nested/config.json");
  const before = tree();
  assert.deepEqual(commitFileChanges([{ file: target, before: "original", after: undefined }, { file: created, before: undefined, after: "new" }], { dryRun: true }), { files: [target, created] });
  assert.deepEqual(tree(), before);
  assert.equal(fs.existsSync(file("absent")), false);
});

test("transactions back up same-basename originals uniquely and privately before any write", () => {
  const first = write("first/config.json", "first-original");
  const second = write("second/config.json", "second-original");
  fs.chmodSync(first, 0o640);
  const renameSync = fs.renameSync;
  mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    const directories = fs.readdirSync(backupsDir);
    const dir = path.join(backupsDir, directories.at(-1)!);
    const backups = fs.readdirSync(dir).filter((name) => name !== "manifest.json");
    assert.equal(backups.length, 2);
    return renameSync(from, to);
  });
  const result = commitFileChanges([{ file: first, before: "first-original", after: "first-next" }, { file: second, before: "second-original", after: "second-next" }]);
  mock.restoreAll();
  assert.equal(text(first), "first-next");
  assert.equal(text(second), "second-next");
  const secondResult = commitFileChanges([{ file: first, before: "first-next", after: "third" }]);
  assert.notEqual(result.backupDir, secondResult.backupDir);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(first).mode & 0o777, 0o640);
    assert.equal(fs.statSync(result.backupDir!).mode & 0o777, 0o700);
    for (const name of fs.readdirSync(result.backupDir!)) assert.equal(fs.statSync(path.join(result.backupDir!, name)).mode & 0o777, 0o600);
  }
});

test("transaction rollback restores modified and deleted files and removes newly created files", () => {
  const first = write("first.json", "first-original");
  const removed = write("removed.json", "removed-original");
  const created = file("created/nested/config.json");
  const failing = write("last.json", "last-original");
  const renameSync = fs.renameSync;
  let failed = false;
  mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (!failed && String(to) === failing) { failed = true; throw new Error("injected-private-marker"); }
    return renameSync(from, to);
  });
  assert.throws(() => commitFileChanges([
    { file: first, before: "first-original", after: "first-next" },
    { file: removed, before: "removed-original", after: undefined },
    { file: created, before: undefined, after: "new" },
    { file: failing, before: "last-original", after: "last-next" },
  ]), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /previous writes rolled back/);
    assert.equal(error.message.includes("injected-private-marker"), false);
    return true;
  });
  mock.restoreAll();
  assert.equal(text(first), "first-original");
  assert.equal(text(removed), "removed-original");
  assert.equal(text(failing), "last-original");
  assert.equal(fs.existsSync(created), false);
  assert.equal(fs.existsSync(file("created")), false);
  assert.equal(fs.readdirSync(sandbox).some((name) => name.includes(".tmp")), false);
});

test("generated credential refs resist punctuation and case collisions while recognizing legacy names", () => {
  const ids = ["foo-bar", "foo_bar", "Foo-bar", "FOO-BAR"];
  assert.equal(new Set(ids.map(managedCredentialRef)).size, ids.length);
  assert.equal(new Set(ids.map(legacyManagedCredentialRef)).size, 1);
  for (const id of ids) {
    assert.match(managedCredentialRef(id), /^AGENTSW_[A-Z0-9_]+_API_KEY$/);
    assert.equal(isManagedCredentialRef(managedCredentialRef(id), id), true);
    assert.equal(isManagedCredentialRef(legacyManagedCredentialRef(id), id), true);
    assert.equal(isManagedCredentialRef("CUSTOM_KEY", id), false);
  }
});

test("legacy locally owned refs migrate to canonical keys in Hermes and flat DSH credentials", async () => {
  const legacy = legacyManagedCredentialRef(oldId);
  write(".hermes/config.yaml", `providers: {${oldId}: {key_env: ${legacy}}}\n`);
  write(".hermes/.env", `export ${legacy}="test-key" # keep\n`);
  write(".dsh/settings.yml", `llm-pi-ai: {providers: {${oldId}: {apiKeyEnv: ${legacy}}}}\n`);
  write(".dsh/.credentials.yaml", `${legacy}: test-key\nCUSTOM: keep\n`);
  const before = tree();
  await renameProvider(oldId, newId, { dryRun: true });
  assert.deepEqual(tree(), before);
  await renameProvider(oldId, newId);
  assert.equal(yaml(".hermes/config.yaml").providers[newId].key_env, newKey);
  assert.equal(text(".hermes/.env"), `export ${newKey}="test-key" # keep\n`);
  assert.deepEqual(yaml(".dsh/.credentials.yaml"), { [newKey]: "test-key", CUSTOM: "keep" });
});

test("legacy refs colliding with another provider stay owned by their existing users", async () => {
  const source = "foo-bar";
  const other = "foo_bar";
  const legacy = legacyManagedCredentialRef(source);
  write(configFile, JSON.stringify({ version: 1, providers: {
    [source]: { ...provider, id: source }, [other]: { ...provider, id: other },
  } }));
  write(".hermes/config.yaml", `providers: {${source}: {key_env: ${legacy}}, ${other}: {key_env: ${legacy}}}\n`);
  write(".hermes/.env", `${legacy}=test-key\n`);
  await renameProvider(source, "renamed");
  assert.equal(text(".hermes/.env"), `${legacy}=test-key\n`);
  assert.equal(yaml(".hermes/config.yaml").providers.renamed.key_env, legacy);
  assert.equal(yaml(".hermes/config.yaml").providers[other].key_env, legacy);
});

test("explicit custom refs do not migrate unrelated generated local secrets", async () => {
  write(".hermes/config.yaml", `providers: {${oldId}: {key_env: CUSTOM_KEY}}\n`);
  write(".hermes/.env", `CUSTOM_KEY=test-key\n${oldKey}=unrelated-account\n`);
  write(".dsh/settings.yaml", `llm-pi-ai: {providers: {${oldId}: {apiKeyEnv: CUSTOM_KEY}}}\n`);
  write(".dsh/.credentials.yaml", `version: 1\nrefs: {CUSTOM_KEY: test-key, ${oldKey}: unrelated-account}\n`);
  const env = text(".hermes/.env");
  const credentials = text(".dsh/.credentials.yaml");
  await renameProvider(oldId, newId);
  assert.equal(text(".hermes/.env"), env);
  assert.equal(text(".dsh/.credentials.yaml"), credentials);
});

for (const app of ["pi", "prime", "omp"]) test(`${app} uppercase literal credentials conflict before normal or preview rename`, async () => {
  const name = app === "omp" ? ".omp/agent/models.yml" : `.${app}/agent/models.json`;
  write(name, JSON.stringify({ providers: { [oldId]: { apiKey: "UPPERCASE_LITERAL_KEY" } } }));
  const before = tree();
  for (const dryRun of [true, false]) {
    await assert.rejects(renameProvider(oldId, newId, { dryRun }), /credentials conflict/);
    assert.deepEqual(tree(), before);
  }
  assert.equal(fs.existsSync(backupsDir), false);
});

test("Pi uppercase keys are literals even when a same-name environment variable exists", async () => {
  process.env.UPPERCASE_LITERAL_KEY = provider.apiKey;
  write(".pi/agent/models.json", JSON.stringify({ providers: { [oldId]: { apiKey: "UPPERCASE_LITERAL_KEY" } } }));
  await assert.rejects(renameProvider(oldId, newId), /credentials conflict/);
});

for (const app of ["prime", "omp"]) test(`${app} resolves actual environment keys and leaves command/file references unresolved`, async () => {
  process.env.FIXTURE_LOOKUP_KEY = provider.apiKey;
  const name = app === "omp" ? ".omp/agent/models.yml" : `.${app}/agent/models.json`;
  write(name, JSON.stringify({ providers: { [oldId]: { apiKey: "FIXTURE_LOOKUP_KEY", models: [
    { id: "command", apiKey: "!do-not-execute" }, { id: "file", apiKey: "{file:/do-not-read}" },
  ] } } }));
  await renameProvider(oldId, newId);
  const result = app === "omp" ? yaml(name) : json(name);
  assert.equal(result.providers[newId].apiKey, "FIXTURE_LOOKUP_KEY");
});

test("WorkBuddy ownership markers rename independently of display labels and reject other accounts", async () => {
  seedStore({}, "Custom label");
  const row = { id: "m-a", vendor: "Custom label", agentswProviderId: oldId, url: "https://api.example/v1/chat/completions", apiKey: "wrong-account" };
  write(".workbuddy/models.json", JSON.stringify([row]));
  const before = tree();
  await assert.rejects(renameProvider(oldId, newId, { dryRun: true }), /conflicts with the store/);
  assert.deepEqual(tree(), before);
  write(".workbuddy/models.json", JSON.stringify([{ ...row, apiKey: provider.apiKey }]));
  await renameProvider(oldId, newId);
  assert.equal(json(".workbuddy/models.json")[0].agentswProviderId, newId);
  assert.equal(json(".workbuddy/models.json")[0].vendor, "Custom label");
});
