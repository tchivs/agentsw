import fs from "node:fs";
import path from "node:path";
import { appDataDir, backupFile, home, readJsonIfExists, writeFileAtomic } from "../fsutil.js";
import { isJsonObject } from "../jsonc.js";
import { localProviderId } from "../provider-identity.js";
import { providerIdFromBaseUrl, providerNameFromBaseUrl } from "../slug.js";
import { transactionalTarget } from "../target-transaction.js";
import type { ApplyResult, Provider } from "../types.js";
import type { ProviderCandidate, TargetApp } from "./types.js";

function configDir(): string {
  return process.env.WORKBUDDY_CONFIG_DIR?.trim() || process.env.CODEBUDDY_CONFIG_DIR?.trim() ||
    (process.platform === "win32" ? appDataDir("workbuddy") : path.join(home, ".workbuddy"));
}

interface WorkbuddyModel {
  id: string;
  [key: string]: unknown;
}

function isModel(row: unknown): row is WorkbuddyModel {
  return isJsonObject(row) && typeof row.id === "string";
}

/** Preserve unknown rows and container fields even though WorkBuddy skips those rows. */
function readWorkbuddyModels(file: string) {
  const raw = readJsonIfExists<unknown>(file);
  if (raw !== undefined && !Array.isArray(raw) && !isJsonObject(raw)) {
    throw new Error(`${file}: expected a model array or JSON object`);
  }
  const container = isJsonObject(raw) ? raw : {};
  if (container.models !== undefined && !Array.isArray(container.models)) {
    throw new Error(`${file}: expected models to be an array`);
  }
  if (container.availableModels !== undefined &&
      (!Array.isArray(container.availableModels) || container.availableModels.some((id) => typeof id !== "string"))) {
    throw new Error(`${file}: expected availableModels to be an array of strings`);
  }
  const rows: unknown[] = Array.isArray(raw) ? raw : (container.models as unknown[] | undefined) ?? [];
  const availableModels = (container.availableModels as string[] | undefined) ?? [];
  return { rows, models: rows.filter(isModel), container, availableModels, existed: raw !== undefined };
}

/** Root endpoints retain WorkBuddy's /v1 convention; custom base paths never gain /v1. */
function completionsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("WorkBuddy requires an HTTP(S) endpoint");
  const pathname = url.pathname.replace(/\/+$/, "");
  url.pathname = pathname.endsWith("/chat/completions") ? pathname : `${pathname || "/v1"}/chat/completions`;
  return url.toString();
}

function ownsModel(row: WorkbuddyModel, provider: Provider, endpoint: string): boolean {
  if (row.agentswProviderId !== undefined) return row.agentswProviderId === provider.id;
  if (typeof row.url !== "string" || row.apiKey !== provider.apiKey) return false;
  try {
    return completionsUrl(row.url) === endpoint;
  } catch {
    return false;
  }
}

const OWNED_MODEL_KEYS = [
  "id", "name", "vendor", "url", "apiKey", "agentswProviderId", "maxInputTokens", "maxOutputTokens",
  "supportsToolCall", "supportsImages", "supportsReasoning",
] as const;

/** Import and management must identify the same endpoint without rewriting query values. */
export function workbuddyBaseUrl(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    const pathname = url.pathname.replace(/\/+$/, "");
    url.pathname = pathname === "/chat/completions" ? pathname : pathname.replace(/\/chat\/completions$/, "");
    return url.toString();
  } catch {
    return undefined;
  }
}

