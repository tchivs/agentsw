import { after, afterEach, beforeEach, test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Provider, Protocol } from "../src/types.js";
import type { AppPackage } from "../src/apps.js";
import type { TargetApp } from "../src/targets/types.js";

// Resolve every application path inside this test's HOME before importing commands.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agentsw-commands-regression-"));
process.env.HOME = sandbox;
process.env.AGENTSW_HOME = sandbox;
for (const name of ["HERMES_HOME", "WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR", "DSH_HOME", "PI_CODING_AGENT_DIR", "PRIME_AGENT_CODING_AGENT_DIR", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG"]) delete process.env[name];
const { cmdAdd, cmdQuickAdd, cmdDiscover, cmdUse, cmdSync, cmdApps, cmdInstall, cmdUpgrade } = await import("../src/commands.js");
const { saveStore, loadStore, configDir } = await import("../src/store.js");
const { targets } = await import("../src/targets/index.js");
const { appPackages } = await import("../src/apps.js");
const { writeFileAtomic, backupFile, setDryRun, drainPendingWrites } = await import("../src/fsutil.js");
const { transactionalTarget } = await import("../src/target-transaction.js");

let messages: string[] = [];
const originalExitCode = process.exitCode;
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));
afterEach(() => {
  process.exitCode = originalExitCode;
  setDryRun(false);
});
beforeEach((t) => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(sandbox);
  saveStore({ version: 1, providers: {} });
  fs.writeFileSync(path.join(configDir, "models-dev.json"), JSON.stringify({
    other: { id: "other", models: { "keep-base": { id: "keep-base", limit: { context: 999 } } } },
    hint: { id: "hint", models: { "keep-base": { id: "keep-base", limit: { context: 111 } } } },
  }));
  messages = [];
  process.exitCode = undefined;
  t.mock.method(console, "log", (...args: unknown[]) => { messages.push(args.map(String).join(" ")); });
  t.mock.method(process.stderr, "write", () => true);
  t.mock.method(process, "exit", ((code?: number | string | null): never => { throw new Error(`process.exit(${code})`); }) as typeof process.exit);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
});

function provider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "user-owned-id",
    name: "User-owned display name",
    protocol: "openai",
    baseUrl: "https://fixture.example/tenant/v1",
    apiKey: "fixture-command-api-key",
    openaiApi: "responses",
    defaultModel: "z-default",
    smallModel: "m-small",
    reasoningEffort: "high",
    modelsDevId: "hint",
    modelFilter: { include: ["keep-*"], exclude: ["*blocked*"], dedup: false },
    models: [{ id: "z-default" }, { id: "m-small" }, { id: "keep-base" }],
    ...overrides,
  };
}

function seed(...providers: Provider[]): void {
  saveStore({ version: 1, active: providers[0]?.id, providers: Object.fromEntries(providers.map((p) => [p.id, p])) });
}

function mockModels(t: TestContext, protocols: Protocol[] = ["openai"]): void {
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    assert.equal(new URL(String(input)).pathname, "/tenant/v1/models");
    const protocol = new Headers(init?.headers).has("x-api-key") ? "anthropic" : "openai";
    return Response.json({ data: ["keep-base", "keep-base-20260101", "keep-blocked", "outside", "m-small", "z-default"].map((id) => ({ id })) }, { status: protocols.includes(protocol) ? 200 : 401 });
  });
}

function snapshot(dir = sandbox): unknown[] {
  const entries: unknown[] = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    entries.push([path.relative(sandbox, file), stat.mode, stat.mtimeMs, stat.ino, stat.isDirectory() ? snapshot(file) : fs.readFileSync(file, "utf8")]);
  }
  return entries;
}

function useTargets(t: TestContext, ...next: TargetApp[]): void {
  const original = [...targets];
  targets.splice(0, targets.length, ...next);
  t.after(() => { targets.splice(0, targets.length, ...original); });
}

function useApps(t: TestContext, ...next: AppPackage[]): void {
  const original = [...appPackages];
  appPackages.splice(0, appPackages.length, ...next);
  t.after(() => { appPackages.splice(0, appPackages.length, ...original); });
}

function fakeTarget(id: string, apply: TargetApp["apply"]): TargetApp {
  return transactionalTarget({ id, name: id, protocols: ["openai", "anthropic"], configPaths: [], detect: () => true, current: () => undefined, apply, prune: apply });
}

