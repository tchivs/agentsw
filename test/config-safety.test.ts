import { after, afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ApplyResult, Provider, Store } from "../src/types.js";
import type { TargetApp } from "../src/targets/types.js";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agentsw-config-safety-"));
process.env.HOME = sandbox;
process.env.AGENTSW_HOME = sandbox;
for (const name of [
  "WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG",
  "HERMES_HOME", "DSH_HOME", "PI_CODING_AGENT_DIR", "PRIME_AGENT_CODING_AGENT_DIR",
]) delete process.env[name];

// These modules capture HOME at load time; static imports would escape the test sandbox.
const {
  backupFile, backupsDir, drainPendingWrites, ensureDir, readJsonIfExists,
  readTextIfExists, setDryRun, writeFileAtomic,
} = await import("../src/fsutil.js");
const { commitFileChanges } = await import("../src/config-transaction.js");
const { transactionalTarget } = await import("../src/target-transaction.js");
const { readJsoncObject } = await import("../src/jsonc.js");
const { configFile, loadStore, saveStore } = await import("../src/store.js");
const { codex } = await import("../src/targets/codex.js");
const { workbuddy } = await import("../src/targets/workbuddy.js");

const provider: Provider = {
  id: "fixture", name: "Fixture", protocol: "openai", baseUrl: "https://fixture.invalid/v1",
  apiKey: "fake-config-safety-key", models: [{ id: "fixture-model" }], defaultModel: "fixture-model",
};

beforeEach(() => {
  setDryRun(false);
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(sandbox);
});
afterEach(() => {
  mock.restoreAll();
  setDryRun(false);
});
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

test("an absent no-op file with a mode hint does not become a deletion", () => {
  const file = path.join(sandbox, "missing", ".env");
  for (const dryRun of [true, false]) {
    assert.deepEqual(commitFileChanges([{ file, before: undefined, after: undefined, mode: 0o600 }], { dryRun }), { files: [] });
    assert.equal(fs.existsSync(path.join(sandbox, "missing")), false);
    assert.equal(fs.existsSync(backupsDir), false);
  }
});

function put(relative: string, text: string, mode = 0o600): string {
  const file = path.join(sandbox, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
  return file;
}

function target(operation: (this: TargetApp, provider: Provider) => Promise<ApplyResult>): TargetApp {
  return transactionalTarget({
    id: "fixture", name: "Fixture", protocols: ["openai"], configPaths: [],
    detect: () => true, current: () => undefined, apply: operation, prune: operation,
  });
}

function tree(dir = sandbox): Record<string, string> {
  const result: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) Object.assign(result, tree(file));
    else result[path.relative(sandbox, file)] = fs.readFileSync(file, "utf8");
  }
  return result;
}

for (const operation of ["apply", "prune"] as const) {
  test(`${operation} defers early writes and backups until every file parses`, async () => {
    const first = put("first/config.json", '{"keep":true}\n');
    const last = put("last/config.json", "{broken JSON\n");
    const created = path.join(sandbox, "new/nested/secret.json");
    const before = tree();
    const adapter = target(async function () {
      const original = readJsonIfExists<Record<string, unknown>>(first)!;
      backupFile(first);
      writeFileAtomic(first, JSON.stringify({ ...original, secret: provider.apiKey }));
      ensureDir(path.dirname(created));
      writeFileAtomic(created, provider.apiKey);
      await Promise.resolve();
      readJsonIfExists(last);
      return { app: this.id, changed: [first, created], notes: [] };
    });
    await assert.rejects(adapter[operation](provider));
    assert.deepEqual(tree(), before);
    assert.equal(fs.existsSync(path.dirname(created)), false);
    assert.equal(fs.existsSync(backupsDir), false);
    assert.deepEqual(drainPendingWrites(), []);
  });
}

