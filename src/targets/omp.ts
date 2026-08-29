import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { backupFile, home, readTextIfExists, writeFileAtomic } from "../fsutil.js";
import type { ApplyResult, Provider } from "../types.js";
import type { TargetApp } from "./types.js";

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
};