test("automatic add and quick reentry retain all user-owned options, IDs, names, and hints", async (t) => {
  const original = { ...provider(), extension: { note: "user metadata" } };
  seed(original);
  mockModels(t);
  for (const command of [
    () => cmdQuickAdd({ baseUrl: original.baseUrl, apiKey: original.apiKey, yes: true }),
    () => cmdAdd({ baseUrl: original.baseUrl, apiKey: original.apiKey, protocol: "openai", discover: true, yes: true }),
  ]) {
    await command();
    const store = loadStore();
    assert.deepEqual(Object.keys(store.providers), [original.id]);
    const actual = store.providers[original.id]!;
    for (const key of ["id", "name", "openaiApi", "defaultModel", "smallModel", "reasoningEffort", "modelsDevId", "modelFilter"] as const) assert.deepEqual(actual[key], original[key], key);
    assert.equal((actual as typeof original).extension.note, "user metadata");
    assert.equal(actual.models.find((m) => m.id === "keep-base")?.contextWindow, 111);
    assert.deepEqual(actual.models.map((m) => m.id), ["keep-base", "keep-base-20260101", "m-small", "z-default"]);
    assert.equal(store.active, original.id);
  }
});

test("reentry retains configured default and small models even when no longer listed", async (t) => {
  const original = provider();
  seed(original);
  t.mock.method(globalThis, "fetch", async (_input: unknown, init?: RequestInit) => Response.json({ data: [{ id: "keep-base" }] }, { status: new Headers(init?.headers).has("x-api-key") ? 401 : 200 }));
  await cmdQuickAdd({ baseUrl: original.baseUrl, apiKey: original.apiKey, yes: true });
  const actual = loadStore().providers[original.id]!;
  assert.equal(actual.defaultModel, original.defaultModel);
  assert.equal(actual.smallModel, original.smallModel);
  assert.deepEqual(new Set(actual.models.map((m) => m.id)), new Set(["keep-base", "z-default", "m-small"]));
});

test("explicit quick settings override selectively without resetting unrelated filter choices", async (t) => {
  const original = provider();
  seed(original);
  mockModels(t);
  await cmdQuickAdd({ baseUrl: original.baseUrl, apiKey: original.apiKey, include: "outside", defaultModel: "outside", yes: true });
  let actual = loadStore().providers[original.id]!;
  assert.deepEqual(actual.modelFilter, { include: ["outside"], exclude: ["*blocked*"], dedup: false });
  assert.equal(actual.openaiApi, "responses");
  assert.equal(actual.smallModel, "m-small");
  await cmdQuickAdd({ baseUrl: original.baseUrl, apiKey: original.apiKey, name: "Explicit new label", openaiApi: "completions", modelsDev: "other", defaultModel: "keep-base", smallModel: "keep-base-20260101", reasoningEffort: "low", include: "keep-*", exclude: "", dedup: true, yes: true });
  actual = loadStore().providers[original.id]!;
  assert.equal(actual.id, original.id);
  assert.equal(actual.name, "Explicit new label");
  assert.equal(actual.openaiApi, "completions");
  assert.equal(actual.modelsDevId, "other");
  assert.equal(actual.reasoningEffort, "low");
  assert.equal(actual.defaultModel, "keep-base");
  assert.equal(actual.smallModel, "keep-base-20260101");
  assert.equal(actual.models.find((m) => m.id === "keep-base")?.contextWindow, 999);
  assert.deepEqual(actual.modelFilter, { include: ["keep-*"], exclude: [], dedup: true });
});

test("explicit automatic-add overrides replace only requested settings", async (t) => {
  const original = provider();
  seed(original);
  mockModels(t);
  await cmdAdd({ baseUrl: original.baseUrl, apiKey: original.apiKey, protocol: "openai", discover: true, yes: true, openaiApi: "completions", defaultModel: "keep-base", smallModel: "keep-base-20260101", reasoningEffort: "low", modelsDev: "other", exclude: "", dedup: true });
  const actual = loadStore().providers[original.id]!;
  assert.equal(actual.name, original.name);
  assert.equal(actual.openaiApi, "completions");
  assert.equal(actual.defaultModel, "keep-base");
  assert.equal(actual.smallModel, "keep-base-20260101");
  assert.equal(actual.reasoningEffort, "low");
  assert.equal(actual.modelsDevId, "other");
  assert.deepEqual(actual.modelFilter, { include: ["keep-*"], exclude: [], dedup: true });
});