test("successful targets preserve their receiver, getters, staged reads, and truthful backup notes", async () => {
  const file = put("target/config.json", '{"value":1}\n');
  let configPathReads = 0;
  const raw: TargetApp = {
    id: "bound", name: "Bound", protocols: ["openai"],
    get configPaths() { configPathReads++; return [file]; },
    detect: () => true, current: () => undefined,
    async apply() {
      assert.equal(this.id, "bound");
      assert.equal(backupFile(file), undefined);
      writeFileAtomic(file, '{"value":2}\n');
      assert.equal(readJsonIfExists<{ value: number }>(file)!.value, 2);
      assert.equal(fs.readFileSync(file, "utf8"), '{"value":1}\n');
      writeFileAtomic(file, '{"value":3}\n');
      return { app: this.id, changed: [file, file], notes: ["kept note"] };
    },
    async prune() { return { app: this.id, changed: [], notes: [] }; },
  };
  const adapter = transactionalTarget(raw);
  assert.equal(configPathReads, 0);
  assert.deepEqual(adapter.configPaths, [file]);
  assert.equal(transactionalTarget(adapter), adapter);
  const result = await adapter.apply(provider);
  assert.equal(result.app, "bound");
  assert.deepEqual(result.changed, [file]);
  assert.equal(fs.readFileSync(file, "utf8"), '{"value":3}\n');
  assert.equal(result.notes[0], "kept note");
  const backupDir = result.notes.find((note) => note.startsWith("backup: "))!.slice("backup: ".length);
  assert.equal(fs.existsSync(backupDir), true);
  const originals = fs.readdirSync(backupDir).filter((name) => name !== "manifest.json");
  assert.equal(originals.length, 1);
  assert.equal(fs.readFileSync(path.join(backupDir, originals[0]!), "utf8"), '{"value":1}\n');
});

test("unchanged target writes report no changes and create no backups", async () => {
  const file = put("same.json", "same\n");
  const adapter = target(async function () {
    backupFile(file);
    writeFileAtomic(file, "same\n");
    return { app: this.id, changed: [file], notes: [] };
  });
  assert.deepEqual(await adapter.apply(provider), { app: "fixture", changed: [], notes: [] });
  assert.equal(fs.existsSync(backupsDir), false);
});

test("normal and staged atomic writes preserve 0600 and default new files to private", async () => {
  const existing = put("existing/secret.json", "old", 0o600);
  const direct = path.join(sandbox, "direct/new.json");
  const created = path.join(sandbox, "target/new.json");
  writeFileAtomic(existing, "direct-update");
  writeFileAtomic(direct, provider.apiKey);
  const adapter = target(async function () {
    writeFileAtomic(existing, "transaction-update");
    writeFileAtomic(created, provider.apiKey);
    return { app: this.id, changed: [existing, created], notes: [] };
  });
  await adapter.apply(provider);
  for (const file of [existing, direct, created]) {
    assert.equal(fs.existsSync(file), true);
    if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
});

test("nonsecret custom modes survive replacement and explicit secret modes can tighten permissions", async () => {
  const preserved = put("preserved.json", "before", 0o640);
  const tightened = put("tightened.json", "same", 0o644);
  writeFileAtomic(preserved, "direct");
  const adapter = target(async function () {
    writeFileAtomic(preserved, "after");
    writeFileAtomic(tightened, "same", 0o600);
    return { app: this.id, changed: [preserved, tightened], notes: [] };
  });
  await adapter.apply(provider);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(preserved).mode & 0o777, 0o640);
    assert.equal(fs.statSync(tightened).mode & 0o777, 0o600);
  }
});

test("same-basename backups at a frozen time remain unique and private", () => {
  const first = put("first/config.json", "first-secret", 0o644);
  const second = put("second/config.json", "second-secret", 0o644);
  mock.method(Date.prototype, "toISOString", () => "2026-01-01T00:00:00.000Z");
  mock.method(Date, "now", () => 0);
  const one = backupFile(first)!;
  const two = backupFile(second)!;
  const three = backupFile(first)!;
  assert.equal(new Set([one, two, three]).size, 3);
  assert.equal(fs.readFileSync(one, "utf8"), "first-secret");
  assert.equal(fs.readFileSync(two, "utf8"), "second-secret");
  assert.equal(fs.readFileSync(three, "utf8"), "first-secret");
  if (process.platform !== "win32") {
    for (const file of [one, two, three]) {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
    }
  }
});

