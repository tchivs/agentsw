import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { backupFile, home, localAppDataDir, readTextIfExists, writeFileAtomic } from "../fsutil.js";
import { envAssignments, removeEnvAssignments, upsertEnvAssignment } from "../envfile.js";
import { isManagedCredentialRef, legacyManagedCredentialRef, managedCredentialRef } from "../provider-identity.js";
import { transactionalTarget } from "../target-transaction.js";
import { parseYamlMapping, serializeYamlMapping } from "../yaml.js";
import type { ApplyResult, Provider } from "../types.js";
import { sdkBaseUrl } from "./wire.js";
import type { ProviderCandidate, TargetApp } from "./types.js";

function hermesHome(): string {
  const env = process.env.HERMES_HOME?.trim();
  if (env) return env;
  if (process.platform === "win32") {
    return localAppDataDir("hermes");
  }
  return path.join(home, ".hermes");
}

function parseConfig(file: string, text: string | undefined): YAML.Document {
  const doc = parseYamlMapping(file, text);
  for (const key of ["providers", "model"]) {
    if (doc.has(key) && !YAML.isMap(doc.get(key))) throw new Error(`${file}: expected ${key} to be a mapping`);
  }
  const providers = doc.get("providers");
  if (YAML.isMap(providers)) {
    for (const pair of providers.items) {
      if (!YAML.isMap(pair.value)) throw new Error(`${file}: expected provider mappings`);
      const models = pair.value.get("models");
      if (models !== undefined && (!YAML.isMap(models) || models.items.some((model) => !YAML.isMap(model.value)))) {
        throw new Error(`${file}: expected model mappings`);
      }
    }
  }
  return doc;
}

function credentialReferences(doc: YAML.Document, exceptId?: string): Set<string> {
  const refs = new Set<string>();
  const providers = doc.get("providers");
  if (YAML.isMap(providers)) {
    for (const pair of providers.items) {
      if ((YAML.isScalar(pair.key) ? pair.key.value : pair.key) === exceptId) continue;
      const ref = YAML.isMap(pair.value) ? pair.value.get("key_env") : undefined;
      if (typeof ref === "string") refs.add(ref);
    }
  }
  return refs;
}

/**
 * hermes (NousResearch): providers dict + model section in ~/.hermes/config.yaml,
 * API key in ~/.hermes/.env referenced via key_env. hermes refuses to load an
 * unparseable config.yaml, so we round-trip through YAML Document (comments kept).
 */
