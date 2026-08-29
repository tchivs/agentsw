import fs from "node:fs";
import path from "node:path";
import { backupFile, home, readJsonIfExists, writeFileAtomic } from "../fsutil.js";
import type { ApplyResult, Provider } from "../types.js";
import type { TargetApp } from "./types.js";

function configDir(): string {
  return process.env.WORKBUDDY_CONFIG_DIR ?? process.env.CODEBUDDY_CONFIG_DIR ?? path.join(home, ".workbuddy");
}

interface WorkbuddyModel {
  id: string;
  [key: string]: unknown;
}

/**
 * WorkBuddy (Tencent CodeBuddy family): custom models live in ~/.workbuddy/models.json.
 * Each entry carries its own full OpenAI chat-completions `url` + `apiKey`; entries merge
 * into the model selector ("custom" section). Default model via settings.json "model".
 * Custom entries speak the OpenAI wire only — anthropic-protocol providers are skipped.
 */
export const workbuddy: TargetApp = {
  id: "workbuddy",
  name: "WorkBuddy",
  protocols: ["openai"],
  configPaths: [path.join(configDir(), "models.json"), path.join(configDir(), "settings.json")],

  detect: () => fs.existsSync(configDir()),

  async apply(provider: Provider): Promise<ApplyResult> {
    const dir = configDir();
    const modelsFile = path.join(dir, "models.json");
    const settingsFile = path.join(dir, "settings.json");
    const notes: string[] = [];

    const base = provider.baseUrl.replace(/\/+$/, "");
    const url = /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;

    // models.json accepts a raw array (desktop) or {models, availableModels} (CLI); write the object shape.
    const existing = readJsonIfExists<unknown>(modelsFile);
    const existingModels: WorkbuddyModel[] = Array.isArray(existing)
      ? (existing as WorkbuddyModel[])
      : (((existing as { models?: WorkbuddyModel[] } | undefined)?.models ?? []) as WorkbuddyModel[]);
    const existingAvailable = Array.isArray(existing)
      ? []
      : ((existing as { availableModels?: string[] } | undefined)?.availableModels ?? []);

    const ourIds = provider.models.map((m) => m.id);
    const kept = existingModels.filter((m) => m && typeof m.id === "string" && !ourIds.includes(m.id));
    const ours: WorkbuddyModel[] = provider.models.map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      vendor: provider.name,
      url,
      apiKey: provider.apiKey,
      ...(m.maxInput ?? m.contextWindow ? { maxInputTokens: m.maxInput ?? m.contextWindow } : {}),
      ...(m.maxOutput ? { maxOutputTokens: m.maxOutput } : {}),
      supportsToolCall: true,
      ...(m.imageInput !== undefined ? { supportsImages: !!m.imageInput } : {}),
      ...(m.reasoning !== undefined ? { supportsReasoning: !!m.reasoning } : {}),
    }));
    const availableModels = [...new Set([...existingAvailable, ...ourIds])];

    const modelsBackup = backupFile(modelsFile);
    if (modelsBackup) notes.push(`backup: ${modelsBackup}`);
    writeFileAtomic(modelsFile, JSON.stringify({ models: [...kept, ...ours], availableModels }, null, 2) + "\n");

    const settings = readJsonIfExists<Record<string, unknown>>(settingsFile) ?? {};
    settings.model = provider.defaultModel;
    const settingsBackup = backupFile(settingsFile);
    if (settingsBackup) notes.push(`backup: ${settingsBackup}`);
    writeFileAtomic(settingsFile, JSON.stringify(settings, null, 2) + "\n");
    notes.push("WorkBuddy watches models.json; models appear in the selector's custom section without restart");

    return { app: this.id, changed: [modelsFile, settingsFile], notes };
  },

  current(): string | undefined {
    const settings = readJsonIfExists<{ model?: string }>(path.join(configDir(), "settings.json"));
    return settings?.model;
  },
};
