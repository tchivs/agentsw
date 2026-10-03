import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agentsw-app-paths-"));
const envNames = [
  "HOME", "AGENTSW_HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
  "CLAUDE_CONFIG_DIR", "CODEX_HOME", "PI_CODING_AGENT_DIR", "PRIME_AGENT_CODING_AGENT_DIR",
  "HERMES_HOME", "DSH_HOME", "WORKBUDDY_CONFIG_DIR", "CODEBUDDY_CONFIG_DIR",
  "OPENCODE_CONFIG_DIR", "OPENCODE_CONFIG",
];
const originalEnv = new Map(envNames.map((key) => [key, process.env[key]]));
for (const key of envNames) delete process.env[key];
process.env.AGENTSW_HOME = sandbox;
process.env.HOME = sandbox;

// app-paths resolves through fsutil, which captures `home` at module load.
const {
  claudeDir, claudeSettingsFile, codexDir, codexConfigFile, codexAuthFile,
  piDir, piModelsFile, piSettingsFile, ompAgentDir, ompModelsFiles, ompConfigFiles,
  hermesDir, hermesConfigFile, hermesEnvFile, dshDir, dshSettingsFiles, dshSettingsFile, dshCredentialsFile,
  workbuddyDir, workbuddyModelsFile, workbuddySettingsFile,
  opencodeConfigDirs, opencodeConfigFiles, opencodePrimaryConfigFile, OPENCODE_CONFIG_FILENAMES,
} = await import("../src/app-paths.js");

after(() => {
  for (const [key, value] of originalEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  for (const key of envNames) delete process.env[key];
  process.env.AGENTSW_HOME = sandbox;
  process.env.HOME = sandbox;
});

test("defaults keep the documented per-app layout", () => {
  assert.equal(claudeDir(), path.join(sandbox, ".claude"));
  assert.equal(claudeSettingsFile(), path.join(sandbox, ".claude", "settings.json"));
  assert.equal(codexDir(), path.join(sandbox, ".codex"));
  assert.equal(codexConfigFile(), path.join(sandbox, ".codex", "config.toml"));
  assert.equal(codexAuthFile(), path.join(sandbox, ".codex", "auth.json"));
  assert.equal(piDir("pi"), path.join(sandbox, ".pi", "agent"));
  assert.equal(piModelsFile("pi"), path.join(sandbox, ".pi", "agent", "models.json"));
  assert.equal(piSettingsFile("pi"), path.join(sandbox, ".pi", "agent", "settings.json"));
  assert.equal(piDir("prime"), path.join(sandbox, ".prime", "agent"));
  assert.equal(ompAgentDir(), path.join(sandbox, ".omp", "agent"));
  assert.deepEqual(ompModelsFiles(), [
    path.join(sandbox, ".omp", "agent", "models.yml"),
    path.join(sandbox, ".omp", "agent", "models.yaml"),
  ]);
  assert.deepEqual(ompConfigFiles(), [
    path.join(sandbox, ".omp", "agent", "config.yml"),
    path.join(sandbox, ".omp", "agent", "config.yaml"),
  ]);
  assert.equal(hermesDir(), path.join(sandbox, ".hermes"));
  assert.equal(hermesConfigFile(), path.join(sandbox, ".hermes", "config.yaml"));
  assert.equal(hermesEnvFile(), path.join(sandbox, ".hermes", ".env"));
  assert.equal(dshDir(), path.join(sandbox, ".dsh"));
  assert.equal(dshCredentialsFile(), path.join(sandbox, ".dsh", ".credentials.yaml"));
  assert.equal(workbuddyDir(), path.join(sandbox, ".workbuddy"));
  assert.equal(workbuddyModelsFile(), path.join(sandbox, ".workbuddy", "models.json"));
  assert.equal(workbuddySettingsFile(), path.join(sandbox, ".workbuddy", "settings.json"));
});

test("the apps' own config-directory variables are honored, and empty values are ignored", () => {
  process.env.CLAUDE_CONFIG_DIR = path.join(sandbox, "claude-alt");
  process.env.CODEX_HOME = path.join(sandbox, "codex-alt");
  process.env.HERMES_HOME = path.join(sandbox, "hermes-alt");
  process.env.DSH_HOME = path.join(sandbox, "dsh-alt");
  process.env.WORKBUDDY_CONFIG_DIR = path.join(sandbox, "workbuddy-alt");
  process.env.PI_CODING_AGENT_DIR = path.join(sandbox, "pi-alt");
  process.env.PRIME_AGENT_CODING_AGENT_DIR = path.join(sandbox, "prime-alt");
  assert.equal(claudeSettingsFile(), path.join(sandbox, "claude-alt", "settings.json"));
  assert.equal(codexConfigFile(), path.join(sandbox, "codex-alt", "config.toml"));
  assert.equal(hermesDir(), path.join(sandbox, "hermes-alt"));
  assert.equal(dshDir(), path.join(sandbox, "dsh-alt"));
  assert.equal(workbuddyDir(), path.join(sandbox, "workbuddy-alt"));
  assert.equal(piDir("pi"), path.join(sandbox, "pi-alt"));
  assert.equal(piDir("prime"), path.join(sandbox, "prime-alt"));

  // CODEBUDDY_CONFIG_DIR is the legacy name and only applies when the current one is absent.
  delete process.env.WORKBUDDY_CONFIG_DIR;
  process.env.CODEBUDDY_CONFIG_DIR = path.join(sandbox, "codebuddy-alt");
  assert.equal(workbuddyDir(), path.join(sandbox, "codebuddy-alt"));
  process.env.WORKBUDDY_CONFIG_DIR = path.join(sandbox, "workbuddy-alt");
  assert.equal(workbuddyDir(), path.join(sandbox, "workbuddy-alt"), "the current variable wins over the legacy name");

  delete process.env.CODEBUDDY_CONFIG_DIR;
  for (const key of ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "HERMES_HOME", "DSH_HOME", "WORKBUDDY_CONFIG_DIR", "PI_CODING_AGENT_DIR"]) {
    process.env[key] = "   ";
  }
  assert.equal(claudeDir(), path.join(sandbox, ".claude"));
  assert.equal(codexDir(), path.join(sandbox, ".codex"));
  assert.equal(hermesDir(), path.join(sandbox, ".hermes"));
  assert.equal(dshDir(), path.join(sandbox, ".dsh"));
  assert.equal(workbuddyDir(), path.join(sandbox, ".workbuddy"));
  assert.equal(piDir("pi"), path.join(sandbox, ".pi", "agent"));
});

