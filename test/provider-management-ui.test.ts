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
const { setLocale, t } = await import("../src/i18n.js");
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

function capturePrompts(answers: unknown[]): prompts.PromptObject[] {
  const questions: prompts.PromptObject[] = [];
  // Clear inject mode so the real prompt dispatcher reaches these test renderers.
  Reflect.deleteProperty(prompts, "_injected");
  for (const type of ["select", "text", "toggle"] as const) {
    mock.method(prompts.prompts, type, async (question: prompts.PromptObject) => {
      questions.push(question);
      return answers.shift();
    });
  }
  return questions;
}

beforeEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  put(path.join(sandbox, ".config/agentsw/models-dev.json"), {});
  put(path.join(sandbox, ".config/agentsw/ai-gateway.json"), {
    version: 1, fetchedAt: new Date().toISOString(), body: { data: [] },
  });
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

for (const locale of ["en", "zh-CN"] as const) {
  test(`menu labels explain actions and sync direction (${locale})`, { timeout: 5000 }, async () => {
    setLocale(locale);
    const questions = capturePrompts(["quit"]);
    await cmdMenu();
    const choices = questions.find((question) => question.name === "action")!.choices as prompts.Choice[];
    assert.deepEqual(choices.map((choice) => choice.value), [
      "quickAdd", "add", "import", "use", "status", "list", "sync", "discover", "metadata", "rename", "remove", "apps", "install", "language", "quit",
    ]);
    assert.equal(new Set(choices.map((choice) => choice.title)).size, choices.length);
    for (const choice of choices) {
      assert.ok(choice.description, `missing help for ${choice.value}`);
      assert.doesNotMatch(choice.title, /\s{2,}|\{[^}]+\}/);
      assert.doesNotMatch(choice.description!, /\{[^}]+\}/);
    }
    const choice = (value: string) => choices.find((entry) => entry.value === value)!;
    assert.match(choice("quickAdd").title, /auto-detect|自动识别/);
    assert.match(choice("add").title, /manual setup|手动设置/);
    assert.match(choice("list").title, /agentsw/);
    assert.match(choice("status").title, /each agent|各智能体/);
    assert.match(choice("sync").description!, /without fetching|不重新获取/);
    assert.match(choice("discover").description!, /Fetch models|重新获取模型/);
    assert.match(choice("metadata").description!, /Keep the model list|保留模型列表/);
    assert.match(choice("metadata").description!, /AI Gateway/);
    assert.match(choice("rename").title, /ID/);
    assert.match(choice("rename").description!, /keep custom display names|保留自定义显示名称/);
    assert.match(choice("language").title, /language/i);
    assert.match(choice("language").title, /语言/);
    assert.deepEqual(errors, []);
  });

  for (const scope of ["store", "local", "everywhere"] as const) {
    test(`deletion explains ${scope} scope and defaults to cancel (${locale})`, { timeout: 5000 }, async () => {
      setLocale(locale);
      if (scope === "local") setupLocal();
      else put(primeFile, { providers: { legacy: { api: "openai-responses", baseUrl: legacy.baseUrl, apiKey: legacy.apiKey, models: legacy.models } } });
      const beforeStore = fs.readFileSync(storeFile, "utf8");
      const beforePrime = fs.readFileSync(primeFile, "utf8");
      const answers: unknown[] = scope === "local"
        ? ["remove", "local", "prime", 0, false, "quit"]
        : ["remove", scope, 0, false, "quit"];
      const questions = capturePrompts(answers);
      await cmdMenu();
      assert.equal(answers.length, 0);
      const scopeChoices = questions.find((question) => question.name === "scope")!.choices as prompts.Choice[];
      assert.deepEqual(scopeChoices.map((choice) => choice.value), ["store", "local", "everywhere"]);
      assert.ok(scopeChoices.every((choice) => choice.description));
      const confirmation = questions.find((question) => question.type === "toggle")!;
      assert.ok(confirmation);
      assert.equal(confirmation.initial, false);
      assert.equal(confirmation.active, t("menu.confirmRemove"));
      assert.equal(confirmation.inactive, t("menu.cancelAction"));
      const expected = scope === "local"
        ? t("menu.removeConfirmLocal", { id: "orphan", app: "prime" })
        : t(scope === "store" ? "menu.removeConfirmStore" : "menu.removeConfirmEverywhere", { id: "legacy" });
      assert.equal(confirmation.message, expected);
      assert.doesNotMatch(String(confirmation.message), /\{[^}]+\}/);
      if (scope === "local") assert.match(String(confirmation.message), /syncing later may add it back|再次同步可能恢复/);
      if (scope === "store") assert.match(String(confirmation.message), /All agent configs stay unchanged|各智能体配置保持不变/);
      if (scope === "everywhere") assert.match(String(confirmation.message), /default selections will also be cleared|默认选择会一并清理/);
      assert.equal(fs.readFileSync(storeFile, "utf8"), beforeStore);
      assert.equal(fs.readFileSync(primeFile, "utf8"), beforePrime);
      assert.equal(fs.existsSync(path.join(sandbox, ".config/agentsw/backups")), false);
      assert.deepEqual(errors, []);
    });
  }

  test(`rename confirmation describes the ID change and defaults to cancel (${locale})`, { timeout: 5000 }, async () => {
    setLocale(locale);
    const before = fs.readFileSync(storeFile, "utf8");
    const questions = capturePrompts(["rename", "legacy", "new-provider-id", false, "quit"]);
    await cmdMenu();
    const confirmation = questions.find((question) => question.type === "toggle")!;
    assert.ok(confirmation);
    assert.equal(confirmation.message, t("menu.renameConfirm", { oldId: "legacy", newId: "new-provider-id" }));
    assert.equal(confirmation.active, t("menu.confirmRename"));
    assert.equal(confirmation.inactive, t("menu.cancelAction"));
    assert.equal(confirmation.initial, false);
    assert.equal(fs.readFileSync(storeFile, "utf8"), before);
    assert.equal(fs.existsSync(path.join(sandbox, ".config/agentsw/backups")), false);
    assert.deepEqual(errors, []);
  });
}