test("read helpers propagate access errors and loadStore never converts an unreadable file to empty", () => {
  put(path.relative(sandbox, configFile), '{"version":1,"providers":{}}\n');
  const originalRead = fs.readFileSync;
  mock.method(fs, "readFileSync", (...args: Parameters<typeof fs.readFileSync>) => {
    if (String(args[0]) === configFile) throw Object.assign(new Error("fixture denied"), { code: "EACCES" });
    return Reflect.apply(originalRead, fs, args);
  });
  assert.throws(() => readTextIfExists(configFile), /fixture denied/);
  assert.throws(() => loadStore(), /cannot read.*configuration file/);
  assert.throws(() => saveStore({ version: 1, providers: {} }), /cannot read.*configuration file/);
  assert.equal(readTextIfExists(path.join(sandbox, "missing.json")), undefined);
  assert.equal(fs.existsSync(backupsDir), false);
});

for (const invalid of ["null", "[]", '{"providers":null}', '{"providers":[]}', "{broken"]) {
  test(`invalid store ${invalid} is rejected rather than initialized empty`, () => {
    put(path.relative(sandbox, configFile), invalid);
    assert.throws(() => loadStore(), /provider store|providers object/);
    assert.equal(fs.readFileSync(configFile, "utf8"), invalid);
  });
}

test("stale loaded stores reject after asynchronous waits; initial and repeated object saves succeed", async () => {
  const initial: Store = { version: 1, providers: { fixture: provider } };
  saveStore(initial);
  initial.active = provider.id;
  saveStore(initial);
  const stale = loadStore();
  const newer = loadStore();
  await Promise.resolve();
  newer.language = "zh-CN";
  saveStore(newer);
  stale.language = "en";
  const before = tree();
  assert.throws(() => saveStore(stale), /changed since it was read/);
  assert.deepEqual(tree(), before);
  assert.equal(loadStore().language, "zh-CN");
  newer.language = "en";
  saveStore(newer);
  assert.equal(loadStore().language, "en");
});

test("a missing-store snapshot cannot overwrite a store created while waiting", () => {
  const missing = loadStore();
  saveStore({ version: 1, providers: { fixture: provider } });
  missing.language = "en";
  assert.throws(() => saveStore(missing), /changed since it was read/);
  assert.equal(loadStore().providers.fixture!.apiKey, provider.apiKey);
});

test("read-time snapshots reject intervening edits before writes and track read-only JSONC dependencies", async () => {
  const source = put("dependency.jsonc", '{"version":1}\n');
  const destination = put("destination.json", "original");
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const adapter = target(async function () {
    readJsoncObject(source);
    await gate;
    writeFileAtomic(destination, "computed-from-old-source");
    return { app: this.id, changed: [destination], notes: [] };
  });
  const operation = adapter.apply(provider);
  fs.writeFileSync(source, '{"version":2}\n');
  resume();
  await assert.rejects(operation, /changed since it was read/);
  assert.equal(fs.readFileSync(destination, "utf8"), "original");
  assert.equal(fs.existsSync(backupsDir), false);
});

test("read-then-write catches replacement even if the replacement has identical contents", async () => {
  const file = put("target.json", "original");
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const adapter = target(async function () {
    readTextIfExists(file);
    await gate;
    writeFileAtomic(file, "ours");
    return { app: this.id, changed: [file], notes: [] };
  });
  const operation = adapter.apply(provider);
  const replacement = put("replacement.json", "original");
  fs.renameSync(replacement, file);
  resume();
  await assert.rejects(operation, /changed since it was read/);
  assert.equal(fs.readFileSync(file, "utf8"), "original");
  assert.equal(fs.existsSync(backupsDir), false);
});