/** WorkBuddy stores per-model full chat-completions URLs and credentials. */
export const workbuddy: TargetApp = transactionalTarget({
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
    const url = completionsUrl(provider.baseUrl);
    const { rows, models, container, availableModels: existingAvailable } = readWorkbuddyModels(modelsFile);
    const settingsValue = readJsonIfExists<Record<string, unknown>>(settingsFile);
    const settings = settingsValue === undefined ? {} : settingsValue;
    if (!isJsonObject(settings)) throw new Error(`${settingsFile}: expected a JSON object`);

    const owned = models.filter((row) => ownsModel(row, provider, url));
    const ownedRows = new Set(owned);
    const ourIds = new Set(provider.models.map((model) => model.id));
    const kept = rows.filter((row) => !isModel(row) || !ownedRows.has(row));
    for (const row of kept) {
      if (isModel(row) && ourIds.has(row.id)) {
        throw new Error(`${modelsFile}: model ${row.id} belongs to another account; refusing to overwrite it`);
      }
    }
    const previous = new Map(owned.map((row) => [row.id, row]));
    const ours: WorkbuddyModel[] = provider.models.map((model) => {
      const custom = { ...previous.get(model.id) };
      for (const key of OWNED_MODEL_KEYS) delete custom[key];
      return {
        ...custom,
        id: model.id,
        name: model.name ?? model.id,
        vendor: provider.name,
        url,
        apiKey: provider.apiKey,
        agentswProviderId: provider.id,
        ...(model.maxInput ?? model.contextWindow ? { maxInputTokens: model.maxInput ?? model.contextWindow } : {}),
        ...(model.maxOutput ? { maxOutputTokens: model.maxOutput } : {}),
        supportsToolCall: true,
        ...(model.imageInput !== undefined ? { supportsImages: !!model.imageInput } : {}),
        ...(model.reasoning !== undefined ? { supportsReasoning: !!model.reasoning } : {}),
      };
    });
    const removedIds = new Set(owned.map((row) => row.id));
    const keptIds = new Set(kept.filter(isModel).map((row) => row.id));
    const availableModels = [...new Set([
      ...existingAvailable.filter((id) => !removedIds.has(id) || keptIds.has(id)), ...ourIds,
    ])];
    settings.model = provider.defaultModel;

    const modelsBackup = backupFile(modelsFile);
    if (modelsBackup) notes.push(`backup: ${modelsBackup}`);
    writeFileAtomic(modelsFile, JSON.stringify({ ...container, models: [...kept, ...ours], availableModels }, null, 2) + "\n", 0o600);
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
    const { rows, models, container, availableModels: available, existed } = readWorkbuddyModels(modelsFile);
    if (!existed) return { app: this.id, changed: [], notes: [], skipped: "no models.json" };
    const endpoint = completionsUrl(provider.baseUrl);
    const owned = new Set(models.filter((row) => ownsModel(row, provider, endpoint)));
    if (!owned.size) return { app: this.id, changed: [], notes: [], skipped: "no entries from this provider" };
    const kept = rows.filter((row) => !isModel(row) || !owned.has(row));
    const keptIds = new Set(kept.filter(isModel).map((row) => row.id));
    const removedIds = new Set([...owned].map((row) => row.id));
    const settings = readJsonIfExists<Record<string, unknown>>(settingsFile);
    if (settings !== undefined && !isJsonObject(settings)) throw new Error(`${settingsFile}: expected a JSON object`);
    const notes: string[] = [];
    const modelsBackup = backupFile(modelsFile);
    if (modelsBackup) notes.push(`backup: ${modelsBackup}`);
    writeFileAtomic(modelsFile, JSON.stringify({
      ...container,
      models: kept,
      availableModels: available.filter((id) => !removedIds.has(id) || keptIds.has(id)),
    }, null, 2) + "\n", 0o600);

    const changed = [modelsFile];
    if (settings && typeof settings.model === "string" && removedIds.has(settings.model) && !keptIds.has(settings.model)) {
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
    const { models } = readWorkbuddyModels(path.join(configDir(), "models.json"));
    if (models.length === 0) return [];
    const settings = readJsonIfExists<{ model?: string }>(path.join(configDir(), "settings.json"));
    const groups = new Map<string, { candidate: ProviderCandidate; vendor?: string }>();
    for (const row of models) {
      if (typeof row.url !== "string" || !row.url) continue;
      const baseUrl = workbuddyBaseUrl(row.url);
      if (!baseUrl) continue;
      const apiKey = typeof row.apiKey === "string" ? row.apiKey : undefined;
      const key = JSON.stringify([baseUrl, apiKey ?? null]);
      let group = groups.get(key);
      if (!group) {
        const id = providerIdFromBaseUrl(baseUrl, "openai");
        const candidate: ProviderCandidate = {
          id,
          generatedId: true,
          name: providerNameFromBaseUrl(baseUrl, "openai"),
          protocol: "openai",
          baseUrl,
          apiKey,
          models: [],
          source: this.id,
        };
        candidate.localId = localProviderId(candidate);
        group = { candidate };
        groups.set(key, group);
      }
      if (!group.vendor && typeof row.vendor === "string" && row.vendor) {
        group.vendor = row.vendor;
        group.candidate.name = row.vendor;
      }
      if (!group.candidate.models.includes(row.id)) group.candidate.models.push(row.id);
      if (settings?.model === row.id) group.candidate.defaultModel = row.id;
    }
    return [...groups.values()].map((group) => group.candidate);
  },
});