for (const locale of ["en", "zh-CN"] as const) {
  for (const [stored, selected, initial, expected] of [
    [undefined, "auto", 0, "auto"],
    ["auto", "auto", 0, "auto"],
    [true, "on", 1, true],
    [false, "off", 2, false],
    [false, "auto", 2, "auto"],
  ] as const) {
    test(`metadata menu selects ${selected} from ${String(stored)} and only refreshes stored parameters (${locale})`, async () => {
      setLocale(locale);
      put(storeFile, { version: 1, language: locale, active: "legacy", providers: { legacy: {
        ...legacy, gatewayMetadata: stored,
      } } });
      setupLocal();
      const beforePrime = fs.readFileSync(primeFile, "utf8");
      const requests: string[] = [];
      mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
        const url = String(input);
        requests.push(url);
        assert.ok(["https://models.dev/api.json", "https://ai-gateway.vercel.sh/v1/models"].includes(url));
        return Response.json(url.includes("models.dev") ? {} : { data: [
          { id: "vendor/model-a", type: "language", context_window: 4096, max_tokens: 512 },
        ] });
      });
      const answers = ["metadata", "legacy", selected, "quit"];
      const questions = capturePrompts(answers);
      await cmdMenu();
      assert.equal(answers.length, 0);
      assert.deepEqual(questions.map((question) => question.name), ["action", "id", "metadataMode", "action"]);
      const selection = questions.find((question) => question.name === "metadataMode")!;
      assert.equal(selection.type, "select");
      assert.equal(selection.initial, initial);
      assert.equal(selection.message, t("menu.metadataMode"));
      const choices = selection.choices as prompts.Choice[];
      assert.deepEqual(choices.map((choice) => choice.value), ["auto", "on", "off"]);
      assert.match(choices[0]!.title, /recommended|推荐/);
      assert.match(choices[0]!.description!, /models\.dev/);
      assert.match(choices[0]!.description!, /missing core specs|核心参数缺失/);
      assert.match(choices[0]!.description!, /refresh its saved fields|刷新已有 Gateway 字段/);
      const saved = JSON.parse(fs.readFileSync(storeFile, "utf8")).providers.legacy;
      assert.equal(saved.gatewayMetadata, expected);
      assert.deepEqual(saved.models.map((model: { id: string }) => model.id), ["model-a"]);
      assert.equal(saved.models[0].maxOutput, selected === "off" ? undefined : 512);
      if (selected === "off") assert.ok(!requests.includes("https://ai-gateway.vercel.sh/v1/models"));
      else assert.equal(saved.models[0].metadata.gateway.modelId, "vendor/model-a");
      assert.equal(fs.readFileSync(primeFile, "utf8"), beforePrime);
      assert.deepEqual(errors, []);
    });
  }
}