test("64-bit file IDs remain distinct beyond JavaScript number precision", () => {
  const first = put("large-id-a.json", "first");
  const second = put("large-id-b.json", "second");
  const ids = new Map([[first, 9007199254740992n], [second, 9007199254740993n]]);
  assert.equal(Number(ids.get(first)), Number(ids.get(second)), "ordinary stat numbers lose this distinction");
  const original = fs.lstatSync;
  mock.method(fs, "lstatSync", (file: fs.PathLike, options?: fs.StatOptions) => {
    const stat = original(file, options);
    const id = ids.get(String(file));
    if (id !== undefined) Object.defineProperty(stat, "ino", { value: options?.bigint ? id : Number(id) });
    return stat;
  });
  assert.deepEqual(commitFileChanges([
    { file: first, before: "first", after: "updated-first" },
    { file: second, before: "second", after: "updated-second" },
  ], { dryRun: true }).files, [first, second]);
});

test("scoped preview survives global switch changes without intercepting unrelated writes", async () => {
  const file = put("preview/config.json", "old");
  const created = path.join(sandbox, "preview/new/secret.json");
  const outside = path.join(sandbox, "outside.json");
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const adapter = target(async function () {
    backupFile(file);
    writeFileAtomic(file, "preview");
    await gate;
    ensureDir(path.dirname(created));
    writeFileAtomic(created, provider.apiKey);
    return { app: this.id, changed: [file, created], notes: [] };
  });
  setDryRun(true);
  const preview = adapter.apply(provider);
  setDryRun(false);
  writeFileAtomic(outside, "not in the adapter scope");
  resume();
  const result = await preview;
  assert.deepEqual(result.changed, [file, created]);
  assert.deepEqual(result.notes, []);
  assert.equal(fs.readFileSync(file, "utf8"), "old");
  assert.equal(fs.readFileSync(outside, "utf8"), "not in the adapter scope");
  assert.equal(fs.existsSync(path.dirname(created)), false);
  assert.equal(fs.existsSync(backupsDir), false);
  assert.deepEqual(drainPendingWrites(), [{ file, content: "preview" }, { file: created, content: provider.apiKey }]);
});

test("failed previews publish no partial write intents and successful previews create no filesystem paths", async () => {
  const file = path.join(sandbox, "absent/deep/config.json");
  setDryRun(true);
  const failing = target(async function () {
    writeFileAtomic(file, "preview");
    throw new Error("late validation failure");
  });
  await assert.rejects(failing.apply(provider), /late validation failure/);
  assert.deepEqual(drainPendingWrites(), []);
  const successful = target(async function () {
    writeFileAtomic(file, "preview");
    return { app: this.id, changed: [file], notes: [] };
  });
  await successful.apply(provider);
  saveStore({ version: 1, providers: {} });
  assert.deepEqual(fs.readdirSync(sandbox), []);
  assert.deepEqual(drainPendingWrites().map((write) => write.file), [file, configFile]);
});

test("store saves and configuration transactions use one fail-fast write lock", () => {
  const file = put("target.json", "before");
  const store: Store = { version: 1, providers: {} };
  const renameSync = fs.renameSync;
  let checked = false;
  mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === file) {
      checked = true;
      const owner = JSON.parse(fs.readFileSync(path.join(path.dirname(configFile), ".write.lock"), "utf8"));
      assert.equal(owner.pid, process.pid);
      assert.equal(new Date(owner.createdAt).toISOString(), owner.createdAt);
      assert.throws(() => saveStore(store), /write busy/);
      assert.throws(() => commitFileChanges([{ file: path.join(sandbox, "other.json"), before: undefined, after: "other" }]), /write busy/);
    }
    return renameSync(from, to);
  });
  commitFileChanges([{ file, before: "before", after: "after" }]);
  assert.equal(checked, true);
  assert.equal(fs.readFileSync(file, "utf8"), "after");
  assert.equal(fs.existsSync(configFile), false);
  assert.equal(fs.existsSync(path.join(path.dirname(configFile), ".write.lock")), false);
  saveStore(store);
  assert.deepEqual(loadStore().providers, {});
});

