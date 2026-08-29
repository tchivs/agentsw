import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { backupFile, home, readTextIfExists, writeFileAtomic } from "../fsutil.js";
import { looksLikeEnvName } from "../slug.js";
import type { ApplyResult, Provider } from "../types.js";
import type { ProviderCandidate, TargetApp } from "./types.js";

const agentDir = path.join(home, ".omp", "agent");
const modelsYml = path.join(agentDir, "models.yml");
const modelsYaml = path.join(agentDir, "models.yaml");

/**
 * Oh My Pi: providers live in ~/.omp/agent/models.yml (models.yaml fallback).
 * YAML Document round-trip preserves existing comments and unrelated providers.
 */
export const omp: TargetApp = {
  id: "omp",
  name: "Oh My Pi",
  protocols: ["openai", "anthropic"],
  configPaths: [modelsYml],

  detect: () => fs.existsSync(path.join(home, ".omp")),

  async apply(provider: Provider): Promise<ApplyResult> {
    const notes: string[] = [];
    // Respect an existing models.yaml if models.yml is absent (omp precedence: yml then yaml).
    const file = !fs.existsSync(modelsYml) && fs.existsSync(modelsYaml) ? modelsYaml : modelsYml;
    const text = readTextIfExists(file);
    const doc = text ? YAML.parseDocument(text) : new YAML.Document({});
    if (doc.errors.length) {
      throw new Error(`${file} has YAML errors; refusing to rewrite: ${doc.errors[0]?.message}`);
    }
    if (doc.contents == null) doc.contents = doc.createNode({});

    const anthropic = provider.protocol === "anthropic";
    const entry: Record<string, unknown> = {
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey, // omp treats value as env-var name first, then literal
      api: anthropic ? "anthropic-messages" : "openai-completions",
      models: provider.models.map((m) => ({
        id: m.id,
        ...(m.name ? { name: m.name } : {}),
        ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
        input: m.imageInput ? ["text", "image"] : ["text"],
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
        ...(m.maxOutput ? { maxTokens: m.maxOutput } : {}),
        ...(m.cost
          ? {
              cost: {
                input: m.cost.input ?? 0,
                output: m.cost.output ?? 0,
                cacheRead: m.cost.cacheRead ?? 0,
                cacheWrite: m.cost.cacheWrite ?? 0,
              },
            }
          : {}),
      })),
    };
    if (anthropic) {
      // Most Anthropic-fronted proxies reject the strict tool field.
      entry.disableStrictTools = true;
    }
    doc.setIn(["providers", provider.id], doc.createNode(entry));

    const backup = backupFile(file);
    if (backup) notes.push(`backup: ${backup}`);
    writeFileAtomic(file, doc.toString());
    notes.push(`select in omp with: omp --model ${provider.id}/${provider.defaultModel}`);
    return { app: this.id, changed: [file], notes };
  },

  async prune(provider: Provider): Promise<ApplyResult> {
    const file = fs.existsSync(modelsYml) ? modelsYml : fs.existsSync(modelsYaml) ? modelsYaml : undefined;
    if (!file) return { app: this.id, changed: [], notes: [], skipped: "no models.yml" };
    const doc = YAML.parseDocument(readTextIfExists(file) ?? "");
    if (doc.errors.length) {
      throw new Error(`${file} has YAML errors; refusing to rewrite: ${doc.errors[0]?.message}`);
    }
    if (!doc.hasIn(["providers", provider.id])) {
      return { app: this.id, changed: [], notes: [], skipped: `no providers.${provider.id} entry` };
    }
    doc.deleteIn(["providers", provider.id]);
    const notes: string[] = [];
    const backup = backupFile(file);
    if (backup) notes.push(`backup: ${backup}`);
    writeFileAtomic(file, doc.toString());
    return { app: this.id, changed: [file], notes };
  },

  current(): string | undefined {
    const file = fs.existsSync(modelsYml) ? modelsYml : fs.existsSync(modelsYaml) ? modelsYaml : undefined;
    if (!file) return undefined;
    try {
      const parsed = YAML.parse(readTextIfExists(file) ?? "") as { providers?: Record<string, unknown> } | null;
      const ids = Object.keys(parsed?.providers ?? {});
      return ids.length ? `providers: ${ids.join(", ")}` : undefined;
    } catch {
      return undefined;
    }
  },

  candidates(): ProviderCandidate[] {
    const file = fs.existsSync(modelsYml) ? modelsYml : fs.existsSync(modelsYaml) ? modelsYaml : undefined;
    if (!file) return [];
    type OmpConfig = { providers?: Record<string, Record<string, unknown>> };
    let parsed: OmpConfig | undefined;
    try {
      parsed = YAML.parse(readTextIfExists(file) ?? "") as OmpConfig | undefined;
    } catch {
      return [];
    }
    if (!parsed?.providers) return [];
    const self = this.id;
    return Object.entries(parsed.providers).flatMap(([id, entry]) => {
      if (!entry || typeof entry.baseUrl !== "string") return [];
      const protocol =
        entry.api === "anthropic-messages" ? "anthropic" : entry.api === "openai-completions" ? "openai" : undefined;
      if (!protocol) return [];
      let apiKey: string | undefined;
      let keyEnv: string | undefined;
      if (typeof entry.apiKey === "string" && entry.apiKey) {
        if (looksLikeEnvName(entry.apiKey) && process.env[entry.apiKey]) {
          keyEnv = entry.apiKey;
          apiKey = process.env[entry.apiKey];
        } else {
          // omp resolves env-var names first, then uses the value as a literal key
          apiKey = entry.apiKey;
        }
      }
      const models = Array.isArray(entry.models)
        ? (entry.models as Array<Record<string, unknown>>)
            .map((m) => (typeof m?.id === "string" ? m.id : ""))
            .filter(Boolean)
        : [];
      return [{ id, name: typeof entry.name === "string" ? entry.name : id, protocol, baseUrl: entry.baseUrl, apiKey, keyEnv, models, source: self }];
    });
  },
};
