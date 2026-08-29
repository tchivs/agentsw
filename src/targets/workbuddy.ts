import fs from "node:fs";
import path from "node:path";
import { backupFile, home, readJsonIfExists, writeFileAtomic } from "../fsutil.js";
import { slugFromBaseUrl } from "../slug.js";
import type { ApplyResult, Provider } from "../types.js";
import type { ProviderCandidate, TargetApp } from "./types.js";

function configDir(): string {
  return process.env.WORKBUDDY_CONFIG_DIR ?? process.env.CODEBUDDY_CONFIG_DIR ?? path.join(home, ".workbuddy");
}

interface WorkbuddyModel {
  id: string;
  [key: string]: unknown;
}

/**
 * models.json accepts a raw array (desktop writes) or {models, availableModels} (CLI writes).
 * Runtime-narrow both shapes; entries without a string id are dropped (WorkBuddy skips them too).
 */
function readWorkbuddyModels(file: string): { models: WorkbuddyModel[]; availableModels: string[]; existed: boolean } {
  const raw = readJsonIfExists<unknown>(file);
  const rows: unknown[] = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && "models" in raw && Array.isArray(raw.models)
      ? raw.models
      : [];
  const models = rows.filter(
    (m): m is WorkbuddyModel => !!m && typeof m === "object" && "id" in m && typeof m.id === "string",
  );
  const availableModels =
    !Array.isArray(raw) && raw && typeof raw === "object" && "availableModels" in raw && Array.isArray(raw.availableModels)
      ? raw.availableModels.filter((id): id is string => typeof id === "string")
      : [];
  return { models, availableModels, existed: raw !== undefined };
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
    const { models: existingModels, availableModels: existingAvailable } = readWorkbuddyModels(modelsFile);

    const ourIds = provider.models.map((m) => m.id);
    const kept = existingModels.filter((m) => !ourIds.includes(m.id));
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

  async prune(provider: Provider): Promise<ApplyResult> {
    const dir = configDir();
    const modelsFile = path.join(dir, "models.json");
    const settingsFile = path.join(dir, "settings.json");
    const { models, availableModels: available, existed } = readWorkbuddyModels(modelsFile);
    if (!existed) return { app: this.id, changed: [], notes: [], skipped: "no models.json" };

    const ourIds = provider.models.map((m) => m.id);
    // ours = matching id AND vendor (id alone could collide with entries from another provider)
    const kept = models.filter((m) => !(ourIds.includes(m.id) && m.vendor === provider.name));
    if (kept.length === models.length) {
      return { app: this.id, changed: [], notes: [], skipped: "no entries from this provider" };
    }
    const keptIds = kept.map((m) => m.id);
    const notes: string[] = [];
    const modelsBackup = backupFile(modelsFile);
    if (modelsBackup) notes.push(`backup: ${modelsBackup}`);
    writeFileAtomic(
      modelsFile,
      JSON.stringify({ models: kept, availableModels: available.filter((id) => keptIds.includes(id)) }, null, 2) + "\n",
    );

    const changed = [modelsFile];
    const settings = readJsonIfExists<Record<string, unknown>>(settingsFile);
    if (settings && typeof settings.model === "string" && ourIds.includes(settings.model)) {
      delete settings.model;
      const settingsBackup = backupFile(settingsFile);
      if (settingsBackup) notes.push(`backup: ${settingsBackup}`);
      writeFileAtomic(settingsFile, JSON.stringify(settings, null, 2) + "\n");
      changed.push(settingsFile);
      notes.push("default model reset (was one of this provider's models)");
    }
    return { app: this.id, changed, notes };
  },

  current(): string | undefined {
    const settings = readJsonIfExists<{ model?: string }>(path.join(configDir(), "settings.json"));
    return settings?.model;
  },

  candidates(): ProviderCandidate[] {
    // every entry carries its own full chat/completions url + key; group by the underlying base URL
    const { models } = readWorkbuddyModels(path.join(configDir(), "models.json"));
    if (models.length === 0) return [];
    const settings = readJsonIfExists<{ model?: string }>(path.join(configDir(), "settings.json"));
    interface Group {
      ids: string[];
      apiKey?: string;
      vendor?: string;
    }
    const groups = new Map<string, Group>();
    for (const m of models) {
      const row = m as Record<string, unknown>;
      if (typeof row.url !== "string" || !row.url) continue;
      const baseUrl = row.url.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
      if (!/^https?:\/\//.test(baseUrl)) continue;
      let g = groups.get(baseUrl);
      if (!g) {
        g = { ids: [] };
        groups.set(baseUrl, g);
      }
      if (!g.ids.includes(m.id)) g.ids.push(m.id);
      if (!g.apiKey && typeof row.apiKey === "string") g.apiKey = row.apiKey;
      if (!g.vendor && typeof row.vendor === "string") g.vendor = row.vendor;
    }
    const self = this.id;
    return [...groups.entries()].map(([baseUrl, g]) => {
      const id = slugFromBaseUrl(baseUrl);
      const defaultModel = settings?.model && g.ids.includes(settings.model) ? settings.model : undefined;
      return { id, name: g.vendor ?? id, protocol: "openai" as const, baseUrl, apiKey: g.apiKey, models: g.ids, defaultModel, source: self };
    });
  },
};