test("rollback restores originals and permissions, removes creations, and releases the lock", () => {
  const first = put("first.json", "original", 0o640);
  const removed = put("removed.json", "removed-original");
  const created = path.join(sandbox, "created/nested/file.json");
  const last = put("last.json", "last-original");
  const renameSync = fs.renameSync;
  mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === last) throw new Error("injected-private-marker");
    return renameSync(from, to);
  });
  assert.throws(() => commitFileChanges([
    { file: first, before: "original", after: "changed" },
    { file: removed, before: "removed-original", after: undefined },
    { file: created, before: undefined, after: "created" },
    { file: last, before: "last-original", after: "last-changed" },
  ]), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /previous writes rolled back/);
    assert.doesNotMatch(error.message, /injected-private-marker/);
    return true;
  });
  assert.equal(fs.readFileSync(first, "utf8"), "original");
  assert.equal(fs.readFileSync(removed, "utf8"), "removed-original");
  assert.equal(fs.readFileSync(last, "utf8"), "last-original");
  assert.equal(fs.existsSync(path.join(sandbox, "created")), false);
  assert.equal(fs.existsSync(path.join(path.dirname(configFile), ".write.lock")), false);
  if (process.platform !== "win32") assert.equal(fs.statSync(first).mode & 0o777, 0o640);
});

test("rollback refuses to overwrite a third-party intervening edit", () => {
  const first = put("first.json", "original");
  const last = put("last.json", "last-original");
  const renameSync = fs.renameSync;
  mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (String(to) === last) {
      fs.writeFileSync(first, "third-party edit");
      throw new Error("fixture failure");
    }
    return renameSync(from, to);
  });
  assert.throws(() => commitFileChanges([
    { file: first, before: "original", after: "changed" },
    { file: last, before: "last-original", after: "last-changed" },
  ]), /rollback incomplete/);
  assert.equal(fs.readFileSync(first, "utf8"), "third-party edit");
  assert.equal(fs.readFileSync(last, "utf8"), "last-original");
});

test("Codex leaves config.toml unchanged when auth.json fails late validation", async () => {
  const config = put(".codex/config.toml", 'model = "old"\n');
  put(".codex/auth.json", "{broken auth\n");
  const before = tree();
  await assert.rejects(codex.apply(provider));
  assert.deepEqual(tree(), before);
  assert.equal(fs.readFileSync(config, "utf8"), 'model = "old"\n');
  assert.equal(fs.existsSync(backupsDir), false);
});

test("WorkBuddy leaves models unchanged when settings.json is invalid", async () => {
  process.env.WORKBUDDY_CONFIG_DIR = path.join(sandbox, ".workbuddy");
  try {
    put(".workbuddy/models.json", '{"models":[],"availableModels":[]}\n');
    put(".workbuddy/settings.json", "{broken settings\n");
    const before = tree();
    await assert.rejects(workbuddy.apply(provider));
    assert.deepEqual(tree(), before);
    assert.equal(fs.existsSync(backupsDir), false);
  } finally {
    delete process.env.WORKBUDDY_CONFIG_DIR;
  }
});

test("concurrent targets do not capture or discard one another's staged writes", async () => {
  const first = put("first.json", "first-original");
  const second = put("second.json", "second-original");
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => { resume = resolve; });
  const failing = target(async function () {
    writeFileAtomic(first, "first-preview");
    await gate;
    throw new Error("first aborted");
  });
  const successful = target(async function () {
    writeFileAtomic(second, "second-committed");
    return { app: this.id, changed: [second], notes: [] };
  });
  const pending = failing.apply(provider);
  const result = await successful.apply(provider);
  resume();
  await assert.rejects(pending, /first aborted/);
  assert.deepEqual(result.changed, [second]);
  assert.equal(fs.readFileSync(first, "utf8"), "first-original");
  assert.equal(fs.readFileSync(second, "utf8"), "second-committed");
});

