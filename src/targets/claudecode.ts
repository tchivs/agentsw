import fs from "node:fs";
import path from "node:path";
import { backupFile, home, readJsonIfExists, writeFileAtomic } from "../fsutil.js";
import { providerIdFromBaseUrl, providerNameFromBaseUrl } from "../slug.js";
import { stripApiVersion } from "./wire.js";
import type { ApplyResult, Provider } from "../types.js";
import type { ProviderCandidate, TargetApp } from "./types.js";

const dir = path.join(home, ".claude");
const settingsFile = path.join(dir, "settings.json");

/**
 * Claude Code reads Anthropic-protocol endpoints via env vars in ~/.claude/settings.json.
 * We merge the "env" block and leave every other setting untouched.
 */
export const claudecode: TargetApp = {
  id: "claude",
  name: "Claude Code",
  protocols: ["anthropic"],
  configPaths: [settingsFile],

  detect: () => fs.existsSync(dir),

  async apply(provider: Provider): Promise<ApplyResult> {
    const notes: string[] = [];
    const settings = readJsonIfExists<Record<string, unknown>>(settingsFile) ?? {};
    const env = { ...(settings.env as Record<string, string> | undefined) };

    env.ANTHROPIC_BASE_URL = stripApiVersion(provider.baseUrl);
    env.ANTHROPIC_AUTH_TOKEN = provider.apiKey;
    delete env.ANTHROPIC_API_KEY; // AUTH_TOKEN and API_KEY conflict; keep one
    env.ANTHROPIC_MODEL = provider.defaultModel;
    env.ANTHROPIC_DEFAULT_OPUS_MODEL = provider.defaultModel;
    env.ANTHROPIC_DEFAULT_SONNET_MODEL = provider.defaultModel;
    env.ANTHROPIC_REASONING_MODEL = provider.defaultModel;
    const small = provider.smallModel ?? provider.defaultModel;
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL = small;
    env.ANTHROPIC_SMALL_FAST_MODEL = small;

    settings.env = env;
    const backup = backupFile(settingsFile);
    if (backup) notes.push(`backup: ${backup}`);
    writeFileAtomic(settingsFile, JSON.stringify(settings, null, 2) + "\n");
    return { app: this.id, changed: [settingsFile], notes };
  },

  async prune(provider: Provider): Promise<ApplyResult> {
    const settings = readJsonIfExists<Record<string, unknown>>(settingsFile);
    const env = settings?.env as Record<string, string> | undefined;
    if (!settings || !env || env.ANTHROPIC_BASE_URL !== stripApiVersion(provider.baseUrl)) {
      return { app: this.id, changed: [], notes: [], skipped: "claude env does not point at this provider" };
    }
    for (const key of [
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_MODEL",
      "ANTHROPIC_DEFAULT_OPUS_MODEL",
      "ANTHROPIC_DEFAULT_SONNET_MODEL",
      "ANTHROPIC_DEFAULT_HAIKU_MODEL",
      "ANTHROPIC_REASONING_MODEL",
      "ANTHROPIC_SMALL_FAST_MODEL",
    ]) {
      delete env[key];
    }
    const notes: string[] = [];
    const backup = backupFile(settingsFile);
    if (backup) notes.push(`backup: ${backup}`);
    writeFileAtomic(settingsFile, JSON.stringify(settings, null, 2) + "\n");
    return { app: this.id, changed: [settingsFile], notes };
  },

  current(): string | undefined {
    const env = readJsonIfExists<{ env?: Record<string, string> }>(settingsFile)?.env;
    if (!env?.ANTHROPIC_BASE_URL) return undefined;
    return `${env.ANTHROPIC_BASE_URL} · ${env.ANTHROPIC_MODEL ?? "?"}`;
  },

  candidates(): ProviderCandidate[] {
    const env = readJsonIfExists<{ env?: Record<string, string> }>(settingsFile)?.env;
    const baseUrl = env?.ANTHROPIC_BASE_URL;
    if (!baseUrl) return [];
    const models = [
      env.ANTHROPIC_MODEL,
      env.ANTHROPIC_DEFAULT_OPUS_MODEL,
      env.ANTHROPIC_DEFAULT_SONNET_MODEL,
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
      env.ANTHROPIC_REASONING_MODEL,
      env.ANTHROPIC_SMALL_FAST_MODEL,
    ].filter((m): m is string => !!m);
    const id = providerIdFromBaseUrl(baseUrl, "anthropic");
    return [
      {
        id,
        generatedId: true,
        name: providerNameFromBaseUrl(baseUrl, "anthropic"),
        protocol: "anthropic",
        baseUrl,
        apiKey: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || undefined,
        models: [...new Set(models)],
        defaultModel: env.ANTHROPIC_MODEL,
        source: this.id,
      },
    ];
  },
};
