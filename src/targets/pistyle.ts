import fs from "node:fs";
import path from "node:path";
import { backupFile, home, readJsonIfExists, writeFileAtomic } from "../fsutil.js";
import type { ApplyResult, Provider } from "../types.js";
import type { TargetApp } from "./types.js";

/**
 * pi-family agents (pi, prime-agent) share the same config layout:
 *   <dir>/models.json   — { providers: { <id>: { baseUrl, apiKey, api, models[] } } }
 *   <dir>/settings.json — { defaultProvider, defaultModel }
 * prime-agent is a pi fork with configDir ".prime/agent" instead of ".pi/agent".
 */
/**
 * Map models.dev reasoning-effort values onto pi thinking levels.
 * pi grammar: value string = provider value, null = level unsupported.
 */
function thinkingLevelMap(efforts: string[]): Record<string, string | null> {
  const map: Record<string, string | null> = {};
  map.off = efforts.includes("none") ? "none" : null;
  for (const level of ["minimal", "low", "medium", "high", "xhigh", "max"]) {
    map[level] = efforts.includes(level) ? level : null;
  }
  return map;
}

export function piStyleTarget(opts: { id: string; name: string; configDirName: string; dirEnvVar: string }): TargetApp {
  const resolveDir = () => {
    const env = process.env[opts.dirEnvVar];
    if (env) return env.startsWith("~") ? path.join(home, env.slice(1)) : env;
    return path.join(home, opts.configDirName);
  };

  return {
    id: opts.id,
    name: opts.name,
    protocols: ["openai", "anthropic"],
    configPaths: [path.join(resolveDir(), "models.json"), path.join(resolveDir(), "settings.json")],

    detect: () => fs.existsSync(path.dirname(resolveDir())),

    async apply(provider: Provider): Promise<ApplyResult> {
      const dir = resolveDir();
      const modelsFile = path.join(dir, "models.json");
      const settingsFile = path.join(dir, "settings.json");
      const notes: string[] = [];
      const anthropic = provider.protocol === "anthropic";

      const modelsConfig = readJsonIfExists<Record<string, unknown>>(modelsFile) ?? {};
      const providers = { ...(modelsConfig.providers as Record<string, unknown> | undefined) };
      providers[provider.id] = {
        name: provider.name,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey, // literal key; pi treats "$VAR"/"!cmd" as indirection, prime also accepts bare env names
        api: anthropic ? "anthropic-messages" : "openai-completions",
        models: provider.models.map((m) => ({
          id: m.id,
          ...(m.name ? { name: m.name } : {}),
          ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
          ...(m.reasoning && m.reasoningEfforts?.length
            ? { thinkingLevelMap: thinkingLevelMap(m.reasoningEfforts) }
            : {}),
          input: m.imageInput ? ["text", "image"] : ["text"],
          ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
          ...(m.maxOutput ? { maxTokens: m.maxOutput } : {}),
          ...(m.cost
            ? {
                cost: {
                  input: m.cost.input ?? 0,
                  output: m.cost.output ?? 0,
                  cacheRead: m.cost.cacheRead ?? 0,
                  cacheWrite: m.cost.cacheWrite ?? 0,
                },
              }
            : {}),
        })),
      };
      modelsConfig.providers = providers;

      const modelsBackup = backupFile(modelsFile);
      if (modelsBackup) notes.push(`backup: ${modelsBackup}`);
      writeFileAtomic(modelsFile, JSON.stringify(modelsConfig, null, 2) + "\n");

      const settings = readJsonIfExists<Record<string, unknown>>(settingsFile) ?? {};
      settings.defaultProvider = provider.id;
      settings.defaultModel = provider.defaultModel;
      const settingsBackup = backupFile(settingsFile);
      if (settingsBackup) notes.push(`backup: ${settingsBackup}`);
      writeFileAtomic(settingsFile, JSON.stringify(settings, null, 2) + "\n");

      return { app: opts.id, changed: [modelsFile, settingsFile], notes };
    },

    async prune(provider: Provider): Promise<ApplyResult> {
      const dir = resolveDir();
      const modelsFile = path.join(dir, "models.json");
      const settingsFile = path.join(dir, "settings.json");
      const modelsConfig = readJsonIfExists<Record<string, unknown>>(modelsFile);
      const providers = modelsConfig?.providers as Record<string, unknown> | undefined;
      if (!modelsConfig || !providers?.[provider.id]) {
        return { app: opts.id, changed: [], notes: [], skipped: `no providers.${provider.id} entry` };
      }
      delete providers[provider.id];
      const notes: string[] = [];
      const changed: string[] = [modelsFile];
      const modelsBackup = backupFile(modelsFile);
      if (modelsBackup) notes.push(`backup: ${modelsBackup}`);
      writeFileAtomic(modelsFile, JSON.stringify(modelsConfig, null, 2) + "\n");

      const settings = readJsonIfExists<Record<string, unknown>>(settingsFile);
      if (settings?.defaultProvider === provider.id) {
        delete settings.defaultProvider;
        delete settings.defaultModel;
        const settingsBackup = backupFile(settingsFile);
        if (settingsBackup) notes.push(`backup: ${settingsBackup}`);
        writeFileAtomic(settingsFile, JSON.stringify(settings, null, 2) + "\n");
        changed.push(settingsFile);
        notes.push("default model reset (was pointing at this provider)");
      }
      return { app: opts.id, changed, notes };
    },

    current(): string | undefined {
      const settings = readJsonIfExists<{ defaultProvider?: string; defaultModel?: string }>(
        path.join(resolveDir(), "settings.json"),
      );
      if (!settings?.defaultProvider) return undefined;
      return `${settings.defaultProvider} · ${settings.defaultModel ?? "?"}`;
    },
  };
}

export const pi = piStyleTarget({
  id: "pi",
  name: "pi",
  configDirName: ".pi/agent",
  dirEnvVar: "PI_CODING_AGENT_DIR",
});

export const prime = piStyleTarget({
  id: "prime",
  name: "prime-agent",
  configDirName: ".prime/agent",
  dirEnvVar: "PRIME_AGENT_CODING_AGENT_DIR",
});
