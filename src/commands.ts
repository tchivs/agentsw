import path from "node:path";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { parseDocument } from "yaml";
import { envAssignments } from "./envfile.js";
import pc from "picocolors";
import prompts from "prompts";
import { loadStore, saveStore, getProvider, configFile } from "./store.js";
import { scanCandidates, normalizeUrl, findMatchingProvider, type MergedCandidate } from "./import.js";
import { loadCatalog, searchCatalog, type Catalog } from "./modelsdev.js";
import { enrichProviderModels, getMetadataMode, resolveMetadataOptions, type MetadataOptions } from "./metadata.js";
import { loadGatewayCatalog, type GatewayCatalog } from "./gateway.js";
import { resolveTargets, supportsProtocol, targets } from "./targets/index.js";
import { discoverProviderModels, probeProtocols } from "./discover.js";
import { appCommand, appPackages, installedVersion, isNewer, latestVersion, normalizeAppVersion, runShell } from "./apps.js";
import { drainPendingWrites, readTextIfExists, setDryRun } from "./fsutil.js";
import { applyModelFilter, type ModelFilter } from "./filter.js";
import { availableProviderId, providerIdFromBaseUrl, providerNameFromBaseUrl } from "./slug.js";
import { t } from "./i18n.js";
import type { ApplyResult, ModelSpec, OpenAIApi, Protocol, Provider } from "./types.js";

/** Share successes and failures without fetching until a model actually needs the supplement. */
function sharedGatewayLoader(refresh = false): () => Promise<GatewayCatalog | null> {
  let pending: Promise<GatewayCatalog | null> | undefined;
  return () => pending ??= loadGatewayCatalog({ refresh }).then((catalog) => catalog ?? null);
}

function fail(message: string): never {
  process.stderr.write(pc.red(`error: ${message}\n`));
  process.exit(1);
}

