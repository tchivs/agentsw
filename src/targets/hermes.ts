import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { backupFile, readTextIfExists, writeFileAtomic } from "../fsutil.js";
import type { ApplyResult, Provider } from "../types.js";
import type { ProviderCandidate, TargetApp } from "./types.js";

function hermesHome(): string {
  const env = process.env.HERMES_HOME?.trim();
  if (env) return env;
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    return path.join(process.env.LOCALAPPDATA, "hermes");
  }
  return path.join(process.env.HOME ?? "", ".hermes");
}

/**
 * hermes (NousResearch): providers dict + model section in ~/.hermes/config.yaml,
 * API key in ~/.hermes/.env referenced via key_env. hermes refuses to load an
 * unparseable config.yaml, so we round-trip through YAML Document (comments kept).
 */
export const hermes: TargetApp = {
  id: "hermes",
  name: "Hermes",
  protocols: ["openai", "anthropic"],
  configPaths: [path.join(hermesHome(), "config.yaml"), path.join(hermesHome(), ".env")],

  detect: () => fs.existsSync(hermesHome()),

  async apply(provider: Provider): Promise<ApplyResult> {
    const home = hermesHome();
    const configFile = path.join(home, "config.yaml");
    const envFile = path.join(home, ".env");
    const notes: string[] = [];

    const text = readTextIfExists(configFile);
    const doc = text ? YAML.parseDocument(text) : new YAML.Document({});
    if (doc.errors.length) {
      throw new Error(`${configFile} has YAML errors; refusing to rewrite: ${doc.errors[0]?.message}`);
    }
    if (doc.contents == null) doc.contents = doc.createNode({});
    const keyVar = `AGENTSW_${provider.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
    const at = ["providers", provider.id];
    const prev = (doc.getIn(at) as YAML.YAMLMap | undefined)?.toJSON?.() as Record<string, unknown> | undefined;
    const prevModels = (prev?.models ?? {}) as Record<string, Record<string, unknown>>;
    const models: Record<string, unknown> = {};
    for (const m of provider.models) {
      const old = { ...prevModels[m.id] };
      delete old.context_length; // owned: a model that loses its size must not keep the old one
      models[m.id] = { ...old, ...(m.contextWindow ? { context_length: m.contextWindow } : {}) };
    }
    const entry: Record<string, unknown> = {
      name: provider.name,
      api: provider.baseUrl,
      key_env: keyVar,
      transport: provider.protocol === "anthropic" ? "anthropic_messages" : "chat_completions",
      default_model: provider.defaultModel,
      models,
    };
    // Key-by-key when the route exists: provider-level keys agentsw does not model
    // (and their comments) belong to the user.
    if (YAML.isMap(doc.getIn(at))) {
      for (const [key, value] of Object.entries(entry)) doc.setIn([...at, key], doc.createNode(value));
    } else {
      doc.setIn(at, doc.createNode(entry));
    }
    doc.setIn(["model", "provider"], provider.id);
    doc.setIn(["model", "default"], provider.defaultModel);

    const configBackup = backupFile(configFile);
    if (configBackup) notes.push(`backup: ${configBackup}`);
    writeFileAtomic(configFile, doc.toString());

    // upsert the key into ~/.hermes/.env
    const envText = readTextIfExists(envFile) ?? "";
    const line = `${keyVar}=${provider.apiKey}`;
    const pattern = new RegExp(`^${keyVar}=.*$`, "m");
    const nextEnv = pattern.test(envText)
      ? envText.replace(pattern, line)
      : envText + (envText.endsWith("\n") || envText === "" ? "" : "\n") + line + "\n";
    const envBackup = backupFile(envFile);
    if (envBackup) notes.push(`backup: ${envBackup}`);
    writeFileAtomic(envFile, nextEnv, 0o600);

    return { app: this.id, changed: [configFile, envFile], notes };
  },

  async prune(provider: Provider): Promise<ApplyResult> {
    const home = hermesHome();
    const configFile = path.join(home, "config.yaml");
    const envFile = path.join(home, ".env");
    const text = readTextIfExists(configFile);
    if (!text) return { app: this.id, changed: [], notes: [], skipped: "no config.yaml" };
    const doc = YAML.parseDocument(text);
    if (doc.errors.length) {
      throw new Error(`${configFile} has YAML errors; refusing to rewrite: ${doc.errors[0]?.message}`);
    }
    if (!doc.hasIn(["providers", provider.id])) {
      return { app: this.id, changed: [], notes: [], skipped: `no providers.${provider.id} entry` };
    }
    doc.deleteIn(["providers", provider.id]);
    const notes: string[] = [];
    if (doc.getIn(["model", "provider"]) === provider.id) {
      doc.deleteIn(["model", "provider"]);
      doc.deleteIn(["model", "default"]);
      notes.push("model selection reset (was pointing at this provider)");
    }
    // drop now-empty sections instead of leaving "model: {}" / "providers: {}"
    for (const key of ["model", "providers"]) {
      const node = doc.get(key);
      if (YAML.isMap(node) && node.items.length === 0) doc.delete(key);
    }
    const changed = [configFile];
    const configBackup = backupFile(configFile);
    if (configBackup) notes.push(`backup: ${configBackup}`);
    writeFileAtomic(configFile, doc.toString());

    const keyVar = `AGENTSW_${provider.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
    const envText = readTextIfExists(envFile);
    if (envText && new RegExp(`^${keyVar}=`, "m").test(envText)) {
      const envBackup = backupFile(envFile);
      if (envBackup) notes.push(`backup: ${envBackup}`);
      writeFileAtomic(envFile, envText.replace(new RegExp(`^${keyVar}=.*\\n?`, "m"), ""), 0o600);
      changed.push(envFile);
    }
    return { app: this.id, changed, notes };
  },

  current(): string | undefined {
    const text = readTextIfExists(path.join(hermesHome(), "config.yaml"));
    if (!text) return undefined;
    try {
      const parsed = YAML.parse(text) as { model?: { provider?: string; default?: string; model?: string } } | null;
      if (!parsed?.model?.provider) return undefined;
      return `${parsed.model.provider} · ${parsed.model.default ?? parsed.model.model ?? "?"}`;
    } catch {
      return undefined;
    }
  },

  candidates(): ProviderCandidate[] {
    const hh = hermesHome();
    const text = readTextIfExists(path.join(hh, "config.yaml"));
    if (!text) return [];
    type HermesConfig = {
      providers?: Record<
        string,
        { name?: string; api?: string; key_env?: string; transport?: string; default_model?: string; models?: Record<string, unknown> }
      >;
      model?: { provider?: string; default?: string; model?: string };
    };
    let parsed: HermesConfig | undefined;
    try {
      parsed = YAML.parse(text) as HermesConfig | undefined;
    } catch {
      return [];
    }
    if (!parsed?.providers) return [];
    const envText = readTextIfExists(path.join(hh, ".env")) ?? "";
    const readEnv = (key: string): string | undefined =>
      process.env[key] ?? (envText.match(new RegExp(`^${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}=(.*)$`, "m"))?.[1]?.trim() || undefined);
    const self = this.id;
    return Object.entries(parsed.providers).flatMap(([id, entry]) => {
      if (!entry || typeof entry.api !== "string" || !entry.api) return [];
      const protocol =
        entry.transport === "anthropic_messages" ? "anthropic" : entry.transport === "chat_completions" ? "openai" : undefined;
      if (!protocol) return [];
      const keyEnv = typeof entry.key_env === "string" && entry.key_env ? entry.key_env : undefined;
      const apiKey = keyEnv ? readEnv(keyEnv) : undefined;
      const models = Object.keys(entry.models ?? {});
      const active = parsed?.model?.provider === id ? parsed?.model?.default ?? parsed?.model?.model : undefined;
      const defaultModel = entry.default_model ?? active;
      if (defaultModel && !models.includes(defaultModel)) models.unshift(defaultModel);
      return [{ id, name: entry.name ?? id, protocol, baseUrl: entry.api, apiKey, keyEnv, models, defaultModel, source: self }];
    });
  },
};
