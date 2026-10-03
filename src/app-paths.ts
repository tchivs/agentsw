import fs from "node:fs";
import path from "node:path";
import { appDataDir, expandHome, home, localAppDataDir } from "./fsutil.js";

/**
 * Every app path lives here and is resolved on each call, so one command's `use`/`sync`
 * targets the same files as `remove`/`rename`/`status` — including when the app's own
 * config-directory environment variable is set. An empty value is ignored (the apps do
 * the same); a relative value is kept as-is, exactly as the app would resolve it against
 * its own working directory.
 */
function envPath(name: string): string | undefined {
  const raw = process.env[name]?.trim();
  return raw ? expandHome(raw) : undefined;
}

export function claudeDir(): string {
  return envPath("CLAUDE_CONFIG_DIR") ?? path.join(home, ".claude");
}

export function claudeSettingsFile(): string {
  return path.join(claudeDir(), "settings.json");
}

export function codexDir(): string {
  return envPath("CODEX_HOME") ?? path.join(home, ".codex");
}

export function codexConfigFile(): string {
  return path.join(codexDir(), "config.toml");
}

export function codexAuthFile(): string {
  return path.join(codexDir(), "auth.json");
}

const PI_LAYOUT = {
  pi: { env: "PI_CODING_AGENT_DIR", dir: ".pi/agent" },
  prime: { env: "PRIME_AGENT_CODING_AGENT_DIR", dir: ".prime/agent" },
} as const;

export type PiId = keyof typeof PI_LAYOUT;

export function piDir(id: PiId): string {
  return envPath(PI_LAYOUT[id].env) ?? path.join(home, PI_LAYOUT[id].dir);
}

export function piModelsFile(id: PiId): string {
  return path.join(piDir(id), "models.json");
}

export function piSettingsFile(id: PiId): string {
  return path.join(piDir(id), "settings.json");
}

export function ompAgentDir(): string {
  return path.join(home, ".omp", "agent");
}

/** An existing models.yaml wins only when models.yml is absent (omp precedence). */
export function ompModelsFiles(): string[] {
  return ["models.yml", "models.yaml"].map((name) => path.join(ompAgentDir(), name));
}

export function ompConfigFiles(): string[] {
  return ["config.yml", "config.yaml"].map((name) => path.join(ompAgentDir(), name));
}

export function hermesDir(): string {
  return envPath("HERMES_HOME") ?? localAppDataDir("hermes");
}

export function hermesConfigFile(): string {
  return path.join(hermesDir(), "config.yaml");
}

export function hermesEnvFile(): string {
  return path.join(hermesDir(), ".env");
}

export function dshDir(): string {
  return envPath("DSH_HOME") ?? localAppDataDir("dsh");
}

/** The extension picks the document format, so an existing .yml/.json is written in place. */
export function dshSettingsFiles(): string[] {
  return ["settings.yaml", "settings.yml", "settings.json"].map((name) => path.join(dshDir(), name));
}

export function dshSettingsFile(): string {
  return dshSettingsFiles().find((file) => fs.existsSync(file)) ?? path.join(dshDir(), "settings.yaml");
}

export function dshCredentialsFile(): string {
  return path.join(dshDir(), ".credentials.yaml");
}

export function workbuddyDir(): string {
  return envPath("WORKBUDDY_CONFIG_DIR") ?? envPath("CODEBUDDY_CONFIG_DIR") ??
    (process.platform === "win32" ? appDataDir("workbuddy") : path.join(home, ".workbuddy"));
}

export function workbuddyModelsFile(): string {
  return path.join(workbuddyDir(), "models.json");
}

export function workbuddySettingsFile(): string {
  return path.join(workbuddyDir(), "settings.json");
}

/** opencode's loader accepts any of these names in its config directory. */
export const OPENCODE_CONFIG_FILENAMES = ["opencode.json", "opencode.jsonc", "config.json"] as const;

export function opencodeConfigDirs(): string[] {
  const dirs: string[] = [];
  const custom = envPath("OPENCODE_CONFIG_DIR");
  if (custom) dirs.push(custom);
  const fallback = appDataDir("opencode");
  if (!dirs.includes(fallback)) dirs.push(fallback);
  return dirs;
}

/** Every file a management command must consider, across both directories and the explicit file. */
export function opencodeConfigFiles(): string[] {
  const files: string[] = [];
  const add = (file: string): void => {
    if (!files.includes(file)) files.push(file);
  };
  for (const dir of opencodeConfigDirs()) {
    for (const name of OPENCODE_CONFIG_FILENAMES) add(path.join(dir, name));
  }
  const explicit = envPath("OPENCODE_CONFIG");
  if (explicit) add(explicit);
  return files;
}

/** OPENCODE_CONFIG (an explicit file), else the first existing config in the search order, else the creation default. */
export function opencodePrimaryConfigFile(): string {
  const explicit = envPath("OPENCODE_CONFIG");
  if (explicit) return explicit;
  const dirs = opencodeConfigDirs();
  for (const dir of dirs) {
    for (const name of OPENCODE_CONFIG_FILENAMES) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) return file;
    }
  }
  return path.join(dirs[0] ?? appDataDir("opencode"), "opencode.json");
}
