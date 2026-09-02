import fs from "node:fs";
import path from "node:path";
import { appDataDir, backupFile, home, readJsonIfExists, writeFileAtomic } from "../fsutil.js";
import type { ApplyResult, Provider } from "../types.js";
import type { ProviderCandidate, TargetApp } from "./types.js";

const configDir = process.env.OPENCODE_CONFIG_DIR?.trim() || appDataDir("opencode");
const configFile = path.join(configDir, "opencode.json");

/**
 * opencode: custom providers in ~/.config/opencode/opencode.json "provider" map,
 * backed by @ai-sdk/openai-compatible or @ai-sdk/anthropic npm loaders.
 */
export const opencode: TargetApp = {
  id: "opencode",
  name: "opencode",
  protocols: ["openai", "anthropic"],
  configPaths: [configFile],

  detect: () => fs.existsSync(path.dirname(configFile)),

  async apply(provider: Provider): Promise<ApplyResult> {
    const notes: string[] = [];
    const config = readJsonIfExists<Record<string, unknown>>(configFile) ?? {
      $schema: "https://opencode.ai/config.json",
    };

    const anthropic = provider.protocol === "anthropic";
    const providerMap = { ...(config.provider as Record<string, unknown> | undefined) };
    // Keys agentsw does not model (custom options, per-model extras) are the user's,
    // but a key it owns and no longer emits is cleared rather than inherited from last sync.
    const existing = providerMap[provider.id];
    const prev = (existing && typeof existing === "object" && !Array.isArray(existing)
      ? existing
      : {}) as Record<string, unknown>;
    const prevModels = (prev.models ?? {}) as Record<string, Record<string, unknown>>;
    const models: Record<string, unknown> = {};
    for (const m of provider.models) {
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
        ...(m.contextWindow || m.maxOutput
          ? {
              limit: {
                ...(m.contextWindow ? { context: m.contextWindow } : {}),
                ...(m.maxOutput ? { output: m.maxOutput } : {}),
              },
            }
          : {}),
      };
    }

    providerMap[provider.id] = {
      ...prev,
      npm: anthropic ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible",
      name: provider.name,
      options: {
        ...(prev.options as Record<string, unknown> | undefined),
        baseURL: provider.baseUrl,
        apiKey: provider.apiKey,
      },
      models,
    };
    config.provider = providerMap;
    config.model = `${provider.id}/${provider.defaultModel}`;
    if (provider.smallModel) config.small_model = `${provider.id}/${provider.smallModel}`;

    const backup = backupFile(configFile);
    if (backup) notes.push(`backup: ${backup}`);
    writeFileAtomic(configFile, JSON.stringify(config, null, 2) + "\n");
    return { app: this.id, changed: [configFile], notes };
  },

  async prune(provider: Provider): Promise<ApplyResult> {
    const config = readJsonIfExists<Record<string, unknown>>(configFile);
    const providerMap = config?.provider as Record<string, unknown> | undefined;
    if (!config || !providerMap?.[provider.id]) {
      return { app: this.id, changed: [], notes: [], skipped: `no provider.${provider.id} entry` };
    }
    delete providerMap[provider.id];
    if (Object.keys(providerMap).length === 0) delete config.provider;
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
    writeFileAtomic(configFile, JSON.stringify(config, null, 2) + "\n");
    return { app: this.id, changed: [configFile], notes };
  },

  current(): string | undefined {
    const config = readJsonIfExists<{ model?: string }>(configFile);
    return config?.model;
  },

  candidates(): ProviderCandidate[] {
    const config = readJsonIfExists<{
      provider?: Record<string, { npm?: string; name?: string; options?: { baseURL?: string; apiKey?: string }; models?: Record<string, unknown> }>;
      model?: string;
    }>(configFile);
    if (!config?.provider) return [];
    const activeProvider = config.model?.includes("/") ? config.model.split("/")[0] : undefined;
    const activeModel =
      activeProvider && config.model && config.model.includes("/") ? config.model.split("/").slice(1).join("/") : undefined;
    const self = this.id;
    return Object.entries(config.provider).flatMap(([id, entry]) => {
      const baseUrl = entry?.options?.baseURL;
      if (!entry || !baseUrl || baseUrl.startsWith("{")) return [];
      if (!entry.npm) return []; // built-in provider without a custom npm loader
      const protocol = entry.npm.includes("anthropic") ? "anthropic" : "openai";
      let apiKey = entry.options?.apiKey;
      let keyEnv: string | undefined;
      const ref = apiKey?.match(/^\{env:([A-Za-z0-9_]+)\}$/);
      if (ref?.[1]) {
        keyEnv = ref[1];
        apiKey = process.env[ref[1]];
      }
      const models = Object.keys(entry.models ?? {});
      const defaultModel = activeProvider === id ? activeModel : undefined;
      if (defaultModel && !models.includes(defaultModel)) models.unshift(defaultModel);
      return [{ id, name: entry.name ?? id, protocol, baseUrl, apiKey, keyEnv, models, defaultModel, source: self }];
    });
  },
};