test("invalid quick wire or explicit small model does not persist any changes", async (t) => {
  const original = provider();
  seed(original);
  mockModels(t);
  const before = snapshot();
  for (const extra of [{ openaiApi: "invalid-wire" }, { smallModel: "not-listed" }]) {
    await assert.rejects(cmdQuickAdd({ baseUrl: original.baseUrl, apiKey: original.apiKey, yes: true, ...extra }), /process.exit/);
    assert.deepEqual(snapshot(), before);
  }
});

test("discovery persists complete paginated results and retains old store on any late page failure", async (t) => {
  const original = provider({ protocol: "anthropic", modelFilter: undefined });
  seed(original);
  let failSecond = true;
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request) => {
    const cursor = new URL(String(input)).searchParams.get("after_id");
    if (!cursor) return Response.json({ data: [{ id: "z-default" }, { id: "first" }], has_more: true, last_id: "first" });
    return failSecond ? new Response("failed", { status: 503 }) : Response.json({ data: [{ id: "last" }, { id: "first" }, { id: "m-small" }], has_more: false });
  });
  const before = snapshot();
  await assert.rejects(cmdDiscover(original.id, { exclude: "first" }), /HTTP 503/);
  assert.deepEqual(snapshot(), before);
  failSecond = false;
  await cmdDiscover(original.id, {});
  assert.deepEqual(loadStore().providers[original.id]!.models.map((m) => m.id), ["first", "last", "m-small", "z-default"]);
});

test("a second protocol's failed later page prevents partial quick-add store updates", async (t) => {
  seed(provider());
  const calls = new Map<string, number>();
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const protocol = new Headers(init?.headers).has("x-api-key") ? "anthropic" : "openai";
    const call = (calls.get(protocol) ?? 0) + 1;
    calls.set(protocol, call);
    if (new URL(String(input)).searchParams.has("after_id")) return new Response("failed", { status: 502 });
    return Response.json({ data: [{ id: "keep-base" }], ...(protocol === "anthropic" && call > 1 ? { has_more: true, last_id: "cursor" } : {}) });
  });
  const before = snapshot();
  await assert.rejects(cmdQuickAdd({ baseUrl: provider().baseUrl, apiKey: provider().apiKey, yes: true }), /HTTP 502/);
  assert.deepEqual(snapshot(), before);
});

test("invalid targets fail before changing active provider, defaults, filters or app files", async () => {
  const original = provider();
  const second = provider({ id: "second-account", apiKey: "fixture-second-key" });
  seed(original, second);
  const before = snapshot();
  await assert.rejects(cmdUse(second.id, { apps: "pi,not-an-app", model: "keep-base" }), /unknown app/);
  await assert.rejects(cmdSync({ provider: second.id, apps: "not-an-app" }), /unknown app/);
  await assert.rejects(cmdDiscover(second.id, { apps: "not-an-app", sync: true, exclude: "keep" }), /unknown app/);
  assert.deepEqual(snapshot(), before);
});