export const hermes: TargetApp = transactionalTarget({
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
    const doc = parseConfig(configFile, text);
    const keyVar = managedCredentialRef(provider.id);
    const at = ["providers", provider.id];
    const prev = (doc.getIn(at) as YAML.YAMLMap | undefined)?.toJSON?.() as Record<string, unknown> | undefined;
    const entry: Record<string, unknown> = {
      name: provider.name,
      api: sdkBaseUrl(provider.protocol, provider.baseUrl),
      key_env: keyVar,
      transport:
        provider.protocol === "anthropic"
          ? "anthropic_messages"
          : provider.openaiApi === "responses" || (provider.openaiApi === undefined && prev?.transport === "codex_responses")
            ? "codex_responses"
            : "chat_completions",
      default_model: provider.defaultModel,
    };
    // Key-by-key when the route exists: provider-level keys agentsw does not model
    // (and their comments) belong to the user.
    if (YAML.isMap(doc.getIn(at))) {
      for (const [key, value] of Object.entries(entry)) doc.setIn([...at, key], value);
    } else {
      doc.setIn(at, doc.createNode(entry));
    }
    const modelsAt = [...at, "models"];
    if (!doc.hasIn(modelsAt)) doc.setIn(modelsAt, doc.createNode({}));
    const models = doc.getIn(modelsAt) as YAML.YAMLMap;
    const modelIds = new Set(provider.models.map((model) => model.id));
    for (const pair of [...models.items]) {
      if (YAML.isScalar(pair.key) && !modelIds.has(String(pair.key.value))) models.delete(pair.key.value);
    }
    for (const model of provider.models) {
      const modelAt = [...modelsAt, model.id];
      if (!doc.hasIn(modelAt)) doc.setIn(modelAt, doc.createNode({}));
      if (model.contextWindow) doc.setIn([...modelAt, "context_length"], model.contextWindow);
      else doc.deleteIn([...modelAt, "context_length"]);
    }
    doc.setIn(["model", "provider"], provider.id);
    doc.setIn(["model", "default"], provider.defaultModel);

    const envText = readTextIfExists(envFile) ?? "";
    const assignments = envAssignments(envFile, envText);
    const referenced = credentialReferences(doc, provider.id);
    if (referenced.has(keyVar) && assignments.filter((assignment) => assignment.name === keyVar).at(-1)?.value !== provider.apiKey) {
      throw new Error(`${envFile}: credential reference is shared by another provider; refusing to replace it`);
    }
    let nextEnv = upsertEnvAssignment(envFile, envText, keyVar, provider.apiKey);
    const oldRef = prev?.key_env;
    if (typeof oldRef === "string" && oldRef !== keyVar && isManagedCredentialRef(oldRef, provider.id) && !referenced.has(oldRef)) {
      nextEnv = removeEnvAssignments(envFile, nextEnv, new Set([oldRef]));
    }
    const nextConfig = serializeYamlMapping(configFile, doc);

    const configBackup = backupFile(configFile);
    if (configBackup) notes.push(`backup: ${configBackup}`);
    writeFileAtomic(configFile, nextConfig);

    const envBackup = backupFile(envFile);
    if (envBackup) notes.push(`backup: ${envBackup}`);
    writeFileAtomic(envFile, nextEnv, 0o600);

    return { app: this.id, changed: [configFile, envFile], notes };
  },

  async prune(provider: Provider): Promise<ApplyResult> {
    const home = hermesHome();
    const configFile = path.join(home, "config.yaml");
    const envFile = path.join(home, ".env");
    const doc = parseConfig(configFile, readTextIfExists(configFile));
    const at = ["providers", provider.id];
    const hasProvider = doc.hasIn(at);
    const notes: string[] = [];
    if (hasProvider) doc.deleteIn(at);
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
    const referenced = credentialReferences(doc);
    const removable = new Set([managedCredentialRef(provider.id), legacyManagedCredentialRef(provider.id)].filter((ref) => !referenced.has(ref)));
    const envText = readTextIfExists(envFile);
    const nextEnv = envText === undefined ? undefined : removeEnvAssignments(envFile, envText, removable);
    const changed: string[] = [];
    if (hasProvider) {
      const config = serializeYamlMapping(configFile, doc);
      const configBackup = backupFile(configFile);
      if (configBackup) notes.push(`backup: ${configBackup}`);
      writeFileAtomic(configFile, config);
      changed.push(configFile);
    }
    if (nextEnv !== undefined && nextEnv !== envText) {
      const envBackup = backupFile(envFile);
      if (envBackup) notes.push(`backup: ${envBackup}`);
      writeFileAtomic(envFile, nextEnv, 0o600);
      changed.push(envFile);
    }
    return changed.length ? { app: this.id, changed, notes } : { app: this.id, changed, notes, skipped: `no providers.${provider.id} entry or managed credential` };
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
    const envFile = path.join(hh, ".env");
    const envText = readTextIfExists(envFile) ?? "";
    const values = new Map(envAssignments(envFile, envText).map((assignment) => [assignment.name, assignment.value]));
    const readEnv = (key: string): string | undefined => process.env[key] ?? values.get(key);
    const self = this.id;
    return Object.entries(parsed.providers).flatMap(([id, entry]) => {
      if (!entry || typeof entry.api !== "string" || !entry.api) return [];
      const protocol =
        entry.transport === "anthropic_messages"
          ? "anthropic"
          : ["chat_completions", "codex_responses"].includes(entry.transport ?? "")
            ? "openai"
            : undefined;
      if (!protocol) return [];
      const openaiApi = protocol === "openai" ? (entry.transport === "codex_responses" ? "responses" : "completions") : undefined;
      const keyEnv = typeof entry.key_env === "string" && entry.key_env ? entry.key_env : undefined;
      const apiKey = keyEnv ? readEnv(keyEnv) : undefined;
      const models = Object.keys(entry.models ?? {});
      const active = parsed?.model?.provider === id ? parsed?.model?.default ?? parsed?.model?.model : undefined;
      const defaultModel = entry.default_model ?? active;
      if (defaultModel && !models.includes(defaultModel)) models.unshift(defaultModel);
      return [{ id, name: entry.name ?? id, protocol, openaiApi, baseUrl: entry.api, apiKey, keyEnv, models, defaultModel, source: self }];
    });
  },
});
