import fs from "node:fs";
import path from "node:path";
import { backupFile, home, writeFileAtomic } from "../fsutil.js";
import { editJsoncObject, isJsonObject, readJsoncObject } from "../jsonc.js";
import type { JsoncDocument } from "../jsonc.js";
import type { ApplyResult, Provider } from "../types.js";
import { looksLikeEnvName } from "../slug.js";
import { transactionalTarget } from "../target-transaction.js";
import type { ProviderCandidate, TargetApp } from "./types.js";
import { apiValue, classifyApi, entryApi, mergeModels, sdkBaseUrl, stripConflictingOverrides } from "./wire.js";

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

type ModelsConfig = Record<string, unknown> & { providers?: Record<string, Record<string, unknown>> };
type SettingsConfig = Record<string, unknown> & { defaultProvider?: string; defaultModel?: string };

function readModels(file: string): JsoncDocument & { value: ModelsConfig } {
  const document = readJsoncObject(file);
  const providers = document.value.providers;
  if (providers !== undefined) {
    if (!isJsonObject(providers)) throw new Error(`${file}: expected providers to be a JSON object`);
    for (const entry of Object.values(providers)) {
      if (!isJsonObject(entry)) throw new Error(`${file}: expected every provider entry to be a JSON object`);
    }
  }
  return { ...document, value: document.value as ModelsConfig };
}

function readSettings(file: string): JsoncDocument & { value: SettingsConfig } {
  const document = readJsoncObject(file);
  for (const key of ["defaultProvider", "defaultModel"]) {
    if (document.value[key] !== undefined && typeof document.value[key] !== "string") {
      throw new Error(`${file}: expected ${key} to be a string`);
    }
  }
  return { ...document, value: document.value as SettingsConfig };
}

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

  return transactionalTarget({
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

      // Validate both files before preparing any writes, including a malformed settings file.
      const modelsDocument = readModels(modelsFile);
      const settingsDocument = readSettings(settingsFile);
      const modelsConfig = { ...modelsDocument.value };
      const providers = { ...modelsConfig.providers };
      // Keys agentsw does not model (headers, authHeader, oauth, ...) and per-model extras
      // are the user's; a re-sync overwrites only the fields it owns.
      const prev = providers[provider.id] ?? {};
      const api = apiValue(provider.protocol, provider.openaiApi, prev.api ?? entryApi(prev));
      const baseUrl = sdkBaseUrl(provider.protocol, provider.baseUrl);
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
      const conflicts = stripConflictingOverrides(models, api, baseUrl);
      if (conflicts.length) notes.push(`dropped model overrides pointing elsewhere: ${conflicts.join(", ")}`);
      providers[provider.id] = {
        ...prev,
        name: provider.name,
        baseUrl,
        apiKey: provider.apiKey, // literal key; pi treats "$VAR"/"!cmd" as indirection, prime also accepts bare env names
        api,
        models,
      };
      modelsConfig.providers = providers;

      const settings: SettingsConfig = {
        ...settingsDocument.value,
        defaultProvider: provider.id,
        defaultModel: provider.defaultModel,
      };
      const modelsText = editJsoncObject(modelsDocument, modelsConfig);
      const settingsText = editJsoncObject(settingsDocument, settings);
      const modelsBackup = backupFile(modelsFile);
      if (modelsBackup) notes.push(`backup: ${modelsBackup}`);
      writeFileAtomic(modelsFile, modelsText);

      const settingsBackup = backupFile(settingsFile);
      if (settingsBackup) notes.push(`backup: ${settingsBackup}`);
      writeFileAtomic(settingsFile, settingsText);

      return { app: opts.id, changed: [modelsFile, settingsFile], notes };
    },

    async prune(provider: Provider): Promise<ApplyResult> {
      const dir = resolveDir();
      const modelsFile = path.join(dir, "models.json");
      const settingsFile = path.join(dir, "settings.json");
      const modelsDocument = readModels(modelsFile);
      const settingsDocument = readSettings(settingsFile);
      const providers = { ...modelsDocument.value.providers };
      if (!Object.hasOwn(providers, provider.id)) {
        return { app: opts.id, changed: [], notes: [], skipped: `no providers.${provider.id} entry` };
      }
      delete providers[provider.id];
      const settings = { ...settingsDocument.value };
      const resetDefault = settings.defaultProvider === provider.id;
      if (resetDefault) {
        delete settings.defaultProvider;
        delete settings.defaultModel;
      }
      const modelsText = editJsoncObject(modelsDocument, { ...modelsDocument.value, providers });
      const settingsText = resetDefault ? editJsoncObject(settingsDocument, settings) : undefined;
      const notes: string[] = [];
      const changed: string[] = [modelsFile];
      const modelsBackup = backupFile(modelsFile);
      if (modelsBackup) notes.push(`backup: ${modelsBackup}`);
      writeFileAtomic(modelsFile, modelsText);

      if (settingsText !== undefined) {
        const settingsBackup = backupFile(settingsFile);
        if (settingsBackup) notes.push(`backup: ${settingsBackup}`);
        writeFileAtomic(settingsFile, settingsText);
        changed.push(settingsFile);
        notes.push("default model reset (was pointing at this provider)");
      }
      return { app: opts.id, changed, notes };
    },

    current(): string | undefined {
      const settings = readSettings(path.join(resolveDir(), "settings.json")).value;
      if (!settings?.defaultProvider) return undefined;
      return `${settings.defaultProvider} · ${settings.defaultModel ?? "?"}`;
    },

    candidates(): ProviderCandidate[] {
      const dir = resolveDir();
      const mc = readModels(path.join(dir, "models.json")).value;
      const settings = readSettings(path.join(dir, "settings.json")).value;
      if (!mc.providers) return [];
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
          const envRef = raw.match(/^\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))$/)
            ?? raw.match(/^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/)
            ?? raw.match(/^env:([A-Za-z_][A-Za-z0-9_]*)$/);
          if (envRef) {
            keyEnv = envRef[1] ?? envRef[2];
            apiKey = keyEnv ? process.env[keyEnv] : undefined;
          } else if (opts.id === "prime" && looksLikeEnvName(raw)) {
            keyEnv = raw;
            apiKey = process.env[raw] ?? raw;
          } else if (!/^(?:!|\$|\{(?:file|env):|file:|env:|~\/|\/)/.test(raw)) {
            // Commands and file references are never executed or exported as literal credentials.
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
  });
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