test("real adapter previews redact old, new and unrelated credentials without filesystem writes", async () => {
  const original = provider();
  seed(original);
  const file = path.join(sandbox, ".pi", "agent", "models.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const secrets = [original.apiKey, "fixture-old-key", "fixture-other-key", "fixture-header-secret", "fixture-comment-secret"];
  fs.writeFileSync(file, `// ${secrets[4]}\n` + JSON.stringify({ providers: {
    [original.id]: { baseUrl: original.baseUrl, api: "openai-responses", apiKey: secrets[1], models: [{ id: "old" }] },
    unrelated: { baseUrl: "https://other.example/v1", apiKey: secrets[2], headers: { Authorization: `Bearer ${secrets[3]}` }, models: [{ id: "unrelated" }] },
  } }));
  const before = snapshot();
  await cmdUse(original.id, { apps: "pi,omp,codex,opencode", model: "keep-base", dryRun: true });
  const output = messages.join("\n");
  for (const secret of secrets) assert.equal(output.includes(secret), false, "preview must not expose credential values");
  assert.match(output, /redacted/);
  assert.match(output, /keep-base/);
  assert.deepEqual(snapshot(), before);
  assert.deepEqual(drainPendingWrites(), []);
});

test("preview redacts semantic secrets in JSONC, TOML, YAML and dotenv including removed lines", async (t) => {
  seed(provider());
  const files = [
    ["fixture.jsonc", '{"headers":{"Authorization":"Bearer fixture-old-header"},"apiKey":"fixture-old-json","auth":"fixture-old-auth","note":"before"}', '{"headers":{"Authorization":"Bearer fixture-new-header"},"apiKey":"fixture-new-json","auth":"fixture-new-auth","note":"after"}'],
    ["fixture.toml", 'api_key = "fixture-old-toml"\nnote = "before"\n', 'api_key = "fixture-new-toml"\nnote = "after"\n'],
    ["fixture.yaml", 'credentials:\n  custom: fixture-old-yaml\nnote: before\n', 'credentials:\n  custom: fixture-new-yaml\nnote: after\n'],
    [".env", 'ARBITRARY_NAME="fixture-old-env"\n', 'ARBITRARY_NAME="fixture-new-env"\n'],
  ];
  for (const [name, before] of files) fs.writeFileSync(path.join(sandbox, name!), before!);
  useTargets(t, fakeTarget("fixture", async () => {
    for (const [name, , after] of files) {
      const file = path.join(sandbox, name!);
      backupFile(file);
      writeFileAtomic(file, after!);
    }
    return { app: "fixture", changed: files.map(([name]) => path.join(sandbox, name!)), notes: [] };
  }));
  const before = snapshot();
  await cmdSync({ apps: "fixture", dryRun: true });
  const output = messages.join("\n");
  assert.doesNotMatch(output, /fixture-(?:old|new)-(?:header|json|toml|yaml|env|auth)/);
  assert.match(output, /- .*before/);
  assert.match(output, /\+ .*after/);
  assert.deepEqual(snapshot(), before);
});

test("credential-file previews redact arbitrary flat and nested reference values during migration", async (t) => {
  const original = provider();
  seed(original);
  const file = path.join(sandbox, ".credentials.yaml");
  fs.writeFileSync(file, "CUSTOM: fixture-other-secret\nSHARED: fixture-shared-secret\n");
  useTargets(t, fakeTarget("fixture", async () => {
    backupFile(file);
    writeFileAtomic(file, `refs:\n  CUSTOM: fixture-other-secret\n  SHARED: fixture-shared-secret\n  ACTIVE: ${original.apiKey}\n`);
    return { app: "fixture", changed: [file], notes: [] };
  }));
  const before = snapshot();
  await cmdSync({ apps: "fixture", dryRun: true });
  const output = messages.join("\n");
  assert.match(output, /refs/);
  assert.match(output, /CUSTOM/);
  assert.match(output, /REDACTED/);
  for (const secret of ["fixture-other-secret", "fixture-shared-secret", original.apiKey]) assert.equal(output.includes(secret), false);
  assert.deepEqual(snapshot(), before);
});

test("malformed preview configs never fall back to raw text and dry-run errors hide parser secrets", async (t) => {
  seed(provider());
  const file = path.join(sandbox, "invalid.json");
  fs.writeFileSync(file, '{"apiKey":"fixture-malformed-secret", invalid');
  useTargets(t,
    fakeTarget("malformed", async () => {
      writeFileAtomic(file, '{"apiKey":"fixture-new-secret"}');
      return { app: "malformed", changed: [file], notes: [] };
    }),
    fakeTarget("throws", async () => { throw new Error("parser leaked fixture-error-secret"); }),
  );
  const before = snapshot();
  await cmdSync({ apps: "malformed,throws", dryRun: true });
  assert.match(messages.join("\n"), /content withheld/);
  assert.match(messages.join("\n"), /could not be previewed safely/);
  assert.doesNotMatch(messages.join("\n"), /fixture-(?:malformed|new|error)-secret/);
  assert.deepEqual(snapshot(), before);
  assert.equal(process.exitCode, 1);
});

test("target detection and application errors set failure status while other targets continue", async (t) => {
  seed(provider());
  let applied = 0;
  const detection = fakeTarget("detect-fails", async () => { throw new Error("must not apply"); });
  detection.detect = () => { throw new Error("detection failed"); };
  useTargets(t, detection,
    fakeTarget("apply-fails", async () => { throw new Error("application failed"); }),
    fakeTarget("succeeds", async () => { applied++; return { app: "succeeds", changed: [], notes: [] }; }),
  );
  await cmdSync({});
  assert.equal(applied, 1);
  assert.equal(process.exitCode, 1);
  assert.match(messages.join("\n"), /detection failed/);
  assert.match(messages.join("\n"), /application failed/);
});

test("install refuses successful-exit installers whose app remains undetected", async (t) => {
  useApps(t, { id: "fixture", name: "Fixture", installCmd: "exit 0", windowsInstallCmd: "exit 0", localVersion: () => undefined });
  await assert.rejects(cmdInstall("fixture"), /still not detected/);
  assert.doesNotMatch(messages.join("\n"), /Fixture installed:/);
});

test("install propagates command failures and only reports verified installed versions", async (t) => {
  let probes = 0;
  const app: AppPackage = { id: "fixture", name: "Fixture", installCmd: "exit 7", windowsInstallCmd: "exit 7", localVersion: () => undefined };
  useApps(t, app);
  await assert.rejects(cmdInstall("fixture"));
  app.installCmd = app.windowsInstallCmd = "exit 0";
  app.localVersion = () => ++probes > 1 ? "1.2.3" : undefined;
  await cmdInstall("fixture");
  assert.match(messages.join("\n"), /Fixture installed: 1\.2\.3/);
});

test("detected installations with unreadable versions do not claim verified success", async (t) => {
  let probes = 0;
  useApps(t, { id: "fixture", name: "Fixture", installCmd: "exit 0", windowsInstallCmd: "exit 0", localVersion: () => ++probes > 1 ? "?" : undefined });
  await cmdInstall("fixture");
  assert.match(messages.join("\n"), /version unknown/);
  assert.doesNotMatch(messages.join("\n"), /Fixture installed:/);
  assert.equal(process.exitCode, 1);
});

test("automatic upgrade reports failed or unknown version checks instead of up-to-date", async (t) => {
  const app: AppPackage = { id: "fixture", name: "Fixture", installCmd: "exit 0", windowsInstallCmd: "exit 0", latest: { kind: "npm", name: "fixture-package" }, localVersion: () => "1.0.0" };
  useApps(t, app);
  for (const scenario of ["missing-latest", "invalid-latest", "unknown-installed", "invalid-installed", "failed-installed"]) {
    messages = [];
    process.exitCode = undefined;
    app.localVersion = scenario === "failed-installed" ? () => { throw new Error("local probe failed"); } : () => scenario === "unknown-installed" ? "?" : scenario === "invalid-installed" ? "not-a-version" : "1.0.0";
    t.mock.method(globalThis, "fetch", async () => scenario === "missing-latest" ? new Response("offline", { status: 503 }) : Response.json({ version: scenario === "invalid-latest" ? "not-a-version" : "2.0.0" }));
    await cmdUpgrade([]);
    assert.equal(process.exitCode, 1, scenario);
    assert.match(messages.join("\n"), /unknown/);
    assert.doesNotMatch(messages.join("\n"), /up to date/);
    await cmdApps();
    assert.match(messages.join("\n"), /unknown/);
  }
});

test("automatic upgrade distinguishes known current versions and no installations", async (t) => {
  const app: AppPackage = { id: "fixture", name: "Fixture", installCmd: "exit 0", windowsInstallCmd: "exit 0", latest: { kind: "npm", name: "fixture-package" }, localVersion: () => "1.0.0" };
  useApps(t, app);
  t.mock.method(globalThis, "fetch", async () => Response.json({ version: "1.0.0" }));
  await cmdUpgrade([]);
  assert.match(messages.join("\n"), /all checked apps are up to date/);
  assert.equal(process.exitCode, undefined);
  messages = [];
  app.localVersion = () => undefined;
  await cmdUpgrade([]);
  assert.match(messages.join("\n"), /no installed CLI-managed apps/);
  assert.doesNotMatch(messages.join("\n"), /up to date/);
});

test("upgrade handles command errors, unknown postconditions, and zero-exit no-op upgrades", async (t) => {
  const app: AppPackage = { id: "fixture", name: "Fixture", installCmd: "exit 0", windowsInstallCmd: "exit 0", latest: { kind: "npm", name: "fixture-package" }, localVersion: () => "1.0.0" };
  useApps(t, app);
  t.mock.method(globalThis, "fetch", async () => Response.json({ version: "2.0.0" }));
  await cmdUpgrade([]);
  assert.equal(process.exitCode, 1);
  assert.match(messages.join("\n"), /older than available/);
  app.installCmd = app.windowsInstallCmd = "exit 7";
  await cmdUpgrade([app.id]);
  assert.match(messages.join("\n"), /upgrade failed/);
  app.installCmd = app.windowsInstallCmd = "exit 0";
  app.localVersion = () => "?";
  await cmdUpgrade([app.id]);
  assert.match(messages.join("\n"), /version is unknown/);
  assert.equal(process.exitCode, 1);
});
