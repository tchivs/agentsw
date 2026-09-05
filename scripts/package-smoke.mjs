import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentsw-package-"));
const home = path.join(root, "home");
const prefix = path.join(root, "installed");
const env = { ...process.env, HOME: home, USERPROFILE: home, AGENTSW_HOME: home, AGENTSW_LANG: "en" };
for (const key of ["PI_CODING_AGENT_DIR", "PRIME_AGENT_CODING_AGENT_DIR", "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG", "HERMES_HOME", "DSH_HOME", "WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR"]) delete env[key];
const windows = process.platform === "win32";
function run(command, args, extra = {}) {
  return execFileSync(command, args, {
    encoding: "utf8", env, timeout: 120000,
    ...(windows ? { shell: true } : {}), ...extra,
  });
}
try {
  fs.mkdirSync(path.join(home, ".config", "agentsw"), { recursive: true });
  // CLI smoke uses fresh local catalogs, never provider endpoints or metadata services.
  fs.writeFileSync(path.join(home, ".config", "agentsw", "models-dev.json"), "{}");
  fs.writeFileSync(path.join(home, ".config", "agentsw", "ai-gateway.json"), JSON.stringify({
    version: 1, fetchedAt: new Date().toISOString(), body: { data: [
      { id: "vendor/m1", type: "language", context_window: 4096, max_tokens: 512, pricing: { input: "0.000001" } },
    ] },
  }));
  const packed = JSON.parse(run(windows ? "npm.cmd" : "npm", ["pack", "--json", "--pack-destination", root]));
  const tarball = path.join(root, packed[0].filename);
  run(windows ? "npm.cmd" : "npm", ["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", tarball]);
  const bin = (name) => path.join(prefix, "node_modules", ".bin", name + (windows ? ".cmd" : ""));
  const expected = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
  for (const name of ["agentsw", "asw"]) assert.equal(run(bin(name), ["--version"]).trim(), expected);
  const cli = (...args) => run(bin("agentsw"), args);
  cli("add", "-y", "--id", "smoke", "--protocol", "openai", "--openai-api", "responses", "--base-url", "https://fixture.example/v1", "--api-key", "fixture-package-key", "--models", "m1,m2");
  const metadataText = cli("models", "--provider", "smoke", "--metadata");
  const audit = JSON.parse(metadataText);
  assert.equal(audit.metadataMode, "auto");
  assert.equal(audit.gatewayMetadata, "auto");
  assert.equal(audit.models.find((m) => m.id === "m1").metadata.fields.maxOutput.source, "ai-gateway");
  assert.equal(audit.models.find((m) => m.id === "m1").metadata.gateway.modelId, "vendor/m1");
  assert.ok(!metadataText.includes("fixture-package-key"));
  cli("use", "smoke", "--apps", "pi,omp,opencode");
  for (const file of [path.join(home, ".pi", "agent", "models.json"), path.join(home, ".omp", "agent", "models.yml"), path.join(home, ".config", "opencode", "opencode.json")]) {
    assert.doesNotMatch(fs.readFileSync(file, "utf8"), /"?metadata"?\s*:|referenceCost|fetchedAt|ai-gateway/);
  }
  const preview = cli("sync", "--apps", "pi,omp,opencode", "--dry-run");
  assert.ok(!preview.includes("fixture-package-key"));
  assert.match(cli("status"), /smoke/);
  cli("rename", "smoke", "renamed-smoke");
  cli("remove", "renamed-smoke", "--apps", "pi");
  const store = () => JSON.parse(fs.readFileSync(path.join(home, ".config", "agentsw", "config.json"), "utf8"));
  assert.ok(store().providers["renamed-smoke"]);
  assert.ok(!JSON.parse(fs.readFileSync(path.join(home, ".pi", "agent", "models.json"), "utf8")).providers?.["renamed-smoke"]);
  cli("remove", "renamed-smoke", "--prune");
  assert.equal(Object.keys(store().providers).length, 0);
  console.log(`Installed-package smoke passed on ${process.platform}: agentsw/asw, add, automatic Gateway metadata, use, preview, status, rename, scoped/global removal.`);
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
