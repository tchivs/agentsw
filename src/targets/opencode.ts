import fs from "node:fs";
import { backupFile, readTextIfExists, writeFileAtomic } from "../fsutil.js";
import { isJsonObject, readJsoncObject, editJsoncObject } from "../jsonc.js";
import { opencodeConfigDirs, opencodeConfigFiles, opencodePrimaryConfigFile } from "../app-paths.js";
import { transactionalTarget } from "../target-transaction.js";
import type { ApplyResult, Provider } from "../types.js";
import type { ProviderCandidate, TargetApp } from "./types.js";

/**
 * opencode: custom providers in the "provider" map of its config document
 * (opencode.json / opencode.jsonc / config.json under $OPENCODE_CONFIG_DIR or the
 * default directory; $OPENCODE_CONFIG names one file explicitly), backed by
 * @ai-sdk/openai-compatible or @ai-sdk/anthropic npm loaders. A JSONC round-trip
 * keeps comments and every key agentsw does not own.
 */
export const opencode: TargetApp = transactionalTarget({
  id: "opencode",
  name: "opencode",
  protocols: ["openai", "anthropic"],
  get configPaths() {
    return [opencodePrimaryConfigFile()];
  },

  detect: () =>
    opencodeConfigFiles().some((file) => fs.existsSync(file)) ||
    opencodeConfigDirs().some((dir) => fs.existsSync(dir)),

  async apply(provider: Provider): Promise<ApplyResult> {
    const configFile = opencodePrimaryConfigFile();
    const notes: string[] = [];
    const existed = readTextIfExists(configFile) !== undefined;
    const document = readJsoncObject(configFile);
    // Only a missing file is initialized with the schema hint; an existing {} stays as-is.
    const config: Record<string, unknown> = existed
      ? { ...document.value }
      : { $schema: "https://opencode.ai/config.json" };
    if (config.provider !== undefined && !isJsonObject(config.provider)) {
      throw new Error(`${configFile}: expected config and provider to be JSON objects`);
    }

    const anthropic = provider.protocol === "anthropic";
    const providerMap = { ...(config.provider as Record<string, unknown> | undefined) };
    // Keys agentsw does not model (custom options, per-model extras) are the user's,
    // but a key it owns and no longer emits is cleared rather than inherited from last sync.
    const existing = providerMap[provider.id];
    if (existing !== undefined && !isJsonObject(existing)) {
      throw new Error(`${configFile}: expected the selected provider to be a JSON object`);
    }
    const prev = (existing && typeof existing === "object" && !Array.isArray(existing)
      ? existing
      : {}) as Record<string, unknown>;
    if ((prev.models !== undefined && !isJsonObject(prev.models)) ||
        (prev.options !== undefined && !isJsonObject(prev.options))) {
      throw new Error(`${configFile}: expected provider models and options to be JSON objects`);
    }
    const prevModels = (prev.models ?? {}) as Record<string, Record<string, unknown>>;
    const models: Record<string, unknown> = {};
    for (const m of provider.models) {
      if (prevModels[m.id] !== undefined && !isJsonObject(prevModels[m.id])) {
        throw new Error(`${configFile}: expected each model to be a JSON object`);
      }
      const old = { ...prevModels[m.id] };
      for (const key of ["name", "reasoning", "attachment", "cost", "limit"]) delete old[key];
      models[m.id] = {
        ...old,
        ...(m.name ? { name: m.name } : {}),
        ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
        ...(m.imageInput ? { attachment: true } : {}),
        ...(m.cost
          ? {
              cost: {
                input: m.cost.input ?? 0,
                output: m.cost.output ?? 0,
                ...(m.cost.cacheRead !== undefined ? { cache_read: m.cost.cacheRead } : {}),
                ...(m.cost.cacheWrite !== undefined ? { cache_write: m.cost.cacheWrite } : {}),
              },
            }
          : {}),
        ...(m.contextWindow && m.maxOutput
          ? {
              limit: {
                context: m.contextWindow,
                output: m.maxOutput,
              },
            }
          : {}),
      };
    }

    providerMap[provider.id] = {
      ...prev,
      npm: anthropic ? "@ai-sdk/anthropic" :
        (provider.openaiApi ?? (prev.npm === "@ai-sdk/openai" ? "responses" : "completions")) === "responses"
          ? "@ai-sdk/openai" : "@ai-sdk/openai-compatible",
      name: provider.name,
      options: {
        ...(prev.options as Record<string, unknown> | undefined),
        baseURL: provider.baseUrl.replace(/\/+$/, ""),
        apiKey: provider.apiKey,
      },
      models,
    };
    config.provider = providerMap;
    config.model = `${provider.id}/${provider.defaultModel}`;
    if (provider.smallModel) {
      config.small_model = `${provider.id}/${provider.smallModel}`;
    } else if (typeof config.small_model === "string" && config.small_model.startsWith(`${provider.id}/`)) {
      // This provider's own previous small model is obsolete; another provider's
      // entry stays untouched, exactly as prune scopes its cleanup.
      delete config.small_model;
    }

    const backup = backupFile(configFile);
    if (backup) notes.push(`backup: ${backup}`);
    writeFileAtomic(configFile, editJsoncObject(document, config));
    return { app: this.id, changed: [configFile], notes };
  },

  async prune(provider: Provider): Promise<ApplyResult> {
    const configFile = opencodePrimaryConfigFile();
    const document = readJsoncObject(configFile);
    const config: Record<string, unknown> = { ...document.value };
    if (config.provider !== undefined && !isJsonObject(config.provider)) {
      throw new Error(`${configFile}: expected config and provider to be JSON objects`);
    }
    const providerMap = { ...(config.provider as Record<string, unknown> | undefined) };
    if (!providerMap[provider.id]) {
      return { app: this.id, changed: [], notes: [], skipped: `no provider.${provider.id} entry` };
    }
    delete providerMap[provider.id];
    if (Object.keys(providerMap).length === 0) delete config.provider;
    else config.provider = providerMap;
    const notes: string[] = [];
    if (typeof config.model === "string" && config.model.startsWith(`${provider.id}/`)) {
      delete config.model;
      notes.push("default model reset (was pointing at this provider)");
    }
    if (typeof config.small_model === "string" && config.small_model.startsWith(`${provider.id}/`)) {
      delete config.small_model;
    }
    const backup = backupFile(configFile);
    if (backup) notes.push(`backup: ${backup}`);
    writeFileAtomic(configFile, editJsoncObject(document, config));
    return { app: this.id, changed: [configFile], notes };
  },

  current(): string | undefined {
    const config = readJsoncObject(opencodePrimaryConfigFile()).value;
    return typeof config.model === "string" ? config.model : undefined;
  },

  candidates(): ProviderCandidate[] {
    const config = readJsoncObject(opencodePrimaryConfigFile()).value as {
      provider?: Record<string, { npm?: string; name?: string; options?: { baseURL?: string; apiKey?: string }; models?: Record<string, unknown> }>;
      model?: string;
    };
    if (!config.provider) return [];
    const activeProvider = config.model?.includes("/") ? config.model.split("/")[0] : undefined;
    const activeModel =
      activeProvider && config.model && config.model.includes("/") ? config.model.split("/").slice(1).join("/") : undefined;
    const self = this.id;
    return Object.entries(config.provider).flatMap(([id, entry]) => {
      const baseUrl = entry?.options?.baseURL;
      if (!entry || !baseUrl || baseUrl.startsWith("{")) return [];
      if (!entry.npm) return []; // built-in provider without a custom npm loader
      const protocol = entry.npm.includes("anthropic") ? "anthropic" : "openai";
      const openaiApi = protocol === "openai" ? (entry.npm === "@ai-sdk/openai" ? "responses" : "completions") : undefined;
      let apiKey = entry.options?.apiKey;
      let keyEnv: string | undefined;
      const ref = apiKey?.match(/^\{env:([A-Za-z0-9_]+)\}$/);
      if (ref?.[1]) {
        keyEnv = ref[1];
        apiKey = process.env[ref[1]];
      }
      if (apiKey?.startsWith("{file:")) apiKey = undefined;
      const models = Object.keys(entry.models ?? {});
      const defaultModel = activeProvider === id ? activeModel : undefined;
      if (defaultModel && !models.includes(defaultModel)) models.unshift(defaultModel);
      return [{ id, name: entry.name ?? id, protocol, openaiApi, baseUrl, apiKey, keyEnv, models, defaultModel, source: self }];
    });
  },
});
