import { after, afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import prompts from "prompts";
import YAML from "yaml";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agentsw-management-ui-"));
process.env.HOME = sandbox;
process.env.AGENTSW_HOME = sandbox;
for (const key of ["PI_CODING_AGENT_DIR", "PRIME_AGENT_CODING_AGENT_DIR", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG", "HERMES_HOME", "DSH_HOME", "WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR"]) delete process.env[key];
// The store and adapters capture home on import; load only after sandboxing.
const { cmdMenu } = await import("../src/menu.js");
const { listRemovableProviders } = await import("../src/remove.js");
const { setLocale } = await import("../src/i18n.js");
const storeFile = path.join(sandbox, ".config/agentsw/config.json");
const primeFile = path.join(sandbox, ".prime/agent/models.json");
const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const errors: string[] = [];
const legacy = {
  id: "legacy", name: "My account", protocol: "openai", openaiApi: "responses",
  baseUrl: "https://api.example.test/v1", apiKey: "fixture-secret", defaultModel: "model-a", models: [{ id: "model-a" }],
};

function put(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value, null, 2));
}
function run(...args: string[]): string {
  return execFileSync(process.execPath, ["--import", "tsx", cli, "--lang", "en", ...args], {
    encoding: "utf8", env: { ...process.env }, timeout: 15000,
  });
}
function setupLocal(): void {
  put(primeFile, { providers: { orphan: { api: "openai-responses", baseUrl: "https://local.example/v1", apiKey: "private-fixture", models: [{ id: "local-model" }] } } });
  put(path.join(sandbox, ".prime/agent/settings.json"), { defaultProvider: "orphan", defaultModel: "local-model", theme: "dark" });
}

beforeEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  put(storeFile, { version: 1, language: "en", active: "legacy", providers: { legacy } });
  prompts.override({});
  setLocale("en");
  errors.length = 0;
  mock.method(console, "log", () => {});
  mock.method(console, "error", (...args: unknown[]) => { errors.push(args.join(" ")); });
});
afterEach(() => mock.restoreAll());
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

test("CLI exposes rename and scoped removal, and lists agent-only IDs without secrets", () => {
  setupLocal();
  assert.match(run("rename", "--help"), /--dry-run/);
  assert.match(run("remove", "--help"), /--apps/);
  const listed = run("list", "--apps", "prime");
  assert.match(listed, /prime\s+orphan/);
  assert.doesNotMatch(listed, /private-fixture|fixture-secret/);
  assert.doesNotMatch(listed, /legacy/);
});

test("CLI preview and actual removal work for a provider absent from agentsw", () => {
  setupLocal();
  const storeBefore = fs.readFileSync(storeFile, "utf8");
  const primeBefore = fs.readFileSync(primeFile, "utf8");
  assert.match(run("remove", "orphan", "--apps", "prime", "--dry-run"), /preview:/);
  assert.equal(fs.readFileSync(primeFile, "utf8"), primeBefore);
  assert.equal(fs.existsSync(path.join(sandbox, ".config/agentsw/backups")), false);
  run("remove", "orphan", "--apps", "prime");
  assert.equal(JSON.parse(fs.readFileSync(primeFile, "utf8")).providers.orphan, undefined);
  assert.equal(fs.readFileSync(storeFile, "utf8"), storeBefore);
});

test("interactive local deletion cancellation leaves all files untouched", { timeout: 5000 }, async () => {
  setupLocal();
  const before = fs.readFileSync(primeFile, "utf8");
  const entries = listRemovableProviders("prime");
  const selection = entries.findIndex((entry) => entry.app === "prime" && entry.id === "orphan");
  assert.ok(selection >= 0);
  prompts.inject(["remove", "local", "prime", selection, false, "quit"]);
  await cmdMenu();
  assert.deepEqual(errors, []);
  assert.equal(fs.readFileSync(primeFile, "utf8"), before);
  assert.equal(fs.existsSync(path.join(sandbox, ".config/agentsw/backups")), false);
});

test("interactive confirmed local deletion preserves the store", { timeout: 5000 }, async () => {
  setupLocal();
  const before = fs.readFileSync(storeFile, "utf8");
  const entries = listRemovableProviders("prime");
  const selection = entries.findIndex((entry) => entry.app === "prime" && entry.id === "orphan");
  prompts.inject(["remove", "local", "prime", selection, true, "quit"]);
  await cmdMenu();
  assert.deepEqual(errors, []);
  assert.equal(JSON.parse(fs.readFileSync(primeFile, "utf8")).providers.orphan, undefined);
  assert.equal(fs.readFileSync(storeFile, "utf8"), before);
});

test("interactive rename previews and migrates defaults without changing custom display name", { timeout: 5000 }, async () => {
  put(primeFile, { providers: { legacy: { api: "openai-responses", baseUrl: legacy.baseUrl, models: [{ id: "model-a", custom: true }] } } });
  put(path.join(sandbox, ".prime/agent/settings.json"), { defaultProvider: "legacy", defaultModel: "model-a" });
  prompts.inject(["rename", "legacy", "api-example-test-openai", true, "quit"]);
  await cmdMenu();
  assert.deepEqual(errors, []);
  const store = JSON.parse(fs.readFileSync(storeFile, "utf8"));
  assert.equal(store.active, "api-example-test-openai");
  assert.equal(store.providers.legacy, undefined);
  assert.equal(store.providers[store.active].name, "My account");
  const settings = JSON.parse(fs.readFileSync(path.join(sandbox, ".prime/agent/settings.json"), "utf8"));
  assert.equal(settings.defaultProvider, store.active);
  assert.equal(settings.defaultModel, "model-a");
});

test("staged rename repairs known dangling model-role references from an earlier alias cleanup", () => {
  const ompDir = path.join(sandbox, ".omp/agent");
  put(path.join(ompDir, "models.yml"), "providers:\n  legacy:\n    api: openai-responses\n    baseUrl: https://api.example.test/v1\n    models: [{id: model-a}]\n");
  put(path.join(ompDir, "config.yml"), "modelRoles:\n  smol: sub/model-a:auto\n  vision: sub/model-a:max\n");
  run("rename", "legacy", "sub");
  run("rename", "sub", "api-example-test-openai");
  const roles = YAML.parse(fs.readFileSync(path.join(ompDir, "config.yml"), "utf8")).modelRoles;
  assert.equal(roles.smol, "api-example-test-openai/model-a:auto");
  assert.equal(roles.vision, "api-example-test-openai/model-a:max");
});

test("scoped CLI listing and interactive deletion ignore another agent's malformed config", { timeout: 10000 }, async () => {
  setupLocal();
  put(path.join(sandbox, ".omp/agent/models.yml"), "broken: [");
  assert.match(run("list", "--apps", "prime"), /prime\s+orphan/);
  prompts.inject(["remove", "local", "prime", 0, true, "quit"]);
  await cmdMenu();
  assert.deepEqual(errors, []);
  assert.equal(JSON.parse(fs.readFileSync(primeFile, "utf8")).providers.orphan, undefined);
  assert.equal(fs.readFileSync(path.join(sandbox, ".omp/agent/models.yml"), "utf8"), "broken: [");
});
