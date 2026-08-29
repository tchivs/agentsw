import fs from "node:fs";
import path from "node:path";
import { backupFile, home, readJsonIfExists, writeFileAtomic } from "../fsutil.js";
import type { ApplyResult, Provider } from "../types.js";
import type { TargetApp } from "./types.js";

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

    env.ANTHROPIC_BASE_URL = provider.baseUrl;
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

  current(): string | undefined {
    const env = readJsonIfExists<{ env?: Record<string, string> }>(settingsFile)?.env;
    if (!env?.ANTHROPIC_BASE_URL) return undefined;
    return `${env.ANTHROPIC_BASE_URL} · ${env.ANTHROPIC_MODEL ?? "?"}`;
  },
};
