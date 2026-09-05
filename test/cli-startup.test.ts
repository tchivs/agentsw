import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agentsw-cli-startup-"));
const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const storeFile = path.join(sandbox, ".config/agentsw/config.json");
const piFile = path.join(sandbox, ".pi/agent/models.json");
const env: NodeJS.ProcessEnv = { ...process.env, HOME: sandbox, USERPROFILE: sandbox, AGENTSW_HOME: sandbox };
for (const key of ["AGENTSW_LANG", "PI_CODING_AGENT_DIR", "PRIME_AGENT_CODING_AGENT_DIR", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG", "HERMES_HOME", "DSH_HOME", "WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR"]) delete env[key];
function put(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}
function run(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { env, encoding: "utf8", timeout: 15000 });
}
beforeEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  put(path.join(sandbox, ".config/agentsw/models-dev.json"), {});
  put(path.join(sandbox, ".config/agentsw/ai-gateway.json"), {
    version: 1, fetchedAt: new Date().toISOString(), body: { data: [
      { id: "vendor/model", type: "language", context_window: 4096, max_tokens: 512 },
    ] },
  });
  put(storeFile, "malformed fixture store");
  put(piFile, { providers: { orphan: { api: "openai-responses", baseUrl: "https://fixture.example/v1", apiKey: "fixture", models: [{ id: "m1" }] } } });
});
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

for (const flag of ["--help", "--version"]) {
  test(`${flag} works without a readable store or explicit language override`, () => {
    const result = run(flag);
    assert.equal(result.status, 0, result.stderr);
    assert.ok(result.stdout.length > 0);
    assert.equal(fs.readFileSync(storeFile, "utf8"), "malformed fixture store");
  });
}

test("agent-only list and removal ignore malformed central configuration", () => {
  const listed = run("list", "--apps", "pi");
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /orphan/);
  const removed = run("remove", "orphan", "--apps", "pi");
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(JSON.parse(fs.readFileSync(piFile, "utf8")).providers?.orphan, undefined);
  assert.equal(fs.readFileSync(storeFile, "utf8"), "malformed fixture store");
});

test("central operations still reject malformed stores instead of replacing them", () => {
  assert.equal(run("list").status, 1);
  assert.equal(fs.readFileSync(storeFile, "utf8"), "malformed fixture store");
});

test("omitted negated CLI flags retain persisted filter settings", () => {
  put(storeFile, { version: 1, language: "en", providers: { existing: {
    id: "existing", name: "Custom", protocol: "openai", openaiApi: "responses",
    baseUrl: "https://fixture.example/v1", apiKey: "fixture", defaultModel: "m1",
    models: [{ id: "m1" }, { id: "m1-latest" }], modelFilter: { dedup: false },
  } } });
  const result = run("add", "-y", "--protocol", "openai", "--base-url", "https://fixture.example/v1", "--api-key", "fixture", "--models", "m1,m1-latest");
  assert.equal(result.status, 0, result.stderr);
  const provider = JSON.parse(fs.readFileSync(storeFile, "utf8")).providers.existing;
  assert.equal(provider.modelFilter.dedup, false);
  assert.equal(provider.openaiApi, "responses");
});

test("Gateway CLI flags preserve omission, accept enable/disable, and expose credential-free metadata", () => {
  put(storeFile, { version: 1, language: "en", providers: { existing: {
    id: "existing", name: "Custom", protocol: "openai", openaiApi: "responses",
    baseUrl: "https://fixture.example/v1", apiKey: "fixture-secret", defaultModel: "m1",
    models: [{ id: "m1" }], gatewayMetadata: true, gatewayModelAliases: { m1: "vendor/model" },
  } } });
  const args = ["add", "-y", "--protocol", "openai", "--base-url", "https://fixture.example/v1", "--api-key", "fixture-secret", "--models", "m1"];
  for (const [flags, enabled] of [[[], true], [["--no-gateway-metadata"], false], [[], false], [["--gateway-metadata"], true]] as const) {
    const result = run(...args, ...flags);
    assert.equal(result.status, 0, result.stderr);
    const saved = JSON.parse(fs.readFileSync(storeFile, "utf8")).providers.existing;
    assert.equal(saved.gatewayMetadata, enabled);
    assert.deepEqual(saved.gatewayModelAliases, { m1: "vendor/model" });
    assert.equal(saved.models[0].maxOutput, 512);
    assert.equal(saved.openaiApi, "responses");
  }
  const audit = run("models", "--provider", "existing", "--metadata");
  assert.equal(audit.status, 0, audit.stderr);
  assert.equal(JSON.parse(audit.stdout).metadataMode, "on");
  assert.equal(JSON.parse(audit.stdout).models[0].metadata.gateway.modelId, "vendor/model");
  assert.doesNotMatch(audit.stdout, /fixture-secret|baseUrl|apiKey/);
  const cleared = run(...args, "--gateway-models", "{}");
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(storeFile, "utf8")).providers.existing.gatewayModelAliases, {});
});

