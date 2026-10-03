import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

/**
 * Freezes the machine-readable contract of the global output flags. Every run is a real CLI process with a
 * stubbed catalog cache, so a passing test also proves no network call sneaks into a --json run.
 */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agentsw-output-flags-"));
const cli = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const storeFile = path.join(sandbox, ".config/agentsw/config.json");
const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8")) as { version: string };
const env: NodeJS.ProcessEnv = { ...process.env, HOME: sandbox, USERPROFILE: sandbox, AGENTSW_HOME: sandbox, AGENTSW_LANG: "en" };
// The suite pins NO_COLOR=1 (see test/setup.ts), but this file proves color behavior, so the
// child's color environment must be decided here and nowhere else.
for (const key of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "PI_CODING_AGENT_DIR", "PRIME_AGENT_CODING_AGENT_DIR", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG", "HERMES_HOME", "DSH_HOME", "WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR", "NO_COLOR"]) delete env[key];

function put(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}
function run(...args: string[]) {
  return spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { env, encoding: "utf8", timeout: 15000 });
}
const SECRET = "fixture-output-flags-secret";

beforeEach(() => {
  fs.rmSync(sandbox, { recursive: true, force: true });
  put(path.join(sandbox, ".config/agentsw/models-dev.json"), {});
  put(path.join(sandbox, ".config/agentsw/ai-gateway.json"), {
    version: 1, fetchedAt: new Date().toISOString(),
    body: { data: [{ id: "vendor/model", type: "language", context_window: 4096, max_tokens: 512 }] },
  });
  put(storeFile, { version: 1, language: "en", active: "example", providers: { example: {
    id: "example", name: "Example", protocol: "openai", openaiApi: "responses",
    baseUrl: "https://fixture.example/v1", apiKey: SECRET, defaultModel: "m1",
    models: [{ id: "m1" }], gatewayMetadata: true, gatewayModelAliases: { m1: "vendor/model" },
  } } });
});
after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

test("list --json emits exactly one envelope carrying no credential", () => {
  const result = run("list", "--json");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split("\n").length, 1, result.stdout);
  const doc = JSON.parse(result.stdout);
  assert.equal(doc.ok, true);
  assert.equal(doc.command, "list");
  assert.equal(doc.version, pkg.version);
  assert.equal(doc.data.active, "example");
  assert.deepEqual(doc.data.providers, [{
    id: "example", name: "Example", protocol: "openai",
    baseUrl: "https://fixture.example/v1", defaultModel: "m1", modelCount: 1,
  }]);
  assert.doesNotMatch(result.stdout, /apiKey|fixture-output-flags-secret/);
  assert.doesNotMatch(result.stdout, /\u001b\[/);
});

test("status --json stays parseable even before any app config exists", () => {
  const result = run("status", "--json");
  assert.equal(result.status, 0, result.stderr);
  const doc = JSON.parse(result.stdout);
  assert.equal(doc.ok, true);
  assert.equal(doc.command, "status");
  assert.equal(doc.data.active, "example");
  assert.equal(doc.data.configFile, storeFile);
  assert.ok(Array.isArray(doc.data.apps) && doc.data.apps.length > 0);
  assert.doesNotMatch(result.stdout, /apiKey|fixture-output-flags-secret/);
});

test("models --provider --metadata without --json keeps the legacy bare object", () => {
  const result = run("models", "--provider", "example", "--metadata");
  assert.equal(result.status, 0, result.stderr);
  const doc = JSON.parse(result.stdout);
  // Scripts (and the package smoke test) read this shape directly, so it must not grow an envelope.
  assert.equal(doc.ok, undefined);
  assert.equal(doc.provider, "example");
  assert.equal(doc.metadataMode, "on");
  assert.deepEqual(doc.gatewayModelAliases, { m1: "vendor/model" });
  assert.deepEqual(doc.models, [{ id: "m1" }]);
  assert.doesNotMatch(result.stdout, /apiKey|fixture-output-flags-secret|https:\/\/fixture\.example/);
});

test("models --metadata --json reports the missing provider as an error envelope", () => {
  const result = run("models", "--metadata", "--json");
  assert.equal(result.status, 1);
  const doc = JSON.parse(result.stdout);
  assert.equal(doc.ok, false);
  assert.equal(doc.command, "models");
  assert.match(doc.error.message, /--metadata requires --provider/);
  assert.equal(result.stderr.trim(), "");
});

test("bare --json refuses to open the menu instead of hanging on input", () => {
  const result = run("--json");
  assert.equal(result.status, 1);
  const doc = JSON.parse(result.stdout);
  assert.equal(doc.ok, false);
  assert.match(doc.error.message, /--json requires an explicit command/);
});

test("--no-color beats FORCE_COLOR whether it precedes or follows the command", () => {
  const args = ["add", "-y", "--id", "colored", "--protocol", "openai",
    "--base-url", "https://fixture.example/v1", "--api-key", SECRET, "--models", "m1"];
  const forced = spawnSync(process.execPath, ["--import", "tsx", cli, ...args], { env: { ...env, FORCE_COLOR: "1" }, encoding: "utf8", timeout: 15000 });
  assert.equal(forced.status, 0, forced.stderr);
  assert.match(forced.stdout, /\u001b\[/, "the fixture must actually produce color for this test to mean anything");
  for (const placement of [
    ["--no-color", ...args],
    [...args, "--no-color"],
  ]) {
    const plain = spawnSync(process.execPath, ["--import", "tsx", cli, ...placement], { env: { ...env, FORCE_COLOR: "1" }, encoding: "utf8", timeout: 15000 });
    assert.equal(plain.status, 0, plain.stderr);
    assert.doesNotMatch(plain.stdout, /\u001b\[/, `colored output with ${placement.join(" ")}`);
    assert.doesNotMatch(plain.stderr, /\u001b\[/, `colored diagnostics with ${placement.join(" ")}`);
  }
});

test("--quiet drops the next-step hint but keeps the saved result", () => {
  // The fixture account already owns this endpoint and key, so identity resolution updates it in place.
  const args = ["add", "-y", "--protocol", "openai",
    "--base-url", "https://fixture.example/v1", "--api-key", SECRET, "--models", "m1"];
  const loud = run(...args);
  assert.equal(loud.status, 0, loud.stderr);
  assert.match(loud.stderr, /next: agentsw use example/);
  assert.match(loud.stdout, /example/);

  const quiet = run(...args, "--quiet");
  assert.equal(quiet.status, 0, quiet.stderr);
  assert.equal(quiet.stderr.trim(), "");
  assert.match(quiet.stdout, /example/, "results survive --quiet");
});

test("--json --dry-run reveals file paths only, never staged content", () => {
  const result = run("use", "example", "--apps", "codex", "--dry-run", "--json");
  assert.equal(result.status, 0, result.stderr);
  const doc = JSON.parse(result.stdout);
  assert.equal(doc.ok, true);
  assert.equal(doc.command, "use");
  assert.equal(doc.data.provider, "example");
  assert.equal(doc.data.dryRun, true);
  assert.deepEqual(doc.data.apps, ["codex"]);
  assert.ok(doc.data.files.length > 0 && doc.data.files.every((file: string) => path.isAbsolute(file)), doc.data.files);
  assert.doesNotMatch(result.stdout, /apiKey|fixture-output-flags-secret|model_provider/);
  assert.equal(fs.existsSync(path.join(sandbox, ".codex/config.toml")), false, "a dry run must not write");
});
