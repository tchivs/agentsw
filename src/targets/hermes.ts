import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { backupFile, readTextIfExists, writeFileAtomic } from "../fsutil.js";
import type { ApplyResult, Provider } from "../types.js";
import type { TargetApp } from "./types.js";

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

    const keyVar = `SMART_SWITCH_${provider.id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
    const models: Record<string, unknown> = {};
    for (const m of provider.models) {
      models[m.id] = m.contextWindow ? { context_length: m.contextWindow } : {};
    }
    doc.setIn(
      ["providers", provider.id],
      doc.createNode({
        name: provider.name,
        api: provider.baseUrl,
        key_env: keyVar,
        transport: provider.protocol === "anthropic" ? "anthropic_messages" : "chat_completions",
        default_model: provider.defaultModel,
        models,
      }),
    );
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
};
