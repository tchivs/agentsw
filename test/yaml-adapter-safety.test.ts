import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import YAML from "yaml";
import type { Provider } from "../src/types.js";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agentsw-yaml-safety-"));
process.env.HOME = sandbox;
process.env.AGENTSW_HOME = sandbox;
process.env.USERPROFILE = sandbox;
process.env.APPDATA = path.join(sandbox, "AppData", "Roaming");
process.env.LOCALAPPDATA = path.join(sandbox, "AppData", "Local");
for (const name of ["HERMES_HOME", "DSH_HOME", "WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR", "PI_CODING_AGENT_DIR", "PRIME_AGENT_CODING_AGENT_DIR", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG"]) delete process.env[name];
for (const name of Object.keys(process.env)) {
  if (/^AGENTSW_.*_API_KEY$/.test(name)) delete process.env[name];
}
delete process.env.EXTERNAL_TEST_KEY;

// These imports must follow the sandbox environment: fsutil captures home.
const { dsh } = await import("../src/targets/dsh.js");
const { hermes } = await import("../src/targets/hermes.js");
const { managedCredentialRef, legacyManagedCredentialRef } = await import("../src/provider-identity.js");
const { envAssignments, upsertEnvAssignment } = await import("../src/envfile.js");
const { setDryRun, drainPendingWrites } = await import("../src/fsutil.js");

const provider: Provider = {
  id: "foo-bar", name: "Fixture provider", protocol: "openai", baseUrl: "https://fixture.example/v1",
  apiKey: "fixture-fake-key-a", models: [{ id: "model-a", contextWindow: 32000 }], defaultModel: "model-a",
};

beforeEach(() => {
  setDryRun(false);
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.mkdirSync(sandbox);
  delete process.env.HERMES_HOME;
  delete process.env.DSH_HOME;
});
after(() => {
  setDryRun(false);
  fs.rmSync(sandbox, { recursive: true, force: true });
});

function put(relative: string, content: string | object): string {
  const file = path.join(sandbox, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === "string" ? content : YAML.stringify(content), { mode: 0o600 });
  return file;
}
function text(relative: string): string { return fs.readFileSync(path.join(sandbox, relative), "utf8"); }
function config(relative: string): any { return YAML.parse(text(relative)); }
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

const adapters = [
  { target: dsh, settings: ".dsh/settings.yaml", credentials: ".dsh/.credentials.yaml", keyField: "apiKeyEnv" },
  { target: hermes, settings: ".hermes/config.yaml", credentials: ".hermes/.env", keyField: "key_env" },
];
function providers(adapter: typeof adapters[number]): Record<string, any> {
  const doc = config(adapter.settings);
  return adapter.target.id === "dsh" ? doc["llm-pi-ai"]?.providers ?? {} : doc.providers ?? {};
}
function credentialValues(adapter: typeof adapters[number]): Record<string, string> {
  return adapter.target.id === "dsh" ? config(adapter.credentials).refs ?? {} : Object.fromEntries(envAssignments(adapter.credentials, text(adapter.credentials)).map((assignment) => [assignment.name, assignment.value]));
}
function seed(adapter: typeof adapters[number], routes: Record<string, object>, refs: Record<string, string>): void {
  put(adapter.settings, adapter.target.id === "dsh" ? { "llm-pi-ai": { providers: routes } } : { providers: routes });
  put(adapter.credentials, adapter.target.id === "dsh" ? { version: 1, refs } : Object.entries(refs).map(([ref, value]) => `${ref}=${value}\n`).join(""));
}

for (const adapter of adapters) {
  test(`${adapter.target.id}: sanitized ID collisions retain distinct credentials through prune`, async () => {
    const other = { ...provider, id: "foo_bar", apiKey: "fixture-fake-key-b" };
    await adapter.target.apply(provider);
    await adapter.target.apply(other);
    const a = managedCredentialRef(provider.id);
    const b = managedCredentialRef(other.id);
    assert.notEqual(a, b);
    assert.equal(providers(adapter)[provider.id][adapter.keyField], a);
    assert.equal(providers(adapter)[other.id][adapter.keyField], b);
    assert.equal(credentialValues(adapter)[a], provider.apiKey);
    assert.equal(credentialValues(adapter)[b], other.apiKey);
    await adapter.target.prune(provider);
    assert.equal(credentialValues(adapter)[a], undefined);
    assert.equal(credentialValues(adapter)[b], other.apiKey);
    assert.equal(adapter.target.candidates!().find((candidate) => candidate.id === other.id)?.apiKey, other.apiKey);
  });

  test(`${adapter.target.id}: legacy shared references survive migration and prune until unused`, async () => {
    const legacy = legacyManagedCredentialRef(provider.id);
    seed(adapter, { [provider.id]: { [adapter.keyField]: legacy }, foo_bar: { [adapter.keyField]: legacy } }, { [legacy]: "fixture-shared-key" });
    await adapter.target.apply(provider);
    assert.equal(credentialValues(adapter)[legacy], "fixture-shared-key");
    assert.equal(providers(adapter).foo_bar[adapter.keyField], legacy);
    await adapter.target.prune(provider);
    assert.equal(credentialValues(adapter)[legacy], "fixture-shared-key");
    await adapter.target.apply({ ...provider, id: "foo_bar", apiKey: "fixture-fake-key-b" });
    assert.equal(credentialValues(adapter)[legacy], undefined);
    assert.equal(credentialValues(adapter)[managedCredentialRef("foo_bar")], "fixture-fake-key-b");
  });

  test(`${adapter.target.id}: prune leaves an external credential untouched`, async () => {
    seed(adapter, { [provider.id]: { [adapter.keyField]: "EXTERNAL_TEST_KEY" } }, { EXTERNAL_TEST_KEY: "fixture-external-key" });
    await adapter.target.prune(provider);
    assert.equal(credentialValues(adapter).EXTERNAL_TEST_KEY, "fixture-external-key");
  });

  test(`${adapter.target.id}: a shared canonical credential cannot be overwritten`, async () => {
    const ref = managedCredentialRef(provider.id);
    seed(adapter, { [provider.id]: { [adapter.keyField]: ref }, keep: { [adapter.keyField]: ref } }, { [ref]: "fixture-shared-key" });
    const before = snapshot();
    await assert.rejects(() => adapter.target.apply(provider), /shared by another provider/);
    assert.deepEqual(snapshot(), before);
    await adapter.target.prune(provider);
    assert.equal(credentialValues(adapter)[ref], "fixture-shared-key");
  });

  test(`${adapter.target.id}: malformed settings prune never deletes credentials`, async () => {
    seed(adapter, {}, { [managedCredentialRef(provider.id)]: provider.apiKey });
    put(adapter.settings, "providers: [broken\n");
    const before = snapshot();
    await assert.rejects(() => adapter.target.prune(provider), /invalid YAML/);
    assert.deepEqual(snapshot(), before);
  });

  test(`${adapter.target.id}: aliased provider changes and anchor deletion do not mutate survivors`, async () => {
    const lines = adapter.target.id === "dsh"
      ? ["# settings comment", "llm-pi-ai:", "  providers:", "    foo-bar: &route", "      displayName: Existing", "      api: openai-responses", "      baseURL: https://old.example/v1", "      headers: { X-Fixture: keep } # custom comment", "      models: [{ id: model-a, compat: { keep: true } }]", "    survivor: *route # alias comment"]
      : ["# settings comment", "providers:", "  foo-bar: &route", "    name: Existing", "    api: https://old.example/v1", "    transport: codex_responses", "    options: { keep: true } # custom comment", "    models:", "      model-a:", "        note: keep # model comment", "  survivor: *route # alias comment"];
    put(adapter.settings, lines.join("\n") + "\n");
    const before = providers(adapter).survivor;
    await adapter.target.apply(provider);
    assert.deepEqual(providers(adapter).survivor, before);
    assert.match(text(adapter.settings), /# settings comment/);
    assert.match(text(adapter.settings), /# custom comment/);
    assert.match(text(adapter.settings), /# alias comment/);
    if (adapter.target.id === "hermes") assert.match(text(adapter.settings), /# model comment/);
    await adapter.target.prune(provider);
    assert.deepEqual(providers(adapter).survivor, before);
  });

  test(`${adapter.target.id}: cycles and unresolved aliases reject before any output`, async () => {
    for (const invalid of ["loop: &loop { next: *loop }\n", "route: *missing\n", "[]\n"]) {
      put(adapter.settings, invalid);
      const before = snapshot();
      await assert.rejects(() => adapter.target.apply(provider), /invalid YAML/);
      await assert.rejects(() => adapter.target.prune(provider), /invalid YAML/);
      assert.deepEqual(snapshot(), before);
    }
  });

  test(`${adapter.target.id}: dry-run stages settings and credentials without files or backups`, async () => {
    setDryRun(true);
    try {
      const before = snapshot();
      await adapter.target.apply(provider);
      assert.deepEqual(snapshot(), before);
      const writes = drainPendingWrites();
      assert.deepEqual(new Set(writes.map((write) => write.file)), new Set([path.join(sandbox, adapter.settings), path.join(sandbox, adapter.credentials)]));
    } finally { setDryRun(false); }
  });
}

test("dsh: future credential versions reject apply and prune without settings changes", async () => {
  const adapter = adapters[0]!;
  seed(adapter, { [provider.id]: { apiKeyEnv: managedCredentialRef(provider.id) } }, {});
  put(adapter.credentials, { version: 2, refs: { [managedCredentialRef(provider.id)]: provider.apiKey } });
  const before = snapshot();
  await assert.rejects(() => dsh.apply(provider), /declares version 2/);
  assert.deepEqual(snapshot(), before);
  await assert.rejects(() => dsh.prune(provider), /declares version 2/);
  assert.deepEqual(snapshot(), before);
});

test("dsh: malformed credentials and ambiguous unversioned layouts do not alter settings", async () => {
  put(".dsh/settings.yaml", "# untouched\nllm-pi-ai: { providers: {} }\n");
  for (const invalid of ["refs: { KEEP: fixture-key }\n", "version: 1\nrefs: []\n", "version: 1\nrefs: { KEY: { nested: fixture-key } }\n", "refs: [broken\n"]) {
    put(".dsh/.credentials.yaml", invalid);
    const before = snapshot();
    await assert.rejects(() => dsh.apply(provider));
    await assert.rejects(() => dsh.prune(provider));
    assert.deepEqual(snapshot(), before);
  }
});

test("dsh: flat credential migration retains values, comments and independent aliases", async () => {
  put(".dsh/.credentials.yaml", "# credential comment\nKEEP: &key fixture-old # keep comment\nSHARED: *key\n");
  await dsh.apply(provider);
  const credentials = config(".dsh/.credentials.yaml");
  assert.equal(credentials.version, 1);
  assert.equal(credentials.refs.KEEP, "fixture-old");
  assert.equal(credentials.refs.SHARED, "fixture-old");
  assert.equal(credentials.refs[managedCredentialRef(provider.id)], provider.apiKey);
  assert.match(text(".dsh/.credentials.yaml"), /credential comment/);
  assert.match(text(".dsh/.credentials.yaml"), /keep comment/);
});

test("dsh: updating an anchored credential does not change an aliased credential", async () => {
  const ref = managedCredentialRef(provider.id);
  put(".dsh/.credentials.yaml", `version: 1\nrefs:\n  ${ref}: &key fixture-old\n  SHARED: *key # retained alias\n`);
  await dsh.apply(provider);
  assert.equal(config(".dsh/.credentials.yaml").refs[ref], provider.apiKey);
  assert.equal(config(".dsh/.credentials.yaml").refs.SHARED, "fixture-old");
  assert.match(text(".dsh/.credentials.yaml"), /retained alias/);
});

test("dsh: existing settings.json remains the selected format and retains Responses", async () => {
  put(".dsh/settings.json", JSON.stringify({ "llm-pi-ai": { providers: { [provider.id]: { api: "openai-responses", models: [] } } }, custom: { keep: true } }));
  await dsh.apply(provider);
  const settings = JSON.parse(text(".dsh/settings.json"));
  assert.equal(settings["llm-pi-ai"].providers[provider.id].api, "openai-responses");
  assert.equal(settings.custom.keep, true);
  assert.equal(fs.existsSync(path.join(sandbox, ".dsh/settings.yaml")), false);
});

test("Hermes: exported quoted key updates preserve multiline lookalikes and comments", async () => {
  const ref = managedCredentialRef(provider.id);
  const kept = `# keep comment\nOTHER="first\n${ref}=inside-the-value\nlast"\n`;
  put(".hermes/.env", kept + ` export ${ref} = "fixture-old" # managed comment\n`);
  const key = "fixture key # with spaces";
  await hermes.apply({ ...provider, apiKey: key });
  assert.ok(text(".hermes/.env").startsWith(kept));
  assert.match(text(".hermes/.env"), /# managed comment/);
  assert.equal(envAssignments("fixture.env", text(".hermes/.env")).filter((assignment) => assignment.name === ref).length, 1);
  assert.equal(hermes.candidates!()[0]?.apiKey, key);
  await hermes.prune(provider);
  assert.equal(text(".hermes/.env"), kept);
});

test("Hermes: multiline managed assignments are updated and removed as whole values", async () => {
  const ref = managedCredentialRef(provider.id);
  put(".hermes/.env", `export ${ref}='fixture\nold-key' # retain\nKEEP=fixture-keep\n`);
  await hermes.apply(provider);
  assert.equal(envAssignments("fixture.env", text(".hermes/.env")).find((assignment) => assignment.name === ref)?.value, provider.apiKey);
  assert.equal(text(".hermes/.env").includes("old-key"), false);
  await hermes.prune(provider);
  assert.equal(text(".hermes/.env"), "KEEP=fixture-keep\n");
});

test("Hermes: malformed quoted dotenv input rejects apply and prune atomically", async () => {
  await hermes.apply(provider);
  for (const invalid of ['BROKEN="fixture-value" unexpected\n', 'BROKEN="unterminated\n', "export BAD NAME=fixture-key\n"]) {
    put(".hermes/.env", invalid);
    const before = snapshot();
    await assert.rejects(() => hermes.apply(provider), /invalid environment configuration/);
    await assert.rejects(() => hermes.prune(provider), /invalid environment configuration/);
    assert.deepEqual(snapshot(), before);
  }
});

test("Hermes: unspecified transport retains Responses and explicit completion overrides it", async () => {
  put(".hermes/config.yaml", { providers: { [provider.id]: { transport: "codex_responses", options: { keep: true }, models: {} } } });
  await hermes.apply(provider);
  assert.equal(config(".hermes/config.yaml").providers[provider.id].transport, "codex_responses");
  assert.equal(hermes.candidates!()[0]?.openaiApi, "responses");
  await hermes.apply({ ...provider, openaiApi: "completions" });
  assert.equal(config(".hermes/config.yaml").providers[provider.id].transport, "chat_completions");
  assert.equal(config(".hermes/config.yaml").providers[provider.id].options.keep, true);
});

test("dotenv: quoted, exported and escaped key values round-trip without ambiguity", () => {
  const ref = managedCredentialRef(provider.id);
  for (const value of ["fixture-key", "fixture # key", "fixture\nkey", "fixture'\"\\nkey", ""]) {
    const updated = upsertEnvAssignment("fixture.env", "KEEP='fixture-keep'\r\n", ref, value);
    assert.equal(envAssignments("fixture.env", updated).find((assignment) => assignment.name === ref)?.value, value);
    assert.ok(updated.startsWith("KEEP='fixture-keep'\r\n"));
  }
});
