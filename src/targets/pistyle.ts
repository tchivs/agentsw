import fs from "node:fs";
import path from "node:path";
import { backupFile, home, readJsonIfExists, writeFileAtomic } from "../fsutil.js";
import type { ApplyResult, Provider } from "../types.js";
import { looksLikeEnvName } from "../slug.js";
import type { ProviderCandidate, TargetApp } from "./types.js";
import { stripApiVersion } from "./wire.js";
import { apiValue, classifyApi, entryApi, mergeModels, stripConflictingOverrides } from "./wire.js";

/** Per-model keys this adapter writes; one that stops being emitted is cleared, not inherited. */
const OWNED_MODEL_KEYS = [
  "id",
  "name",
  "reasoning",
  "thinkingLevelMap",
  "input",
  "contextWindow",
  "maxTokens",
  "cost",
] as const;

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

      const modelsConfig = readJsonIfExists<Record<string, unknown>>(modelsFile) ?? {};
      const providers = { ...(modelsConfig.providers as Record<string, unknown> | undefined) };
      // Keys agentsw does not model (headers, authHeader, oauth, ...) and per-model extras
      // are the user's; a re-sync overwrites only the fields it owns.
      const existing = providers[provider.id];
      const prev = (existing && typeof existing === "object" && !Array.isArray(existing)
        ? existing
        : {}) as Record<string, unknown>;
      const api = apiValue(provider.protocol, provider.openaiApi, entryApi(prev));
      const models = mergeModels(
        prev.models,
        provider.models.map((m) => ({
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
        OWNED_MODEL_KEYS,
      );
      const conflicts = stripConflictingOverrides(models, api, provider.baseUrl);
      if (conflicts.length) notes.push(`dropped model overrides pointing elsewhere: ${conflicts.join(", ")}`);
      providers[provider.id] = {
        ...prev,
        name: provider.name,
        baseUrl: stripApiVersion(provider.baseUrl),
        apiKey: provider.apiKey, // literal key; pi treats "$VAR"/"!cmd" as indirection, prime also accepts bare env names
        api,
        models,
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

    candidates(): ProviderCandidate[] {
      const dir = resolveDir();
      const mc = readJsonIfExists<{ providers?: Record<string, Record<string, unknown>> }>(path.join(dir, "models.json"));
      if (!mc?.providers) return [];
      const settings = readJsonIfExists<{ defaultProvider?: string; defaultModel?: string }>(path.join(dir, "settings.json"));
      const self = opts.id;
      return Object.entries(mc.providers).flatMap(([id, entry]) => {
        if (!entry || typeof entry.baseUrl !== "string") return [];
        const modelEntries = Array.isArray(entry.models) ? (entry.models as Array<Record<string, unknown>>) : [];
        // pi takes `api` at provider level or on every model; a mixed-protocol entry is skipped.
        const wire = classifyApi(entryApi(entry));
        if (!wire) return [];
        let apiKey: string | undefined;
        let keyEnv: string | undefined;
        const raw = typeof entry.apiKey === "string" && entry.apiKey ? entry.apiKey : undefined;
        if (raw) {
          if (raw.startsWith("$") && raw.length > 1) {
            keyEnv = raw.slice(1);
            apiKey = process.env[keyEnv];
          } else if (opts.id === "prime" && looksLikeEnvName(raw)) {
            // prime resolves bare env names; falls back to the literal string
            keyEnv = raw;
            apiKey = process.env[raw] ?? raw;
          } else {
            apiKey = raw;
          }
        }
        const models = modelEntries.map((m) => (typeof m?.id === "string" ? m.id : "")).filter(Boolean);
        const defaultModel =
          settings?.defaultProvider === id && settings?.defaultModel ? settings.defaultModel : undefined;
        if (defaultModel && !models.includes(defaultModel)) models.unshift(defaultModel);
        return [
          {
            id,
            name: typeof entry.name === "string" ? entry.name : id,
            protocol: wire.protocol,
            openaiApi: wire.openaiApi,
            baseUrl: entry.baseUrl,
            apiKey,
            keyEnv,
            models,
            defaultModel,
            source: self,
          },
        ];
      });
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