test("a crashed writer leaves identifiable ownership and an explicit safe recovery path", () => {
  const file = put("crash-target.json", "before");
  const transactionUrl = new URL("../src/config-transaction.ts", import.meta.url).href;
  const script = [
    'import fs from "node:fs";',
    `import { commitFileChanges } from ${JSON.stringify(transactionUrl)};`,
    // Terminate after acquiring the lock and preparing backups, before the first config write.
    "fs.renameSync = () => process.exit(73);",
    `commitFileChanges([{ file: ${JSON.stringify(file)}, before: "before", after: "after" }]);`,
  ].join("\n");
  const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type", "module", "-e", script], {
    cwd: path.dirname(fileURLToPath(new URL("../package.json", import.meta.url))),
    env: { ...process.env, HOME: sandbox, AGENTSW_HOME: sandbox },
    encoding: "utf8",
  });
  assert.equal(child.status, 73, child.stderr || child.error?.message);
  const lock = path.join(path.dirname(configFile), ".write.lock");
  const text = fs.readFileSync(lock, "utf8");
  const owner = JSON.parse(text);
  assert.equal(owner.pid, child.pid);
  assert.equal(new Date(owner.createdAt).toISOString(), owner.createdAt);
  const changes = [{ file, before: "before", after: "after" }];
  assert.throws(() => commitFileChanges(changes), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /previous writer may have crashed/);
    assert.match(error.message, /stop all agentsw writers/);
    assert.match(error.message, /manually remove/);
    assert.ok(error.message.includes(String(child.pid)));
    assert.ok(error.message.includes(lock));
    return true;
  });
  assert.equal(fs.readFileSync(file, "utf8"), "before");
  assert.equal(fs.readFileSync(lock, "utf8"), text);
  // The fixture owner has exited and no other writers exist: model the diagnosed manual recovery.
  fs.unlinkSync(lock);
  commitFileChanges(changes);
  assert.equal(fs.readFileSync(file, "utf8"), "after");
  assert.equal(fs.existsSync(lock), false);
});

for (const [kind, content] of [
  ["empty", ""],
  ["malformed", "fake-lock-secret-marker"],
  ["invalid owner", '{"pid":0,"createdAt":"invalid"}'],
] as const) {
  test(`an existing unknown lock is not stolen (${kind})`, () => {
    const file = put("target.json", "before");
    const lock = put(path.relative(sandbox, path.join(path.dirname(configFile), ".write.lock")), content);
    assert.throws(() => commitFileChanges([{ file, before: "before", after: "after" }]), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /owner metadata is missing or unreadable/);
      assert.match(error.message, /confirm this lock is abandoned/);
      assert.match(error.message, /manually remove/);
      assert.doesNotMatch(error.message, /fake-lock-secret-marker/);
      return true;
    });
    assert.equal(fs.readFileSync(lock, "utf8"), content);
    assert.equal(fs.readFileSync(file, "utf8"), "before");
    assert.equal(fs.existsSync(backupsDir), false);
  });
}

test("an old lock owned by a running process is never treated as stale by age", () => {
  const file = put("target.json", "before");
  const content = JSON.stringify({ pid: process.pid, createdAt: "2000-01-01T00:00:00.000Z" });
  const lock = put(path.relative(sandbox, path.join(path.dirname(configFile), ".write.lock")), content);
  assert.throws(() => commitFileChanges([{ file, before: "before", after: "after" }]), /is running.*do not remove an active lock/);
  assert.equal(fs.readFileSync(lock, "utf8"), content);
  assert.equal(fs.readFileSync(file, "utf8"), "before");
  assert.equal(fs.existsSync(backupsDir), false);
});
