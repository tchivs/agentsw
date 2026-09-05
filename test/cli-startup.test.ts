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
  put(path.join(sandbox, ".config/agentsw/models-dev.json"), {});
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
