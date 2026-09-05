import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse } from "jsonc-parser";
import type { ParseError } from "jsonc-parser";
import type { Provider } from "../src/types.js";

// fsutil captures home at import time; never import an adapter before sandboxing it.
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agentsw-pistyle-jsonc-"));
process.env.HOME = sandbox;
process.env.AGENTSW_HOME = sandbox;
delete process.env.PI_CODING_AGENT_DIR;
delete process.env.PRIME_AGENT_CODING_AGENT_DIR;
const { pi, prime } = await import("../src/targets/pistyle.js");
const { backupsDir, drainPendingWrites, readJsonIfExists, setDryRun } = await import("../src/fsutil.js");
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const provider: Provider = {
  id: "jsonc",
  name: "JSONC Provider",
  protocol: "openai",
  baseUrl: "https://new.example/v1",
  apiKey: "sk-fixture-jsonc",
  defaultModel: "model-a",
  models: [{ id: "model-a", name: "Model A", reasoning: false }],
};

const modelsSource = '\uFEFF' + `// Synchronised models; retain this header.
{
  // model root comment
  "custom": { "help": "https://example.test/docs//v1/*literal*/", "flag": true },
  "providers": {
    // other provider comment
    "keep": {
      "baseUrl": "https://keep.example/v1", "api": "openai-completions", "apiKey": "sk-fixture-keep",
      "models": [{ "id": "keep-m", "hint": "// literal /* value" }],
    },
    /* managed provider comment */
    "jsonc": {
      "name": "Old name", "baseUrl": "https://old.example/v1", "apiKey": "sk-fixture-old", "api": "openai-completions",
      "headers": { "X-Custom": "https://headers.example//literal/*value*/" },
      /* provider extension comment */
      "oauth": { "enabled": true },
      "models": [
        // retained model comment
        {
          "id": "model-a", "name": "Old A", "reasoning": true,
          /* removed owned field comment */
          "thinkingLevelMap": { "high": "high" }, "contextWindow": 5,
          "compat": { "supportsStore": false },
        },
        // removed model comment
        { "id": "stale", "hint": true },
      ],
    },
  },
}
`;
const settingsSource = '\uFEFF' + `// Synchronised settings; retain this header.
{
  // default provider comment
  "defaultProvider": "keep",
  /* default model comment */
  "defaultModel": "keep-m",
  "theme": "dark", // theme comment
  "ui": { /* nested UI comment */ "help": "https://ui.example//path/*literal*/" },
}
`;
const modelComments = [
  "// Synchronised models; retain this header.", "// model root comment", "// other provider comment",
  "/* managed provider comment */", "/* provider extension comment */", "// retained model comment",
  "/* removed owned field comment */", "// removed model comment",
];
const settingsComments = [
  "// Synchronised settings; retain this header.", "// default provider comment", "/* default model comment */",
  "// theme comment", "/* nested UI comment */",
];

function fixture(id: string, models?: string, settings?: string) {
  const dir = fs.mkdtempSync(path.join(sandbox, `${id}-`));
  process.env[id === "pi" ? "PI_CODING_AGENT_DIR" : "PRIME_AGENT_CODING_AGENT_DIR"] = dir;
  const modelsFile = path.join(dir, "models.json");
  const settingsFile = path.join(dir, "settings.json");
  if (models !== undefined) fs.writeFileSync(modelsFile, models);
  if (settings !== undefined) fs.writeFileSync(settingsFile, settings);
  return { modelsFile, settingsFile };
}

function parsed(text: string) {
  const errors: ParseError[] = [];
  const value = parse(text.replace(/^\uFEFF/, ""), errors, { allowTrailingComma: true });
  assert.deepEqual(errors, [], "output must be valid JSONC, not a partially recovered parse");
  return value;
}

function read(file: string): string {
  return fs.readFileSync(file, "utf8");
}

function assertComments(text: string, expected: string[]): void {
  for (const comment of expected) {
    assert.equal(text.split(comment).length - 1, 1, `comment must survive exactly once: ${comment}`);
  }
}

