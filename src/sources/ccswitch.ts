import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { home } from "../fsutil.js";
import { slugFromBaseUrl } from "../slug.js";
import type { OpenAIApi, Protocol } from "../types.js";
import type { ProviderCandidate } from "../targets/types.js";
import { classifyApi } from "../targets/wire.js";

/** cc-switch (the Tauri desktop switcher) keeps every managed app's providers in one SQLite file. */
const storeFile = path.join(home, ".cc-switch", "cc-switch.db");

/** Source id shown in the `import` preview. */
export const CC_SWITCH_SOURCE = "cc-switch";

/** One `providers` row; `settings_config` mirrors the shape of the app that row manages. */
interface ProviderRow {
  app_type: string;
  name: string;
  settings_config: string;
  meta: string;
}

/** What one row resolves to before it becomes a candidate. */
type Parsed = Pick<ProviderCandidate, "protocol" | "openaiApi" | "baseUrl" | "apiKey" | "models" | "defaultModel">;

/** Claude Code / Claude Desktop rows: the env block, same shape agentsw's claude adapter writes. */
function fromEnvShape(settings: Record<string, unknown>): Parsed | undefined {
  const env = settings.env as Record<string, string> | undefined;
  if (!env?.ANTHROPIC_BASE_URL) return undefined;
  const models = [
    typeof settings.model === "string" ? settings.model : undefined,
    env.ANTHROPIC_MODEL,
    env.ANTHROPIC_DEFAULT_OPUS_MODEL,
    env.ANTHROPIC_DEFAULT_SONNET_MODEL,
    env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
  ].filter((m): m is string => Boolean(m));
  return {
    protocol: "anthropic",
    baseUrl: env.ANTHROPIC_BASE_URL,
    apiKey: env.ANTHROPIC_AUTH_TOKEN || env.ANTHROPIC_API_KEY || undefined,
    models: [...new Set(models)],
    defaultModel: models[0],
  };
}

/** Codex rows: `settings_config.config` is literal `config.toml` text, the key rides in `auth`. */
function fromCodexShape(settings: Record<string, unknown>): Parsed | undefined {
  const text = typeof settings.config === "string" ? settings.config : "";
  if (!text) return undefined;
  let config: Record<string, unknown>;
  try {
    config = parseToml(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const providers = config.model_providers as Record<string, Record<string, unknown>> | undefined;
  const active = typeof config.model_provider === "string" ? config.model_provider : undefined;
  const entry = (active ? providers?.[active] : undefined) ?? Object.values(providers ?? {})[0];
  if (!entry || typeof entry.base_url !== "string") return undefined;
  const model = typeof config.model === "string" ? config.model : undefined;
  const auth = settings.auth as Record<string, string> | undefined;
  return {
    protocol: "openai",
    // codex speaks the Responses API; only a legacy row still says "chat"
    openaiApi: entry.wire_api === "chat" ? "completions" : "responses",
    baseUrl: entry.base_url,
    apiKey: auth?.OPENAI_API_KEY || undefined,
    models: model ? [model] : [],
    defaultModel: model,
  };
}

/** opencode / OpenClaw / Hermes / pi rows carry the pi-family `api` + `baseUrl` + `models` shape. */
function fromPiShape(settings: Record<string, unknown>, meta: Record<string, unknown>): Parsed | undefined {
  if (typeof settings.baseUrl !== "string" || !settings.baseUrl) return undefined;
  const wire =
    classifyApi(settings.api) ?? (meta.apiFormat === "anthropic" ? { protocol: "anthropic" as Protocol } : undefined);
  if (!wire) return undefined;
  const models = Array.isArray(settings.models)
    ? (settings.models as Array<Record<string, unknown>>).map((m) => (typeof m?.id === "string" ? m.id : "")).filter(Boolean)
    : [];
  return {
    protocol: wire.protocol,
    openaiApi: wire.openaiApi,
    baseUrl: settings.baseUrl,
    apiKey: typeof settings.apiKey === "string" && settings.apiKey ? settings.apiKey : undefined,
    models,
    defaultModel: typeof settings.model === "string" ? settings.model : models[0],
  };
}

/** `node:sqlite` handle type, narrowed to what this reader uses. */
type SqliteModule = {
  DatabaseSync: new (
    file: string,
    options?: { readOnly?: boolean },
  ) => { prepare(sql: string): { all(): unknown[] }; close(): void };
};

/**
 * Load `node:sqlite`, swallowing the one-off "SQLite is an experimental feature"
 * warning it emits asynchronously on load: that this reader uses the built-in
 * driver is an implementation detail, not something an `import` run should shout
 * about. Every other warning is handed straight back to Node's own printer.
 */
function requireSqlite(): SqliteModule {
  const printers = process.listeners("warning") as Array<(warning: Error) => void>;
  process.removeAllListeners("warning");
  process.on("warning", (warning: Error) => {
    if (warning.name === "ExperimentalWarning" && /sqlite/i.test(warning.message)) return;
    for (const printer of printers) printer(warning);
  });
  return createRequire(import.meta.url)("node:sqlite") as SqliteModule;
}

/**
 * Read cc-switch's provider store so a user of the desktop app does not have to
 * re-enter anything. The database is opened read-only and nothing is ever written
 * back; a store this build cannot read (no `node:sqlite`, a newer schema, a locked
 * file) yields no candidates instead of failing the whole scan.
 */
export function ccSwitchCandidates(): ProviderCandidate[] {
  if (!fs.existsSync(storeFile)) return [];
  let rows: ProviderRow[];
  try {
    const db = new (requireSqlite().DatabaseSync)(storeFile, { readOnly: true });
    try {
      rows = db.prepare("SELECT app_type, name, settings_config, meta FROM providers").all() as ProviderRow[];
    } finally {
      db.close();
    }
  } catch {
    return [];
  }

  const out: ProviderCandidate[] = [];
  for (const row of rows) {
    let settings: Record<string, unknown>;
    let meta: Record<string, unknown>;
    try {
      settings = JSON.parse(row.settings_config || "{}") as Record<string, unknown>;
      meta = JSON.parse(row.meta || "{}") as Record<string, unknown>;
    } catch {
      continue;
    }
    // Rows are matched by shape rather than by app name, so an app cc-switch adds
    // later still imports as long as it stores one of these three layouts.
    const parsed = fromEnvShape(settings) ?? fromCodexShape(settings) ?? fromPiShape(settings, meta);
    if (!parsed) continue;
    const name = row.name || row.app_type;
    // cc-switch ids are UUIDs; the display name is what the user recognizes.
    const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "");
    out.push({
      id: /^[a-z0-9]/.test(slug) ? slug : slugFromBaseUrl(parsed.baseUrl),
      name,
      protocol: parsed.protocol,
      ...(parsed.openaiApi ? { openaiApi: parsed.openaiApi as OpenAIApi } : {}),
      baseUrl: parsed.baseUrl,
      apiKey: parsed.apiKey,
      models: parsed.models,
      defaultModel: parsed.defaultModel,
      source: CC_SWITCH_SOURCE,
    });
  }
  return out;
}