test("a leading tilde is expanded against the current home and relative values are kept", () => {
  process.env.CLAUDE_CONFIG_DIR = "~/.claude-custom";
  process.env.CODEX_HOME = "~/codex-custom";
  assert.equal(claudeDir(), path.join(sandbox, ".claude-custom"));
  assert.equal(codexConfigFile(), path.join(sandbox, "codex-custom", "config.toml"));

  process.env.CLAUDE_CONFIG_DIR = "relative/claude";
  assert.equal(claudeSettingsFile(), path.join("relative/claude", "settings.json"));
});

test("paths are resolved per call, so a later env change is visible immediately", () => {
  assert.equal(codexConfigFile(), path.join(sandbox, ".codex", "config.toml"));
  process.env.CODEX_HOME = path.join(sandbox, "later");
  assert.equal(codexConfigFile(), path.join(sandbox, "later", "config.toml"));
  delete process.env.CODEX_HOME;
  assert.equal(codexConfigFile(), path.join(sandbox, ".codex", "config.toml"));
});

test("dsh settings prefer an existing file in the documented order", () => {
  const dir = dshDir();
  fs.mkdirSync(dir, { recursive: true });
  assert.equal(dshSettingsFile(), path.join(dir, "settings.yaml"), "no file yet -> the creation default");
  fs.writeFileSync(path.join(dir, "settings.json"), "{}\n");
  assert.equal(dshSettingsFile(), path.join(dir, "settings.json"), "yaml absent -> the existing json is kept");
  fs.writeFileSync(path.join(dir, "settings.yml"), "{}\n");
  assert.equal(dshSettingsFile(), path.join(dir, "settings.yml"), "yml wins over json");
  fs.writeFileSync(path.join(dir, "settings.yaml"), "{}\n");
  assert.equal(dshSettingsFile(), path.join(dir, "settings.yaml"), "yaml wins over yml and json");
});

test("opencode resolves directories, filenames and the explicit file predictably", () => {
  const fallback = path.join(sandbox, ".config", "opencode");
  assert.deepEqual(OPENCODE_CONFIG_FILENAMES, ["opencode.json", "opencode.jsonc", "config.json"]);
  assert.deepEqual(opencodeConfigDirs(), [fallback]);
  assert.deepEqual(opencodeConfigFiles(), [
    path.join(fallback, "opencode.json"),
    path.join(fallback, "opencode.jsonc"),
    path.join(fallback, "config.json"),
  ]);
  assert.equal(opencodePrimaryConfigFile(), path.join(fallback, "opencode.json"));

  const custom = path.join(sandbox, "opencode-alt");
  fs.mkdirSync(custom, { recursive: true });
  process.env.OPENCODE_CONFIG_DIR = custom;
  assert.deepEqual(opencodeConfigDirs(), [custom, fallback], "the configured directory comes first");
  assert.deepEqual(opencodeConfigFiles(), [
    path.join(custom, "opencode.json"),
    path.join(custom, "opencode.jsonc"),
    path.join(custom, "config.json"),
    path.join(fallback, "opencode.json"),
    path.join(fallback, "opencode.jsonc"),
    path.join(fallback, "config.json"),
  ]);
  assert.equal(opencodePrimaryConfigFile(), path.join(custom, "opencode.json"), "no file exists -> the first candidate");

  fs.writeFileSync(path.join(custom, "config.json"), "{}\n");
  assert.equal(opencodePrimaryConfigFile(), path.join(custom, "config.json"), "an existing later name wins over a missing earlier one");

  const explicit = path.join(sandbox, "explicit", "opencode.json");
  process.env.OPENCODE_CONFIG = explicit;
  assert.equal(opencodePrimaryConfigFile(), explicit, "OPENCODE_CONFIG overrides discovery");
  assert.deepEqual(opencodeConfigFiles().at(-1), explicit, "the explicit file is part of the management set");
});