function backupNames(): string[] {
  return fs.existsSync(backupsDir) ? fs.readdirSync(backupsDir).sort() : [];
}

for (const target of [pi, prime]) {
  test(`${target.id} reads JSONC defaults and import candidates without touching files`, () => {
    const files = fixture(target.id, modelsSource, settingsSource);
    assert.equal(target.current(), "keep · keep-m");
    const candidates = target.candidates!();
    assert.equal(candidates.length, 2);
    assert.equal(candidates.find((item) => item.id === "keep")?.defaultModel, "keep-m");
    const imported = candidates.find((item) => item.id === provider.id)!;
    assert.equal(imported.baseUrl, "https://old.example/v1");
    assert.deepEqual(imported.models, ["model-a", "stale"]);
    assert.equal(imported.apiKey, "sk-fixture-old");
    assert.equal(read(files.modelsFile), modelsSource);
    assert.equal(read(files.settingsFile), settingsSource);
    assert.throws(() => readJsonIfExists(files.modelsFile), SyntaxError, "other targets retain strict JSON parsing");
  });

  test(`${target.id} applies and prunes JSONC while retaining unknown fields and every comment`, async () => {
    const files = fixture(target.id, modelsSource, settingsSource);
    const result = await target.apply(provider);
    assert.deepEqual(result.changed, [files.modelsFile, files.settingsFile]);
    const backups = result.notes.filter((note) => note.startsWith("backup: ")).map((note) => note.slice(8));
    assert.equal(backups.length, 2);
    assert.equal(read(backups[0]!), modelsSource);
    assert.equal(read(backups[1]!), settingsSource);
    const modelsText = read(files.modelsFile);
    const settingsText = read(files.settingsFile);
    assert.ok(modelsText.startsWith("\uFEFF// Synchronised"));
    assert.ok(settingsText.startsWith("\uFEFF// Synchronised"));
    assertComments(modelsText, modelComments);
    assertComments(settingsText, settingsComments);
    const models = parsed(modelsText);
    const entry = models.providers.jsonc;
    assert.equal(entry.baseUrl, provider.baseUrl);
    assert.equal(entry.apiKey, provider.apiKey);
    assert.equal(entry.name, provider.name);
    assert.deepEqual(entry.headers, parsed(modelsSource).providers.jsonc.headers);
    assert.deepEqual(entry.oauth, { enabled: true });
    assert.deepEqual(models.custom, parsed(modelsSource).custom);
    assert.deepEqual(models.providers.keep, parsed(modelsSource).providers.keep);
    assert.deepEqual(entry.models, [{
      id: "model-a", name: "Model A", reasoning: false, compat: { supportsStore: false }, input: ["text"],
    }]);
    const settings = parsed(settingsText);
    assert.equal(settings.defaultProvider, provider.id);
    assert.equal(settings.defaultModel, provider.defaultModel);
    assert.deepEqual(settings.ui, parsed(settingsSource).ui);
    assert.equal(settings.theme, "dark");
    assert.equal(target.current(), "jsonc · model-a");
    assert.equal(target.candidates!().find((item) => item.id === "jsonc")?.defaultModel, "model-a");

    await target.apply(provider);
    assert.equal(read(files.modelsFile), modelsText, "re-sync should not reformat unchanged content");
    assert.equal(read(files.settingsFile), settingsText);
    const pruned = await target.prune(provider);
    assert.deepEqual(pruned.changed, [files.modelsFile, files.settingsFile]);
    const remainingModels = parsed(read(files.modelsFile));
    const remainingSettings = parsed(read(files.settingsFile));
    assert.equal(remainingModels.providers.jsonc, undefined);
    assert.deepEqual(remainingModels.providers.keep, parsed(modelsSource).providers.keep);
    assert.deepEqual(remainingModels.custom, parsed(modelsSource).custom);
    assert.deepEqual(remainingSettings, { theme: "dark", ui: settings.ui });
    assertComments(read(files.modelsFile), modelComments);
    assertComments(read(files.settingsFile), settingsComments);
    assert.equal(target.current(), undefined);
    assert.deepEqual(target.candidates!().map((item) => item.id), ["keep"]);
    assert.ok((await target.prune(provider)).skipped);
  });

  test(`${target.id} initializes absent files and empties trailing-comma objects safely`, async () => {
    let files = fixture(target.id);
    assert.equal(target.current(), undefined);
    assert.deepEqual(target.candidates!(), []);
    assert.ok((await target.prune(provider)).skipped);
    assert.equal(fs.existsSync(files.modelsFile), false);
    assert.equal(fs.existsSync(files.settingsFile), false);
    await target.apply(provider);
    assert.equal(JSON.parse(read(files.modelsFile)).providers.jsonc.baseUrl, provider.baseUrl);
    assert.equal(JSON.parse(read(files.settingsFile)).defaultProvider, provider.id);
    await target.prune(provider);
    assert.deepEqual(parsed(read(files.modelsFile)), { providers: {} });
    assert.deepEqual(parsed(read(files.settingsFile)), {});

    files = fixture(target.id,
      '{ "providers": { /* last provider */ "jsonc": { "models": [], }, }, }\n',
      '{ // last defaults\n "defaultProvider": "jsonc", "defaultModel": "model-a", }\n');
    await target.prune(provider);
    assert.deepEqual(parsed(read(files.modelsFile)), { providers: {} });
    assert.deepEqual(parsed(read(files.settingsFile)), {});
    assertComments(read(files.modelsFile), ["/* last provider */"]);
    assertComments(read(files.settingsFile), ["// last defaults"]);
  });

  test(`${target.id} prune leaves unrelated defaults byte-identical`, async () => {
    const files = fixture(target.id, modelsSource, settingsSource);
    const result = await target.prune(provider);
    assert.deepEqual(result.changed, [files.modelsFile]);
    assert.equal(read(files.settingsFile), settingsSource);
    assert.equal(target.current(), "keep · keep-m");
  });

  test(`${target.id} dry-run records JSONC edits without writes or backups`, async () => {
    const settings = settingsSource.replace('"defaultProvider": "keep"', '"defaultProvider": "jsonc"');
    const files = fixture(target.id, modelsSource, settings);
    const beforeBackups = backupNames();
    setDryRun(true);
    try {
      for (const operation of ["apply", "prune"] as const) {
        const result = await target[operation](provider);
        assert.equal(result.notes.some((note) => note.startsWith("backup: ")), false);
        const writes = drainPendingWrites();
        assert.deepEqual(writes.map((item) => item.file), [files.modelsFile, files.settingsFile]);
        assertComments(writes[0]!.content, modelComments);
        assertComments(writes[1]!.content, settingsComments);
        assert.equal(parsed(writes[0]!.content).providers.jsonc !== undefined, operation === "apply");
        assert.equal(parsed(writes[1]!.content).defaultProvider, operation === "apply" ? provider.id : undefined);
        assert.equal(read(files.modelsFile), modelsSource);
        assert.equal(read(files.settingsFile), settings);
        assert.deepEqual(backupNames(), beforeBackups);
      }
    } finally {
      setDryRun(false);
    }
  });

  test(`${target.id} rejects corrupt input before any file or backup changes`, async (t) => {
    const invalid = [
      ["missing comma", '{ "sentinel": "sk-do-not-echo" "broken": true }'],
      ["trailing garbage", '{ "sentinel": "sk-do-not-echo" } garbage'],
      ["unterminated comment", '{ "sentinel": "sk-do-not-echo" } /* unfinished'],
      ["null root", "null"], ["array root", "[]"], ["string root", '"sk-do-not-echo"'],
      ["number root", "42"], ["empty file", ""], ["comment-only file", "// Synchronised but empty\n"],
      ["BOM-only file", "\uFEFF"],
      ["duplicate nested key", '{ "custom": { "key": "sk-do-not-echo", "key": "other" } }'],
      ["duplicate array object key", '{ "custom": [{ "key": 1, "key": 2 }] }'],
      ["duplicate escaped key", '{ "custom": { "key": 1, "\\u006bey": 2 } }'],
    ] as const;
    for (const operation of ["apply", "prune"] as const) {
      for (const file of ["models", "settings"] as const) {
        const invalidShapes = file === "models"
          ? [
            ["invalid providers", '{ "providers": [] }'],
            ["invalid entry", '{ "providers": { "jsonc": null } }'],
            ["duplicate provider", '{ "providers": { "jsonc": {}, "jsonc": {} } }'],
          ]
          : [
            ["invalid default", '{ "defaultProvider": {} }'],
            ["duplicate default", '{ "defaultProvider": "first", "defaultProvider": "last" }'],
          ];
        for (const [label, content] of [...invalid, ...invalidShapes]) {
          await t.test(`${operation} ${file}: ${label}`, async () => {
            const models = file === "models" ? content! : modelsSource;
            const settings = file === "settings" ? content! : settingsSource;
            const files = fixture(target.id, models, settings);
            const badFile = file === "models" ? files.modelsFile : files.settingsFile;
            const beforeBackups = backupNames();
            const diagnostic = (error: unknown): boolean => {
              assert.ok(error instanceof Error);
              assert.ok(error.message.includes(badFile), "diagnostic identifies the corrupt file");
              assert.match(error.message, /invalid JSONC|expected/);
              assert.equal(error.message.includes("sk-do-not-echo"), false);
              return true;
            };
            await assert.rejects(target[operation](provider), diagnostic);
            assert.throws(() => target.candidates!(), diagnostic);
            if (file === "settings") assert.throws(() => target.current(), diagnostic);
            assert.equal(read(files.modelsFile), models);
            assert.equal(read(files.settingsFile), settings);
            assert.deepEqual(backupNames(), beforeBackups);
            assert.deepEqual(drainPendingWrites(), []);
          });
        }
      }
    }
  });

  test(`${target.id} shrinks compact image inputs and model lists without corrupting JSONC`, async (t) => {
    const imageModel = { id: "model-a", input: ["text", "image"], compat: { supportsStore: false } };
    for (const models of [[imageModel], [imageModel, { id: "removed" }]]) {
      await t.test(models.length === 1 ? "imageInput true to false" : "compact model list shrink", async () => {
        const source = JSON.stringify({
          providers: {
            jsonc: { baseUrl: provider.baseUrl, api: "openai-completions", apiKey: provider.apiKey, models },
          },
          custom: "https://example.test//literal/*path*/",
        }).replace('"models":[', '"models":[/* compact model comment */')
          .replace('"input":["text","image"]', '"input":["text",/* compact input comment */"image"]');
        const files = fixture(target.id, source, settingsSource);
        await target.apply({ ...provider, models: [{ id: "model-a", imageInput: false }] });
        const output = parsed(read(files.modelsFile));
        assert.equal(output.providers.jsonc.models.length, 1);
        assert.deepEqual(output.providers.jsonc.models[0].input, ["text"]);
        assert.deepEqual(output.providers.jsonc.models[0].compat, imageModel.compat);
        assert.equal(output.custom, parsed(source).custom);
        assertComments(read(files.modelsFile), ["/* compact model comment */", "/* compact input comment */"]);
        assert.equal(parsed(read(files.settingsFile)).defaultProvider, provider.id);
      });
    }
  });

  test(`${target.id} corrupt settings cannot initialize missing models or bypass a no-op prune`, async () => {
    const corrupt = '{ "defaultProvider": "jsonc"';
    const files = fixture(target.id, undefined, corrupt);
    for (const operation of ["apply", "prune"] as const) {
      await assert.rejects(target[operation](provider), (error: unknown) =>
        error instanceof Error && error.message.includes(files.settingsFile));
      assert.equal(fs.existsSync(files.modelsFile), false);
      assert.equal(read(files.settingsFile), corrupt);
    }
  });
}
