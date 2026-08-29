import fs from "node:fs";
import path from "node:path";
import { backupFile, home, readJsonIfExists, writeFileAtomic } from "../fsutil.js";
import type { ApplyResult, Provider } from "../types.js";
import type { TargetApp } from "./types.js";

const configFile = path.join(home, ".config", "opencode", "opencode.json");

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
    const models: Record<string, unknown> = {};
    for (const m of provider.models) {
      models[m.id] = {
        ...(m.name ? { name: m.name } : {}),
        ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
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

    const providerMap = { ...(config.provider as Record<string, unknown> | undefined) };
    providerMap[provider.id] = {
      npm: anthropic ? "@ai-sdk/anthropic" : "@ai-sdk/openai-compatible",
      name: provider.name,
      options: {
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

  current(): string | undefined {
    const config = readJsonIfExists<{ model?: string }>(configFile);
    return config?.model;
  },
};