for (const command of ["add", "quick", "discover", "import", "refresh"]) {
  for (const locale of ["en", "zh-CN"]) {
    test(`${command} help exposes metadata modes and legacy flags (${locale})`, () => {
      const result = run("--lang", locale, command, "--help");
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /--metadata-mode <auto\|on\|off>/);
      assert.match(result.stdout, /--gateway-metadata/);
      assert.match(result.stdout, /--no-gateway-metadata/);
      assert.match(result.stdout, /auto\s+\(default|auto（默认/);
      assert.match(result.stdout, /omission\s+keeps\s+saved\s+mode|省略则沿用已保存模式/);
      assert.equal(fs.readFileSync(storeFile, "utf8"), "malformed fixture store");
    });
  }
}

test("metadata defaults to auto and explicit modes persist through omitted flags", () => {
  put(storeFile, { version: 1, language: "en", providers: {} });
  const args = ["add", "-y", "--id", "automatic", "--protocol", "openai", "--base-url", "https://fixture.example/v1", "--api-key", "fixture-secret", "--models", "model"];
  for (const [flags, setting, mode] of [
    [[], undefined, "auto"],
    [["--metadata-mode", "on"], true, "on"],
    [[], true, "on"],
    [["--metadata-mode", "off"], false, "off"],
    [[], false, "off"],
    [["--metadata-mode", "auto"], "auto", "auto"],
    [[], "auto", "auto"],
  ] as const) {
    const result = run(...args, ...flags);
    assert.equal(result.status, 0, result.stderr);
    const saved = JSON.parse(fs.readFileSync(storeFile, "utf8")).providers.automatic;
    assert.equal(saved.gatewayMetadata, setting);
    assert.equal(saved.models[0].id, "model");
    assert.equal(saved.models[0].maxOutput, 512);
    assert.equal(saved.models[0].metadata.gateway.modelId, "vendor/model");
    const audit = run("models", "--provider", "automatic", "--metadata");
    assert.equal(audit.status, 0, audit.stderr);
    assert.equal(JSON.parse(audit.stdout).metadataMode, mode);
    assert.equal(JSON.parse(audit.stdout).gatewayMetadata, setting ?? "auto");
    assert.doesNotMatch(audit.stdout, /fixture-secret|baseUrl|apiKey/);
  }
});

test("invalid or conflicting metadata mode flags reject without changing the store", () => {
  put(storeFile, { version: 1, language: "en", providers: {} });
  const before = fs.readFileSync(storeFile, "utf8");
  const args = ["add", "-y", "--id", "invalid", "--protocol", "openai", "--base-url", "https://fixture.example/v1", "--api-key", "fixture-secret", "--models", "model"];
  for (const flags of [
    ["--metadata-mode", "sometimes"],
    ["--metadata-mode", "auto", "--gateway-metadata"],
    ["--metadata-mode", "auto", "--no-gateway-metadata"],
    ["--metadata-mode", "on", "--no-gateway-metadata"],
    ["--metadata-mode", "off", "--gateway-metadata"],
  ]) {
    const result = run(...args, ...flags);
    assert.equal(result.status, 1, `${flags.join(" ")}: ${result.stderr}`);
    assert.match(result.stderr, /metadata/i);
    assert.doesNotMatch(result.stderr, /fixture-secret/);
    assert.equal(fs.readFileSync(storeFile, "utf8"), before);
  }
});

test("metadata JSON inspection requires a provider before any network lookup", () => {
  const result = run("models", "--metadata");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--metadata requires --provider/);
});
