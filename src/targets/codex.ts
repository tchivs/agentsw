import fs from "node:fs";
import path from "node:path";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { backupFile, home, readJsonIfExists, readTextIfExists, writeFileAtomic } from "../fsutil.js";
import type { ApplyResult, Provider } from "../types.js";
import type { ProviderCandidate, TargetApp } from "./types.js";

const dir = path.join(home, ".codex");
const configFile = path.join(dir, "config.toml");
const authFile = path.join(dir, "auth.json");

/**
 * Codex CLI: [model_providers.<id>] in ~/.codex/config.toml selects a custom
 * OpenAI-protocol endpoint; the key ships via ~/.codex/auth.json OPENAI_API_KEY.
 * TOML round-trip via smol-toml preserves data but not comments (backed up first).
 */
export const codex: TargetApp = {
  id: "codex",
  name: "Codex CLI",
  protocols: ["openai"],
  configPaths: [configFile, authFile],

  detect: () => fs.existsSync(dir),

  async apply(provider: Provider): Promise<ApplyResult> {
    const notes: string[] = [];
    const text = readTextIfExists(configFile);
    const config = (text ? parseToml(text) : {}) as Record<string, unknown>;

    config.model_provider = provider.id;
    config.model = provider.defaultModel;
    const model = provider.models.find((m) => m.id === provider.defaultModel);
    if (provider.reasoningEffort && model?.reasoning !== false) {
      config.model_reasoning_effort = provider.reasoningEffort;
    }

    // Codex only speaks the OpenAI Responses API (wire_api = "chat" was removed Feb 2026).
    // requires_openai_auth = true makes Codex take the key from auth.json instead of an env var.
    const providers = (config.model_providers ?? {}) as Record<string, unknown>;
    providers[provider.id] = {
      name: provider.name,
      base_url: provider.baseUrl.replace(/\/$/, ""),
      wire_api: "responses",
      requires_openai_auth: true,
    };
    notes.push("codex requires an OpenAI Responses-compatible endpoint (/v1/responses); chat-completions-only endpoints will not work");
    config.model_providers = providers;

    const configBackup = backupFile(configFile);
    if (configBackup) notes.push(`backup: ${configBackup}`);
    if (text?.includes("#")) notes.push("config.toml comments are not preserved by TOML round-trip");
    writeFileAtomic(configFile, stringifyToml(config) + "\n");

    const auth = readJsonIfExists<Record<string, unknown>>(authFile) ?? {};
    auth.auth_mode = "apikey";
    auth.OPENAI_API_KEY = provider.apiKey;
    const authBackup = backupFile(authFile);
    if (authBackup) notes.push(`backup: ${authBackup}`);
    writeFileAtomic(authFile, JSON.stringify(auth, null, 2) + "\n", 0o600);

    return { app: this.id, changed: [configFile, authFile], notes };
  },

  async prune(provider: Provider): Promise<ApplyResult> {
    const text = readTextIfExists(configFile);
    if (!text) return { app: this.id, changed: [], notes: [], skipped: "no config.toml" };
    const config = parseToml(text) as Record<string, unknown>;
    const providers = config.model_providers as Record<string, unknown> | undefined;
    if (!providers?.[provider.id]) {
      return { app: this.id, changed: [], notes: [], skipped: `no model_providers.${provider.id} entry` };
    }
    delete providers[provider.id];
    if (Object.keys(providers).length === 0) delete config.model_providers;
    const notes: string[] = [];
    if (config.model_provider === provider.id) {
      delete config.model_provider;
      delete config.model;
      delete config.model_reasoning_effort;
      notes.push("codex was pointing at this provider; model selection reset to defaults");
    }
    const backup = backupFile(configFile);
    if (backup) notes.push(`backup: ${backup}`);
    writeFileAtomic(configFile, stringifyToml(config) + "\n");
    notes.push("auth.json OPENAI_API_KEY left in place (not attributable to one provider)");
    return { app: this.id, changed: [configFile], notes };
  },

  current(): string | undefined {
    const text = readTextIfExists(configFile);
    if (!text) return undefined;
    try {
      const config = parseToml(text) as Record<string, unknown>;
      if (!config.model_provider) return undefined;
      return `${String(config.model_provider)} · ${String(config.model ?? "?")}`;
    } catch {
      return undefined;
    }
  },

  candidates(): ProviderCandidate[] {
    const text = readTextIfExists(configFile);
    if (!text) return [];
    let config: Record<string, unknown>;
    try {
      config = parseToml(text) as Record<string, unknown>;
    } catch {
      return [];
    }
    const providers = config.model_providers as Record<string, Record<string, unknown>> | undefined;
    if (!providers) return [];
    const auth = readJsonIfExists<{ OPENAI_API_KEY?: string; tokens?: { access_token?: string } }>(authFile);
    const authKey = auth?.OPENAI_API_KEY || auth?.tokens?.access_token;
    const active = typeof config.model_provider === "string" ? config.model_provider : undefined;
    const self = this.id;
    return Object.entries(providers).flatMap(([id, entry]) => {
      if (!entry || typeof entry.base_url !== "string") return [];
      const envKey = typeof entry.env_key === "string" ? entry.env_key : undefined;
      const apiKey =
        (envKey ? process.env[envKey] : undefined) ?? (active === id && entry.requires_openai_auth ? authKey : undefined);
      const models = active === id && typeof config.model === "string" ? [config.model] : [];
      return [
        {
          id,
          name: typeof entry.name === "string" ? entry.name : id,
          protocol: "openai" as const,
          // codex config declares its wire explicitly; legacy configs may still carry "chat"
          openaiApi: entry.wire_api === "chat" ? ("completions" as const) : ("responses" as const),
          baseUrl: entry.base_url,
          apiKey: apiKey || undefined,
          keyEnv: envKey,
          models,
          defaultModel: models[0],
          source: self,
        },
      ];
    });
  },
};