function table(rows: string[][], header?: string[]): string {
  const all = header ? [header, ...rows] : rows;
  if (all.length === 0) return "";
  const widths: number[] = [];
  for (const row of all) {
    row.forEach((cell, i) => {
      // eslint-disable-next-line no-control-regex
      const len = cell.replace(/\u001b\[[0-9;]*m/g, "").length;
      widths[i] = Math.max(widths[i] ?? 0, len);
    });
  }
  const render = (row: string[]) =>
    row
      .map((cell, i) => {
        const len = cell.replace(/\u001b\[[0-9;]*m/g, "").length;
        return cell + " ".repeat((widths[i] ?? 0) - len);
      })
      .join("  ")
      .trimEnd();
  const lines = all.map(render);
  if (header) lines.splice(1, 0, widths.map((w) => "-".repeat(w)).join("  "));
  return lines.join("\n");
}

function fmtTokens(n?: number): string {
  if (!n) return "-";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

function modelRows(models: ModelSpec[]): string[][] {
  return models.map((m) => [
    m.id,
    fmtTokens(m.contextWindow),
    fmtTokens(m.maxInput),
    fmtTokens(m.maxOutput),
    m.reasoning === undefined ? "-" : m.reasoning ? (m.reasoningEfforts?.length ? m.reasoningEfforts.join("/") : "yes") : "no",
    m.cost ? `$${m.cost.input ?? "?"}/$${m.cost.output ?? "?"}` : "-",
  ]);
}

const MODEL_HEADER = ["MODEL", "CTX", "IN", "OUT", "REASONING", "$IN/$OUT per M"];

/** Print a dim hint when some models have no catalog metadata. */
function printUncatalogedHint(models: ModelSpec[]): void {
  const bare = models.filter((m) => m.contextWindow === undefined && !m.cost);
  if (bare.length > 0) {
    console.log(pc.dim(`${bare.length} model(s) have no catalog metadata (shown as "-")`));
  }
}

/** Guess the models.dev provider whose API host matches the configured baseUrl. */
function guessProviderHint(catalog: Catalog | undefined, baseUrl: string): string | undefined {
  if (!catalog) return undefined;
  let host: string;
  try {
    host = new URL(baseUrl).host;
  } catch {
    return undefined;
  }
  for (const p of Object.values(catalog)) {
    if (!p.api) continue;
    try {
      if (new URL(p.api).host === host) return p.id;
    } catch {
      /* ignore malformed catalog urls */
    }
  }
  return undefined;
}

export interface AddOptions extends MetadataOptions {
  id?: string;
  name?: string;
  protocol?: string;
  openaiApi?: string;
  baseUrl?: string;
  apiKey?: string;
  models?: string;
  defaultModel?: string;
  smallModel?: string;
  reasoningEffort?: string;
  modelsDev?: string;
  discover?: boolean;
  include?: string;
  exclude?: string;
  dedup?: boolean;
  yes?: boolean;
}

function parseFilterOpts(opts: { include?: string; exclude?: string; dedup?: boolean }, previous?: ModelFilter): ModelFilter | undefined {
  if (opts.include === undefined && opts.exclude === undefined && opts.dedup === undefined) return previous;
  return {
    ...previous,
    ...(opts.include !== undefined ? { include: opts.include.split(",").map((x) => x.trim()).filter(Boolean) } : {}),
    ...(opts.exclude !== undefined ? { exclude: opts.exclude.split(",").map((x) => x.trim()).filter(Boolean) } : {}),
    ...(opts.dedup !== undefined ? { dedup: opts.dedup } : {}),
  };
}

function reportDropped(dropped: Array<{ id: string; reason: string }>): void {
  if (!dropped.length) return;
  console.log(pc.dim(`filtered out ${dropped.length} model(s):`));
  for (const d of dropped) console.log(pc.dim(`  - ${d.id} (${d.reason})`));
}

export async function cmdAdd(opts: AddOptions): Promise<void> {
  const store = loadStore();
  resolveMetadataOptions(opts);
  const interactive = process.stdin.isTTY && !opts.yes;

  let answers: Record<string, string> = {};
  if (interactive) {
    prompts.override({
      id: opts.id,
      name: opts.name,
      protocol: opts.protocol,
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      models: opts.models,
      openaiApi: opts.openaiApi,
    });
    answers = await prompts(
      [
        {
          type: "text",
          name: "id",
          message: t("add.idAuto"),
          validate: (v: string) => (!v || /^[a-z0-9][a-z0-9_-]*$/.test(v) ? true : t("add.idInvalid")),
        },
        { type: "text", name: "name", message: t("add.name"), initial: (prev: string) => prev },
        {
          type: "select",
          name: "protocol",
          message: t("add.protocol"),
          hint: t("menu.selectInstructions"),
          choices: [
            { title: t("add.openai"), value: "openai" },
            { title: t("add.anthropic"), value: "anthropic" },
          ],
        },
        {
          // only openai endpoints have two wires; anthropic skips the question
          type: (_prev: unknown, values: Record<string, unknown>) =>
            values.protocol === "openai" ? "select" : null,
          name: "openaiApi",
          message: t("add.openaiApi"),
          hint: t("menu.selectInstructions"),
          choices: [
            { title: t("add.completions"), value: "completions" },
            { title: t("add.responses"), value: "responses" },
          ],
        },
        { type: "text", name: "baseUrl", message: t("add.baseUrl"), validate: (v: string) => (/^https?:\/\//.test(v) ? true : t("add.baseUrlInvalid")) },
        { type: "password", name: "apiKey", message: t("add.apiKey") },
        {
          type: opts.discover ? null : "text",
          name: "models",
          message: t("add.models"),
        },
      ],
      { onCancel: () => fail(t("add.cancelled")) },
    );
  } else {
    const required = opts.discover
      ? (["protocol", "baseUrl", "apiKey"] as const)
      : (["protocol", "baseUrl", "apiKey", "models"] as const);
    for (const field of required) {
      if (!opts[field]) fail(t("add.fieldRequired", { field: field === "baseUrl" ? "base-url" : field === "apiKey" ? "api-key" : field }));
    }
    answers = {
      id: opts.id ?? "",
      name: opts.name ?? "",
      protocol: opts.protocol!,
      baseUrl: opts.baseUrl!,
      apiKey: opts.apiKey!,
      models: opts.models ?? "",
      ...(opts.openaiApi ? { openaiApi: opts.openaiApi } : {}),
    };
  }

  const protocol = answers.protocol as Protocol;
  if (protocol !== "openai" && protocol !== "anthropic") fail(t("add.protocolInvalid"));
  const wire = answers.openaiApi ?? opts.openaiApi;
  if (wire !== undefined && wire !== "completions" && wire !== "responses") fail(t("add.openaiApiInvalid"));
  const baseUrl = normalizeUrl(answers.baseUrl!);
  const explicitId = answers.id || undefined;
  const existing = explicitId ? store.providers[explicitId] : findMatchingProvider(Object.values(store.providers), { protocol, baseUrl, apiKey: answers.apiKey });
  const id = explicitId ?? existing?.id ?? availableProviderId(providerIdFromBaseUrl(baseUrl, protocol), store.providers);
  const openaiApi = protocol === "openai" ? (wire as OpenAIApi | undefined) ?? existing?.openaiApi : undefined;
  const metadataOptions = resolveMetadataOptions(opts, existing);
  const manualIds = (answers.models ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  let modelIds = manualIds;
  const modelFilter = parseFilterOpts(opts, existing?.modelFilter);
  const shouldDiscover = opts.discover || manualIds.length === 0;
  if (shouldDiscover) {
    if (!opts.discover) {
      process.stderr.write(pc.dim(t("add.autoDiscover") + "\n"));
    }
    process.stderr.write(pc.dim(`${t("add.discovering", { url: baseUrl })}\n`));
    const discovered = await discoverProviderModels({ baseUrl, apiKey: answers.apiKey!, protocol });
    console.log(t("add.providerLists", { count: discovered.length }));
    modelIds = [...new Set([...manualIds, ...discovered])];
  }
  const retained = [opts.defaultModel === undefined ? existing?.defaultModel : undefined, opts.smallModel === undefined ? existing?.smallModel : undefined].filter((id): id is string => !!id);
  modelIds = [...new Set([...modelIds, ...retained])];
  const pinned = [...manualIds, ...retained, ...(opts.defaultModel ? [opts.defaultModel] : []), ...(opts.smallModel ? [opts.smallModel] : [])];
  const outcome = applyModelFilter(modelIds, modelFilter, pinned);
  reportDropped(outcome.dropped);
  modelIds = outcome.kept;
  if (modelIds.length === 0) fail(t("add.atLeastOne"));

  const catalog = await loadCatalog();
  const hint = opts.modelsDev ?? existing?.modelsDevId ?? guessProviderHint(catalog, answers.baseUrl!);
  const models = await enrichProviderModels(catalog, modelIds, { ...metadataOptions, modelsDevId: hint, models: existing?.models });
  const matched = models.filter((m) => m.contextWindow !== undefined).length;

  const defaultModel = opts.defaultModel ?? existing?.defaultModel ?? modelIds[0]!;
  if (!modelIds.includes(defaultModel)) fail(t("add.defaultMissing", { model: defaultModel }));
  if (opts.smallModel && !modelIds.includes(opts.smallModel)) fail(t("add.smallMissing", { model: opts.smallModel }));

  const provider: Provider = {
    ...existing,
    id,
    name: answers.name || existing?.name || (explicitId ? explicitId : providerNameFromBaseUrl(baseUrl, protocol)),
    protocol,
    openaiApi,
    baseUrl,
    apiKey: answers.apiKey!,
    models,
    defaultModel,
    smallModel: opts.smallModel ?? existing?.smallModel,
    reasoningEffort: opts.reasoningEffort ?? existing?.reasoningEffort,
    modelsDevId: hint,
    ...metadataOptions,
    modelFilter,
  };

  const existed = store.providers[provider.id] !== undefined;
  store.providers[provider.id] = provider;
  if (!store.active) store.active = provider.id;
  saveStore(store);

  const savedStatus = t(existed ? "add.updated" : "add.added");
  console.log(pc.green(t("add.saved", { status: savedStatus, id: pc.bold(provider.id), protocol })));
  console.log(t("add.metadata", { matched, total: models.length }) + (hint ? t("add.providerHint", { hint }) : ""));
  console.log(table(modelRows(models), MODEL_HEADER));
  printUncatalogedHint(models);
  console.log(pc.dim(`\n${t("add.next", { id: provider.id })}`));
}

/** Shared logic to create and save a single provider from discovered models. */
async function createProvider(opts: {
  store: ReturnType<typeof loadStore>;
  id: string;
  name: string;
  protocol: Protocol;
  openaiApi?: OpenAIApi;
  baseUrl: string;
  apiKey: string;
  modelIds: string[];
  defaultModel?: string;
  smallModel?: string;
  reasoningEffort?: string;
  modelFilter?: ModelFilter;
  existing?: Provider;
  modelsDev?: string;
  gatewayMetadata?: boolean;
  gatewayModels?: string;
  metadataMode?: string;
  gatewayLoader?: () => Promise<GatewayCatalog | null>;
}): Promise<Provider> {
  const { store, id, name, protocol, openaiApi, baseUrl, apiKey, modelIds, modelFilter } = opts;
  const metadataOptions = resolveMetadataOptions(opts, opts.existing);
  const catalog = await loadCatalog();
  const hint = opts.modelsDev ?? opts.existing?.modelsDevId ?? guessProviderHint(catalog, baseUrl);
  const models = await enrichProviderModels(catalog, modelIds, { ...metadataOptions, modelsDevId: hint, models: opts.existing?.models }, { gatewayLoader: opts.gatewayLoader });
  const matched = models.filter((m) => m.contextWindow !== undefined).length;
  const defaultModel = opts.defaultModel ?? opts.existing?.defaultModel ?? modelIds[0]!;
  if (!modelIds.includes(defaultModel)) fail(t("add.defaultMissing", { model: defaultModel }));
  const smallModel = opts.smallModel ?? opts.existing?.smallModel;
  if (smallModel && !modelIds.includes(smallModel)) fail(t("add.smallMissing", { model: smallModel }));

  const provider: Provider = {
    ...opts.existing,
    id,
    name,
    protocol,
    openaiApi: protocol === "openai" ? openaiApi ?? opts.existing?.openaiApi : undefined,
    baseUrl,
    apiKey,
    models,
    defaultModel,
    smallModel,
    reasoningEffort: opts.reasoningEffort ?? opts.existing?.reasoningEffort,
    modelsDevId: hint,
    ...metadataOptions,
    modelFilter,
  };

  const existed = store.providers[provider.id] !== undefined;
  store.providers[provider.id] = provider;
  if (!store.active) store.active = provider.id;

  const savedStatus = t(existed ? "add.updated" : "add.added");
  console.log(pc.green(t("add.saved", { status: savedStatus, id: pc.bold(provider.id), protocol })));
  console.log(t("add.metadata", { matched, total: models.length }) + (hint ? t("add.providerHint", { hint }) : ""));
  console.log(table(modelRows(models), MODEL_HEADER));
  printUncatalogedHint(models);
  return provider;
}

/**
 * Quick add: only base URL + API key needed. Auto-detects protocol(s) by probing
 * /v1/models with both openai and anthropic auth headers. When both succeed,
 * creates two providers with -openai / -anthropic suffixes.
 */
export async function cmdQuickAdd(opts: {
  baseUrl?: string;
  apiKey?: string;
  id?: string;
  name?: string;
  openaiApi?: string;
  modelsDev?: string;
  gatewayMetadata?: boolean;
  gatewayModels?: string;
  metadataMode?: string;
  defaultModel?: string;
  smallModel?: string;
  reasoningEffort?: string;
  include?: string;
  exclude?: string;
  dedup?: boolean;
  yes?: boolean;
}): Promise<void> {
  const store = loadStore();
  resolveMetadataOptions(opts);
  const interactive = process.stdin.isTTY && !opts.yes;

  let baseUrl: string;
  let apiKey: string;

  if (interactive) {
    const answers = await prompts(
      [
        { type: "text", name: "baseUrl", message: t("add.baseUrl"), validate: (v: string) => (/^https?:\/\//.test(v) ? true : t("add.baseUrlInvalid")) },
        { type: "password", name: "apiKey", message: t("add.apiKey") },
      ],
      { onCancel: () => fail(t("add.cancelled")) },
    );
    baseUrl = normalizeUrl(answers.baseUrl);
    apiKey = answers.apiKey;
  } else {
    if (!opts.baseUrl) fail(t("add.fieldRequired", { field: "base-url" }));
    if (!opts.apiKey) fail(t("add.fieldRequired", { field: "api-key" }));
    baseUrl = normalizeUrl(opts.baseUrl);
    apiKey = opts.apiKey;
  }

  process.stderr.write(pc.dim(t("quick.probing", { url: baseUrl }) + "\n"));
  const protocols = await probeProtocols({ baseUrl, apiKey });

  if (protocols.length === 0) {
    fail(t("quick.noProtocol"));
  }

  if (opts.openaiApi !== undefined && opts.openaiApi !== "completions" && opts.openaiApi !== "responses") fail(t("add.openaiApiInvalid"));
  const multi = protocols.length > 1;
  const createdIds: string[] = [];
  const gatewayLoader = sharedGatewayLoader();

  for (const protocol of protocols) {
    const explicitId = opts.id === undefined ? undefined : `${opts.id}${multi ? `-${protocol}` : ""}`;
    const existing = explicitId === undefined ? findMatchingProvider(Object.values(store.providers), { protocol, baseUrl, apiKey }) : store.providers[explicitId];
    const id = explicitId ?? existing?.id ?? availableProviderId(providerIdFromBaseUrl(baseUrl, protocol), store.providers);
    const name = opts.name ?? existing?.name ?? (opts.id === undefined ? providerNameFromBaseUrl(baseUrl, protocol) : multi ? `${opts.id} (${protocol})` : opts.id);
    const modelFilter = parseFilterOpts(opts, existing?.modelFilter);

    process.stderr.write(pc.dim(`${t("add.discovering", { url: baseUrl })} [${protocol}]\n`));
    const discovered = await discoverProviderModels({ baseUrl, apiKey, protocol });
    console.log(t("add.providerLists", { count: discovered.length }));

    const retained = [opts.defaultModel === undefined ? existing?.defaultModel : undefined, opts.smallModel === undefined ? existing?.smallModel : undefined].filter((id): id is string => !!id);
    let modelIds = [...new Set([...discovered, ...retained])];
    const pinned = [...retained, ...(opts.defaultModel ? [opts.defaultModel] : []), ...(opts.smallModel ? [opts.smallModel] : [])];
    const outcome = applyModelFilter(modelIds, modelFilter, pinned);
    reportDropped(outcome.dropped);
    modelIds = outcome.kept;
    if (modelIds.length === 0) {
      console.log(pc.yellow(t("quick.noModelsAfterFilter", { id })));
      continue;
    }

    const provider = await createProvider({
      store,
      id,
      name,
      protocol,
      baseUrl,
      apiKey,
      modelIds,
      defaultModel: opts.defaultModel,
      smallModel: opts.smallModel,
      reasoningEffort: opts.reasoningEffort,
      modelFilter,
      existing,
      openaiApi: opts.openaiApi as OpenAIApi | undefined,
      modelsDev: opts.modelsDev,
      gatewayMetadata: opts.gatewayMetadata,
      gatewayModels: opts.gatewayModels,
      metadataMode: opts.metadataMode,
      gatewayLoader,
    });
    createdIds.push(provider.id);
    console.log(pc.dim(`\n${t("add.next", { id: provider.id })}`));
  }

  saveStore(store);
  if (createdIds.length > 0) {
    console.log(pc.green(t("quick.summary", { count: createdIds.length, ids: createdIds.join(", ") })));
  }
}

export function cmdList(): void {
  const store = loadStore();
  const ids = Object.keys(store.providers);
  if (ids.length === 0) {
    console.log(t("list.none", { file: configFile }));
    return;
  }
  const rows = ids.map((id) => {
    const p = store.providers[id]!;
    return [
      store.active === id ? pc.green("*") : " ",
      id,
      p.protocol,
      p.baseUrl,
      p.defaultModel,
      String(p.models.length),
    ];
  });
  console.log(table(rows, [" ", "ID", t("table.protocol"), "BASE URL", t("table.defaultModel"), t("table.models")]));
}

export async function cmdPrune(id: string, opts: { apps?: string }): Promise<void> {
  const store = loadStore();
  const provider = getProvider(store, id);
  console.log(`${t("remove.pruning", { id: pc.bold(id) })}\n`);
  reportResults(await runTargets("prune", provider, opts.apps));
}

function reportResults(results: ApplyResult[]): void {
  for (const r of results) {
    if (r.skipped) {
      console.log(`${pc.yellow(t("common.skip"))} ${r.app.padEnd(9)} ${pc.dim(r.skipped)}`);
      continue;
    }
    console.log(`${pc.green("ok  ")} ${r.app.padEnd(9)} ${r.changed.join(", ")}`);
    for (const note of r.notes) console.log(`     ${" ".repeat(9)} ${pc.dim(note)}`);
  }
}

async function runTargets(op: "apply" | "prune", provider: Provider, appsFilter?: string, redactErrors = false): Promise<ApplyResult[]> {
  const selected = resolveTargets(appsFilter);
  const explicit = appsFilter !== undefined && appsFilter !== "all";
  const results: ApplyResult[] = [];
  for (const target of selected) {
    if (op === "apply" && !supportsProtocol(target, provider.protocol)) {
      results.push({
        app: target.id,
        changed: [],
        notes: [],
        skipped: `${target.name} does not support ${provider.protocol}-protocol providers`,
      });
      continue;
    }
    try {
      if (!explicit && !target.detect()) {
        results.push({ app: target.id, changed: [], notes: [], skipped: `${target.name} not detected (pass --apps ${target.id} to force)` });
        continue;
      }
      results.push(await target[op](provider));
    } catch (err) {
      results.push({ app: target.id, changed: [], notes: [], skipped: pc.red(redactErrors ? "failed: configuration could not be previewed safely" : `failed: ${(err as Error).message}`) });
      process.exitCode = 1;
    }
  }
  return results;
}

/** Parse first: an unknown format or malformed document must never fall back to raw secrets. */
function previewDocument(file: string, text: string): unknown {
  if (!text.trim()) return undefined;
  if (path.basename(file) === ".env" || file.endsWith(".env")) {
    return Object.fromEntries(envAssignments(file, text).map(({ name }) => [name, "[REDACTED]"]));
  }
  switch (path.extname(file).toLowerCase()) {
    case ".json":
    case ".jsonc": {
      const errors: ParseError[] = [];
      const value: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
      if (errors.length) throw new Error("invalid JSON configuration");
      return value;
    }
    case ".toml": return parseToml(text);
    case ".yaml":
    case ".yml": {
      const document = parseDocument(text);
      if (document.errors.length) throw new Error("invalid YAML configuration");
      return document.toJS();
    }
    default: throw new Error("unsupported configuration format");
  }
}

/** Normalized semantic diff: comments and unparseable raw input never enter output. */
function printFileDiff(file: string, next: string, apiKey: string): void {
  const before = readTextIfExists(file) ?? "";
  if (before === next) {
    console.log(`${pc.dim("unchanged")} ${file}`);
    return;
  }
  console.log(pc.bold(`--- ${file} (redacted configuration)`));
  let oldText: string;
  let newText: string;
  try {
    const oldDocument = previewDocument(file, before);
    const newDocument = previewDocument(file, next);
    const sensitive = /key|token|secret|password|auth|credential|cookie|headers/i;
    const credentialFile = path.basename(file) === ".credentials.yaml";
    const secrets = new Set<string>(apiKey ? [apiKey] : []);
    const visited = new WeakSet<object>();
    const collect = (value: unknown, hidden = false): void => {
      if (typeof value === "string" && hidden && value) secrets.add(value);
      if (!value || typeof value !== "object" || visited.has(value)) return;
      visited.add(value);
      for (const [key, child] of Object.entries(value)) collect(child, hidden || sensitive.test(key));
    };
    collect(oldDocument, credentialFile);
    collect(newDocument, credentialFile);
    const orderedSecrets = [...secrets].sort((a, b) => b.length - a.length);
    const redact = (key: string, value: unknown): unknown => {
      if (sensitive.test(key)) return "[REDACTED]";
      if ((key === "" || credentialFile) && typeof value === "string") return "[REDACTED]";
      if (typeof value !== "string") return value;
      let safe = value;
      if (/^https?:\/\//i.test(safe)) {
        const url = new URL(safe);
        if (url.username) url.username = "[REDACTED]";
        if (url.password) url.password = "[REDACTED]";
        for (const name of new Set(url.searchParams.keys())) if (sensitive.test(name)) url.searchParams.set(name, "[REDACTED]");
        url.hash = "";
        safe = url.toString();
      }
      for (const secret of orderedSecrets) safe = safe.split(secret).join("[REDACTED]");
      return safe.replace(/\b(?:Bearer|Basic)\s+[^\s"',;]+/gi, "[REDACTED]");
    };
    oldText = JSON.stringify(oldDocument, redact, 2) ?? "";
    newText = JSON.stringify(newDocument, redact, 2) ?? "";
  } catch {
    console.log(pc.dim("[content withheld: unsupported or malformed configuration]"));
    return;
  }
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  const oldSeen = new Map<string, number>();
  for (const line of oldLines) oldSeen.set(line, (oldSeen.get(line) ?? 0) + 1);
  const newSeen = new Map<string, number>();
  for (const line of newLines) newSeen.set(line, (newSeen.get(line) ?? 0) + 1);
  for (const line of oldLines) {
    const count = newSeen.get(line) ?? 0;
    if (count > 0) newSeen.set(line, count - 1);
    else console.log(pc.red(`- ${line}`));
  }
  for (const line of newLines) {
    const count = oldSeen.get(line) ?? 0;
    if (count > 0) oldSeen.set(line, count - 1);
    else console.log(pc.green(`+ ${line}`));
  }
  if (oldText === newText) console.log(pc.dim("[only redacted values or formatting changed]"));
}

async function runWithOptionalDryRun(
  op: "apply" | "prune",
  provider: Provider,
  apps: string | undefined,
  dryRun: boolean | undefined,
): Promise<void> {
  if (!dryRun) {
    reportResults(await runTargets(op, provider, apps));
    return;
  }
  setDryRun(true);
  try {
    const results = await runTargets(op, provider, apps, true);
    const writes = drainPendingWrites();
    for (const r of results) {
      if (r.skipped) console.log(`${pc.yellow("skip")} ${r.app.padEnd(9)} ${pc.dim(r.skipped)}`);
    }
    console.log(pc.bold(`\ndry run — ${writes.length} file(s) would be written:\n`));
    for (const w of writes) printFileDiff(w.file, w.content, provider.apiKey);
  } finally {
    setDryRun(false);
  }
}

export async function cmdUse(id: string, opts: { apps?: string; model?: string; dryRun?: boolean }): Promise<void> {
  resolveTargets(opts.apps);
  const store = loadStore();
  const provider = getProvider(store, id);
  if (opts.model) {
    if (!provider.models.some((m) => m.id === opts.model)) {
      fail(t("use.modelMissing", { model: opts.model, id, have: provider.models.map((m) => m.id).join(", ") }));
    }
    provider.defaultModel = opts.model;
  }
  if (!opts.dryRun) {
    store.active = id;
    saveStore(store);
  }
  console.log(`${t("use.switching", { id: pc.bold(id), protocol: provider.protocol, model: provider.defaultModel })}\n`);
  await runWithOptionalDryRun("apply", provider, opts.apps, opts.dryRun);
}

export async function cmdSync(opts: { apps?: string; provider?: string; dryRun?: boolean }): Promise<void> {
  resolveTargets(opts.apps);
  const store = loadStore();
  const id = opts.provider ?? store.active;
  if (!id) fail(t("sync.noActive"));
  const provider = getProvider(store, id);
  console.log(`${t("sync.syncing", { id: pc.bold(id), model: provider.defaultModel })}\n`);
  await runWithOptionalDryRun("apply", provider, opts.apps, opts.dryRun);
}

export function cmdStatus(): void {
  const store = loadStore();
  console.log(t("status.config", { file: configFile }));
  console.log(`${t("status.active", { id: store.active ? pc.bold(store.active) : pc.dim(t("status.none")) })}\n`);
  const rows = targets.map((target) => [
    target.id,
    target.detect() ? pc.green(t("common.yes")) : pc.dim(t("common.no")),
    target.protocols.join("+"),
    target.current() ?? pc.dim("-"),
    pc.dim(target.configPaths[0] ?? ""),
  ]);
  console.log(table(rows, ["APP", t("table.found"), t("table.protocols"), t("table.current"), t("table.config")]));
}

export async function cmdModels(
  query: string | undefined,
  opts: { provider?: string; refresh?: boolean; limit?: string; metadata?: boolean },
): Promise<void> {
  if (opts.metadata && !opts.provider) fail("--metadata requires --provider");
  if (opts.provider) {
    const store = loadStore();
    const provider = getProvider(store, opts.provider);
    if (opts.metadata) {
      console.log(JSON.stringify({
        provider: provider.id,
        gatewayMetadata: provider.gatewayMetadata ?? "auto",
        metadataMode: getMetadataMode(provider),
        gatewayModelAliases: provider.gatewayModelAliases ?? {},
        models: provider.models.map(({ id, metadata }) => ({ id, metadata })),
      }, null, 2));
      return;
    }
    console.log(`${pc.bold(provider.id)} (${provider.protocol}) · ${provider.baseUrl}`);
    console.log(table(modelRows(provider.models), MODEL_HEADER));
    printUncatalogedHint(provider.models);
    return;
  }
  const catalog = await loadCatalog({ refresh: opts.refresh });
  if (!catalog) fail("models.dev catalog unavailable (offline and no cache)");
  if (!query) fail("usage: agentsw models <query> | agentsw models --provider <id>");
  const limit = opts.limit ? Number(opts.limit) : 30;
  const hits = searchCatalog(catalog, query, limit);
  if (hits.length === 0) {
    console.log(`no models.dev entries match "${query}"`);
    return;
  }
  const rows = hits.map((h) => {
    const row = modelRows([h.spec])[0]!;
    return [h.provider, ...row];
  });
  console.log(table(rows, ["PROVIDER", ...MODEL_HEADER]));
}

export async function cmdRefreshMeta(opts: MetadataOptions & { provider?: string } = {}): Promise<void> {
  const store = loadStore();
  const providers = opts.provider ? [getProvider(store, opts.provider)] : Object.values(store.providers);
  resolveMetadataOptions(opts);
  for (const provider of providers) Object.assign(provider, resolveMetadataOptions(opts, provider));
  const catalog = await loadCatalog({ refresh: true });
  const gatewayLoader = sharedGatewayLoader(true);
  let updated = 0;
  for (const provider of providers) {
    const before = JSON.stringify(provider.models);
    provider.models = await enrichProviderModels(catalog, provider.models.map((m) => m.id), {
      ...provider,
      modelsDevId: provider.modelsDevId ?? guessProviderHint(catalog, provider.baseUrl),
    }, { gatewayLoader });
    if (JSON.stringify(provider.models) !== before) updated++;
  }
  saveStore(store);
  console.log(pc.green(`checked model metadata (${updated} provider(s) changed)`));
  if (updated > 0) console.log(pc.dim("run `agentsw sync` to push updated metadata into app configs"));
}

export async function cmdDiscover(
  id: string,
  opts: MetadataOptions & { sync?: boolean; apps?: string; include?: string; exclude?: string; dedup?: boolean; filter?: boolean },
): Promise<void> {
  resolveTargets(opts.apps);
  const store = loadStore();
  const provider = getProvider(store, id);
  Object.assign(provider, resolveMetadataOptions(opts, provider));
  // flags override and re-persist the filter; --no-filter clears it
  const flagFilter = parseFilterOpts(opts, provider.modelFilter);
  if (opts.filter === false) provider.modelFilter = undefined;
  else if (flagFilter) provider.modelFilter = flagFilter;
  process.stderr.write(pc.dim(`discovering models from ${provider.baseUrl} ...\n`));
  const listed = await discoverProviderModels(provider);
  const pinned = [provider.defaultModel, provider.smallModel].filter((model): model is string => !!model);
  const outcome = applyModelFilter(listed, provider.modelFilter, pinned);
  reportDropped(outcome.dropped);
  const ids = outcome.kept;
  const known = provider.models.map((m) => m.id);
  const added = ids.filter((m) => !known.includes(m));
  const gone = known.filter((m) => !ids.includes(m));
  const catalog = await loadCatalog();
  const retainedIds = [...new Set([...ids, ...pinned])];
  provider.models = await enrichProviderModels(catalog, retainedIds, { ...provider, modelsDevId: provider.modelsDevId ?? guessProviderHint(catalog, provider.baseUrl) });
  if (!ids.includes(provider.defaultModel)) {
    console.log(pc.yellow(`default model ${provider.defaultModel} no longer listed; keeping it anyway`));
  }
  saveStore(store);
  console.log(
    `${pc.bold(id)}: ${ids.length} models (${pc.green(`+${added.length}`)} / ${pc.red(`-${gone.length}`)})` +
      (added.length ? `\n  new: ${added.join(", ")}` : "") +
      (gone.length ? `\n  removed upstream: ${gone.join(", ")}` : ""),
  );
  console.log(table(modelRows(provider.models), MODEL_HEADER));
  printUncatalogedHint(provider.models);
  if (opts.sync) {
    console.log("");
    await cmdSync({ provider: id, apps: opts.apps });
  } else {
    console.log(pc.dim("\nrun `agentsw sync` to push into app configs"));
  }
}

interface AppRow {
  id: string;
  name: string;
  installed?: string;
  latest?: string;
  upgradable: boolean;
  installable: boolean;
  checkFailed?: string;
}

async function collectAppRows(): Promise<AppRow[]> {
  return Promise.all(
    appPackages.map(async (app) => {
      const [installedResult, latestResult] = await Promise.allSettled([
        Promise.resolve().then(() => installedVersion(app)),
        latestVersion(app),
      ]);
      const installed = installedResult.status === "fulfilled" ? installedResult.value : "?";
      const latest = latestResult.status === "fulfilled" ? latestResult.value : undefined;
      const knownInstalled = normalizeAppVersion(installed);
      const knownLatest = normalizeAppVersion(latest);
      const checkFailed = installedResult.status === "rejected"
        ? "installed version check failed"
        : installed && !knownInstalled
          ? "installed version unknown"
          : installed && !knownLatest
            ? "latest version unavailable"
            : undefined;
      return {
        id: app.id,
        name: app.name,
        installed,
        latest,
        upgradable: !!knownInstalled && !!knownLatest && isNewer(knownInstalled, knownLatest),
        installable: !installed && !!appCommand(app, "install"),
        checkFailed,
      };
    }),
  );
}

export async function cmdApps(): Promise<void> {
  process.stderr.write(pc.dim("checking installed and latest versions ...\n"));
  const rows = await collectAppRows();
  console.log(
    table(
      rows.map((r) => [
        r.id,
        r.installed ?? pc.dim("not installed"),
        r.latest ?? pc.dim("?"),
        r.upgradable
          ? pc.yellow("upgrade available")
          : !r.installed
            ? r.installable
              ? pc.dim("installable")
              : pc.dim("-")
            : r.checkFailed || !normalizeAppVersion(r.latest)
              ? pc.dim("unknown")
              : pc.green("up to date"),
      ]),
      ["APP", "INSTALLED", "LATEST", "STATUS"],
    ),
  );
  const upgradable = rows.filter((r) => r.upgradable).map((r) => r.id);
  if (upgradable.length) console.log(pc.dim(`\nupgrade with: agentsw upgrade ${upgradable.join(" ")}`));
}

export async function cmdInstall(id: string): Promise<void> {
  const app = appPackages.find((a) => a.id === id);
  if (!app) fail(`unknown app "${id}" (supported: ${appPackages.map((a) => a.id).join(", ")})`);
  const installCmd = appCommand(app, "install");
  if (!installCmd) fail(`${app.name} is not installable on ${process.platform} (or is managed by its desktop app)`);
  const installed = installedVersion(app);
  if (installed) {
    console.log(`${app.name} already installed (${installed}); use \`agentsw upgrade ${id}\``);
    return;
  }
  console.log(`installing ${app.name}: ${pc.dim(installCmd)}`);
  runShell(installCmd);
  const detected = installedVersion(app);
  if (!detected) throw new Error(`${app.name}: installer completed but the app is still not detected; check the installation and PATH`);
  const version = normalizeAppVersion(detected);
  if (!version) {
    console.log(pc.yellow(`${app.name}: installer completed; app detected but version unknown`));
    process.exitCode = 1;
    return;
  }
  console.log(pc.green(`${app.name} installed: ${version}`));
}

export async function cmdUpgrade(ids: string[]): Promise<void> {
  let selected = appPackages.filter((a) => ids.length === 0 || ids.includes(a.id));
  const unknown = ids.filter((id) => !appPackages.some((a) => a.id === id));
  if (unknown.length) fail(`unknown app(s): ${unknown.join(", ")}`);
  const expectedVersions = new Map<string, string>();
  if (ids.length === 0) {
    // no args: upgrade everything that is installed and outdated
    process.stderr.write(pc.dim("checking versions ...\n"));
    const rows = await collectAppRows();
    const managed = rows.filter((row) => !!appCommand(appPackages.find((app) => app.id === row.id)!, "upgrade"));
    const failed = managed.filter((row) => row.checkFailed);
    for (const row of failed) console.log(pc.yellow(`${row.id}: ${row.checkFailed}; update status unknown`));
    if (failed.length) process.exitCode = 1;
    const upgradable = managed.filter((row) => row.upgradable);
    if (upgradable.length === 0) {
      if (failed.length) console.log("could not determine update status for every installed app");
      else if (managed.some((row) => row.installed)) console.log("all checked apps are up to date");
      else console.log("no installed CLI-managed apps to upgrade");
      return;
    }
    for (const row of upgradable) expectedVersions.set(row.id, row.latest!);
    selected = appPackages.filter((app) => expectedVersions.has(app.id));
  }
  for (const app of selected) {
    const cmd = appCommand(app, "upgrade");
    if (!cmd) {
      console.log(`${pc.yellow("skip")} ${app.id}: not CLI-upgradable`);
      process.exitCode = 1;
      continue;
    }
    try {
      if (!installedVersion(app)) {
        console.log(`${pc.yellow("skip")} ${app.id}: not installed (use \`agentsw install ${app.id}\`)`);
        process.exitCode = 1;
        continue;
      }
      console.log(`upgrading ${app.name}: ${pc.dim(cmd)}`);
      runShell(cmd);
      const version = normalizeAppVersion(installedVersion(app));
      if (!version) throw new Error("upgrade command completed but installed version is unknown or app is not detected");
      const expected = expectedVersions.get(app.id);
      if (expected && isNewer(version, expected)) throw new Error(`upgrade command completed but ${version} is older than available ${expected}`);
      console.log(pc.green(`${app.id} -> ${version}`));
    } catch (err) {
      console.log(pc.red(`${app.id} upgrade failed: ${(err as Error).message}`));
      process.exitCode = 1;
    }
  }
}

export interface ImportOptions extends MetadataOptions {
  all?: boolean;
}

/** Collect custom providers, dedupe by endpoint and credentials, and import what is new. */
export async function cmdImport(opts: ImportOptions): Promise<void> {
  const metadataOptions = resolveMetadataOptions(opts);
  const rows = scanCandidates();
  const fresh = rows.filter((r) => !r.configured);
  for (const r of rows) {
    if (r.configured) {
      console.log(`${pc.yellow(t("import.skip"))} ${pc.bold(r.id)} · ${r.protocol} · ${r.baseUrl} — ${t("import.already", { id: pc.bold(r.configured) })}`);
    }
  }
  if (fresh.length === 0) {
    console.log(rows.length ? t("import.noneNew") : t("import.noneFound"));
    return;
  }

  console.log("");
  console.log(
    table(
      fresh.map((r) => [
        r.id,
        r.protocol,
        r.baseUrl,
        String(r.models.length),
        r.sources.join(","),
        r.apiKey ? pc.green(t("import.keyYes")) : r.keyEnv ? pc.yellow(t("import.keyEnv", { name: r.keyEnv })) : pc.red(t("import.keyMissing")),
      ]),
      ["ID", t("table.protocol"), "BASE URL", t("table.models"), t("table.from"), t("table.key")],
    ),
  );

  let chosen: MergedCandidate[];
  if (process.stdin.isTTY && !opts.all) {
    const { pick } = await prompts(
      {
        type: "multiselect",
        name: "pick",
        message: t("import.which"),
        instructions: t("import.multiInstructions"),
        choices: fresh.map((r, i) => ({
          title: `${r.id} · ${r.protocol} · ${r.baseUrl} · ${r.models.length ? t("import.modelsCount", { count: r.models.length }) : t("import.noModels")}`,
          value: i,
          selected: true,
        })),
      },
      { onCancel: () => fail(t("add.cancelled")) },
    );
    if (!Array.isArray(pick) || pick.length === 0) {
      console.log(pc.dim(t("import.nothingSelected")));
      return;
    }
    chosen = (pick as number[]).map((i) => fresh[i]).filter((r): r is MergedCandidate => r !== undefined);
  } else {
    chosen = fresh;
  }

  const store = loadStore();
  const catalog = await loadCatalog();
  const gatewayLoader = sharedGatewayLoader();
  const imported: string[] = [];
  for (const c of chosen) {
    let apiKey = c.apiKey;
    if (!apiKey) {
      const why = c.keyEnv ? t("import.keyRefMissing", { name: c.keyEnv }) : t("import.keyNotStored");
      if (!process.stdin.isTTY || opts.all) {
        fail(t("import.missingKey", { id: c.id, why }));
      }
      const a = await prompts(
        {
          type: "password",
          name: "key",
          message: t("import.keyPrompt", { id: c.id, url: c.baseUrl, why }),
          validate: (v: string) => (v.trim() ? true : t("import.required")),
        },
        { onCancel: () => fail(t("add.cancelled")) },
      );
      apiKey = a.key;
    }

    // A prompted credential can identify a provider imported earlier in this same batch.
    const existing = findMatchingProvider(Object.values(store.providers), { protocol: c.protocol, baseUrl: c.baseUrl, apiKey });
    if (existing) {
      console.log(`${pc.yellow(t("import.skip"))} ${pc.bold(c.id)} · ${c.protocol} · ${c.baseUrl} — ${t("import.already", { id: pc.bold(existing.id) })}`);
      continue;
    }

    let ids = [...c.models];
    if (ids.length === 0) {
      process.stderr.write(pc.dim(`${t("import.discovering", { id: c.id })}\n`));
      try {
        ids = await discoverProviderModels({ baseUrl: c.baseUrl, apiKey: apiKey!, protocol: c.protocol });
      } catch (err) {
        fail(t("import.discoveryFailed", { id: c.id, error: (err as Error).message }));
      }
      ids = applyModelFilter(ids, undefined, []).kept;
    }
    if (ids.length === 0) fail(t("import.noModelsImport", { id: c.id }));

    const id = availableProviderId(c.id, store.providers);
    const hint = guessProviderHint(catalog, c.baseUrl);
    const models = await enrichProviderModels(catalog, ids, { ...metadataOptions, modelsDevId: hint }, { gatewayLoader });
    const defaultModel = c.defaultModel && ids.includes(c.defaultModel) ? c.defaultModel : ids[0]!;
    const existed = store.providers[id] !== undefined;
    store.providers[id] = {
      id,
      name: c.name || id,
      protocol: c.protocol,
      ...(c.openaiApi ? { openaiApi: c.openaiApi } : {}),
      baseUrl: normalizeUrl(c.baseUrl),
      apiKey: apiKey!,
      models,
      defaultModel,
      modelsDevId: hint,
      ...metadataOptions,
    };
    if (!store.active) store.active = id;
    imported.push(id);
    console.log(
      `${pc.green(t(existed ? "import.updated" : "import.imported"))} ${pc.bold(id)} · ${c.protocol} · ${c.baseUrl} · ${t("import.modelsCount", { count: ids.length })} [${t("import.from")} ${c.sources.join(", ")}]`,
    );
  }
  saveStore(store);
  if (imported.length) console.log(pc.dim(`\n${t("import.next", { id: imported[0]! })}`));
}
