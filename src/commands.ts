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
import { classifyUnresolved, enrichProviderModels, getMetadataMode, resolveMetadataOptions, type MetadataOptions } from "./metadata.js";
import { loadGatewayCatalog, type GatewayCatalog } from "./gateway.js";
import { resolveTargets, supportsProtocol, targets } from "./targets/index.js";
import { discoverProviderModels, probeProtocols } from "./discover.js";
import { appCommand, appPackages, installedVersion, isNewer, latestVersion, normalizeAppVersion, runShell } from "./apps.js";
import { SafeConfigError, drainPendingWrites, readTextIfExists, setDryRun } from "./fsutil.js";
import { applyModelFilter, type ModelFilter } from "./filter.js";
import { availableProviderId, providerIdFromBaseUrl, providerNameFromBaseUrl } from "./slug.js";
import { t } from "./i18n.js";
import { cancelInteractive, emitJson, error, isJson, note, out, table, warn, type TableOptions } from "./ui.js";
import { startProgress, withProgress } from "./progress.js";
import {
  appsReport,
  listReport,
  modelsQueryReport,
  providerMetadataReport,
  providerModelsReport,
  statusReport,
  type AppReportRow,
} from "./report.js";
import type { ApplyResult, ModelSpec, OpenAIApi, Protocol, Provider } from "./types.js";

/** Share successes and failures without fetching until a model actually needs the supplement. */
function sharedGatewayLoader(refresh = false): () => Promise<GatewayCatalog | null> {
  let pending: Promise<GatewayCatalog | null> | undefined;
  return () => pending ??= withProgress(t("progress.gateway"), () => loadGatewayCatalog({ refresh }).then((catalog) => catalog ?? null));
}

function fail(message: string): never {
  error(message);
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

/** Numbers right-align; the free-text columns shrink before ids on narrow terminals. */
const MODEL_TABLE_OPTIONS: TableOptions = { align: ["left", "right", "right", "right", "left", "right"], truncate: [4, 0] };
const MODEL_QUERY_OPTIONS: TableOptions = {
  align: ["left", "left", "right", "right", "right", "left", "right"],
  truncate: [5, 1, 0],
};

/**
 * Explain why some models stayed bare: only ambiguous ids are worth the user's
 * attention, so those are named separately from ids nothing can resolve.
 */
function printUncatalogedHint(models: ModelSpec[], catalog?: Catalog, hint?: string): void {
  const bare = models.filter((m) => m.contextWindow === undefined && !m.cost);
  if (bare.length === 0) return;
  out(pc.dim(t("meta.gap", { count: bare.length })));
  const { ambiguous, unknown, noCreatorRow } = classifyUnresolved(catalog, bare.map((m) => m.id), hint);
  for (const [key, ids] of [["meta.ambiguous", ambiguous], ["meta.noCreatorRow", noCreatorRow], ["meta.unknown", unknown]] as const) {
    if (ids.length) out(pc.dim(`  ${t(key, { count: ids.length, ids: ids.join(", "), id: ids[0]! })}`));
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
  out(pc.dim(`filtered out ${dropped.length} model(s):`));
  for (const d of dropped) out(pc.dim(`  - ${d.id} (${d.reason})`));
}

export async function cmdAdd(opts: AddOptions): Promise<void> {
  const store = loadStore();
  resolveMetadataOptions(opts);
  const interactive = process.stdin.isTTY === true && !opts.yes && !isJson();

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
      { onCancel: () => cancelInteractive() },
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
  const byId = explicitId ? store.providers[explicitId] : undefined;
  // Endpoint plus credential is the account identity, so an explicit id never
  // licenses a second entry for an account that is already configured.
  const sameAccount = byId ? undefined : findMatchingProvider(Object.values(store.providers), { protocol, baseUrl, apiKey: answers.apiKey });
  const existing = byId ?? sameAccount;
  if (byId === undefined && explicitId && sameAccount) {
    out(pc.yellow(t("add.alreadyConfigured", { id: pc.bold(sameAccount.id) })));
  }
  const id = byId?.id ?? sameAccount?.id ?? explicitId ?? availableProviderId(providerIdFromBaseUrl(baseUrl, protocol), store.providers);
  const openaiApi = protocol === "openai" ? (wire as OpenAIApi | undefined) ?? existing?.openaiApi : undefined;
  const metadataOptions = resolveMetadataOptions(opts, existing);
  const manualIds = (answers.models ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  let modelIds = manualIds;
  const modelFilter = parseFilterOpts(opts, existing?.modelFilter);
  const shouldDiscover = opts.discover || manualIds.length === 0;
  if (shouldDiscover) {
    if (!opts.discover) {
      note(t("add.autoDiscover"));
    }
    const discover = (): Promise<string[]> =>
      withProgress(t("add.discovering", { url: baseUrl }), (progress) =>
        discoverProviderModels({ baseUrl, apiKey: answers.apiKey!, protocol }, {
          onPage: ({ page, count }) => progress.update(t("progress.discoverPage", { url: baseUrl, page, count })),
        }));
    let discovered: string[] = [];
    for (let attempt = 0; ; attempt++) {
      try {
        discovered = await discover();
        break;
      } catch (err) {
        // Unattended runs keep failing fast; a person at the terminal gets a bounded retry, then manual ids.
        if (!interactive) throw err;
        if (attempt >= 2) break;
        const { retry } = await prompts(
          { type: "toggle", name: "retry", message: t("add.retryDiscovery", { error: (err as Error).message }), initial: true },
          { onCancel: () => cancelInteractive() },
        );
        if (!retry) break;
      }
    }
    if (discovered.length) out(t("add.providerLists", { count: discovered.length }));
    modelIds = [...new Set([...manualIds, ...discovered])];
  }
  const retained = [opts.defaultModel === undefined ? existing?.defaultModel : undefined, opts.smallModel === undefined ? existing?.smallModel : undefined].filter((id): id is string => !!id);
  modelIds = [...new Set([...modelIds, ...retained])];
  const pinned = [...manualIds, ...retained, ...(opts.defaultModel ? [opts.defaultModel] : []), ...(opts.smallModel ? [opts.smallModel] : [])];
  const outcome = applyModelFilter(modelIds, modelFilter, pinned);
  reportDropped(outcome.dropped);
  modelIds = outcome.kept;
  if (modelIds.length === 0) fail(t("add.atLeastOne"));

  const catalog = await withProgress(t("progress.catalog"), () => loadCatalog());
  const hint = opts.modelsDev ?? existing?.modelsDevId ?? guessProviderHint(catalog, answers.baseUrl!);
  const models = await withProgress(t("progress.metadata"), () =>
    enrichProviderModels(catalog, modelIds, { ...metadataOptions, modelsDevId: hint, models: existing?.models }));
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
  if (isJson()) {
    emitJson({ ...providerModelsReport(provider, false), created: !existed, matched });
    return;
  }
  out(pc.green(t("add.saved", { status: savedStatus, id: pc.bold(provider.id), protocol })));
  out(t("add.metadata", { matched, total: models.length }) + (hint ? t("add.providerHint", { hint }) : ""));
  out(table(modelRows(models), MODEL_HEADER, MODEL_TABLE_OPTIONS));
  printUncatalogedHint(models, catalog, hint);
  note(`\n${t("add.next", { id: provider.id })}`);
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
  const catalog = await withProgress(t("progress.catalog"), () => loadCatalog());
  const hint = opts.modelsDev ?? opts.existing?.modelsDevId ?? guessProviderHint(catalog, baseUrl);
  const models = await withProgress(t("progress.metadata"), () =>
    enrichProviderModels(catalog, modelIds, { ...metadataOptions, modelsDevId: hint, models: opts.existing?.models }, { gatewayLoader: opts.gatewayLoader }));
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
  out(pc.green(t("add.saved", { status: savedStatus, id: pc.bold(provider.id), protocol })));
  out(t("add.metadata", { matched, total: models.length }) + (hint ? t("add.providerHint", { hint }) : ""));
  out(table(modelRows(models), MODEL_HEADER, MODEL_TABLE_OPTIONS));
  printUncatalogedHint(models, catalog, hint);
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
  const interactive = process.stdin.isTTY === true && !opts.yes && !isJson();

  let baseUrl: string;
  let apiKey: string;

  if (interactive) {
    const answers = await prompts(
      [
        { type: "text", name: "baseUrl", message: t("add.baseUrl"), validate: (v: string) => (/^https?:\/\//.test(v) ? true : t("add.baseUrlInvalid")) },
        { type: "password", name: "apiKey", message: t("add.apiKey") },
      ],
      { onCancel: () => cancelInteractive() },
    );
    baseUrl = normalizeUrl(answers.baseUrl);
    apiKey = answers.apiKey;
  } else {
    if (!opts.baseUrl) fail(t("add.fieldRequired", { field: "base-url" }));
    if (!opts.apiKey) fail(t("add.fieldRequired", { field: "api-key" }));
    baseUrl = normalizeUrl(opts.baseUrl);
    apiKey = opts.apiKey;
  }

  const probe = (): Promise<Protocol[]> =>
    withProgress(t("quick.probing", { url: baseUrl }), (progress) =>
      probeProtocols({ baseUrl, apiKey }, {
        onAttempt: (protocol) => progress.update(t("progress.probe", { url: baseUrl, protocol })),
      }));

  let protocols = await probe();

  // A typo in the endpoint is the common cause of "nothing answered"; let the user correct it instead of exiting.
  for (let attempt = 0; interactive && protocols.length === 0 && attempt < 2; attempt++) {
    const { retry } = await prompts(
      { type: "toggle", name: "retry", message: t("quick.retryProbe", { url: baseUrl }), initial: true },
      { onCancel: () => cancelInteractive() },
    );
    if (!retry) break;
    const again = await prompts(
      [
        { type: "text", name: "baseUrl", message: t("add.baseUrl"), initial: baseUrl, validate: (v: string) => (/^https?:\/\//.test(v) ? true : t("add.baseUrlInvalid")) },
        { type: "password", name: "apiKey", message: t("add.apiKey") },
      ],
      { onCancel: () => cancelInteractive() },
    );
    if (!again.baseUrl || !again.apiKey) break;
    baseUrl = normalizeUrl(again.baseUrl);
    apiKey = again.apiKey;
    protocols = await probe();
  }

  if (protocols.length === 0) {
    fail(t("quick.noProtocol"));
  }

  if (opts.openaiApi !== undefined && opts.openaiApi !== "completions" && opts.openaiApi !== "responses") fail(t("add.openaiApiInvalid"));
  const multi = protocols.length > 1;
  const createdIds: string[] = [];
  const gatewayLoader = sharedGatewayLoader();

  for (const protocol of protocols) {
    const explicitId = opts.id === undefined ? undefined : `${opts.id}${multi ? `-${protocol}` : ""}`;
    const byId = explicitId ? store.providers[explicitId] : undefined;
    const sameAccount = byId ? undefined : findMatchingProvider(Object.values(store.providers), { protocol, baseUrl, apiKey });
    const existing = byId ?? sameAccount;
    if (byId === undefined && explicitId && sameAccount) {
      out(pc.yellow(t("add.alreadyConfigured", { id: pc.bold(sameAccount.id) })));
    }
    const id = byId?.id ?? sameAccount?.id ?? explicitId ?? availableProviderId(providerIdFromBaseUrl(baseUrl, protocol), store.providers);
    const name = opts.name ?? existing?.name ?? (opts.id === undefined ? providerNameFromBaseUrl(baseUrl, protocol) : multi ? `${opts.id} (${protocol})` : opts.id);
    const modelFilter = parseFilterOpts(opts, existing?.modelFilter);

    const discovered = await withProgress(`${t("add.discovering", { url: baseUrl })} [${protocol}]`, (progress) =>
      discoverProviderModels({ baseUrl, apiKey, protocol }, {
        onPage: ({ page, count }) => progress.update(`${t("progress.discoverPage", { url: baseUrl, page, count })} [${protocol}]`),
      }));
    out(t("add.providerLists", { count: discovered.length }));

    const retained = [opts.defaultModel === undefined ? existing?.defaultModel : undefined, opts.smallModel === undefined ? existing?.smallModel : undefined].filter((id): id is string => !!id);
    let modelIds = [...new Set([...discovered, ...retained])];
    const pinned = [...retained, ...(opts.defaultModel ? [opts.defaultModel] : []), ...(opts.smallModel ? [opts.smallModel] : [])];
    const outcome = applyModelFilter(modelIds, modelFilter, pinned);
    reportDropped(outcome.dropped);
    modelIds = outcome.kept;
    if (modelIds.length === 0) {
      out(pc.yellow(t("quick.noModelsAfterFilter", { id })));
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
    note(`\n${t("add.next", { id: provider.id })}`);
  }

  saveStore(store);
  if (isJson()) {
    emitJson({ providers: createdIds });
    return;
  }
  if (createdIds.length > 0) {
    out(pc.green(t("quick.summary", { count: createdIds.length, ids: createdIds.join(", ") })));
  }
}

export function cmdList(): void {
  const store = loadStore();
  if (isJson()) {
    emitJson(listReport(store));
    return;
  }
  const ids = Object.keys(store.providers);
  if (ids.length === 0) {
    out(t("list.none", { file: configFile }));
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
  out(table(rows, [" ", "ID", t("table.protocol"), "BASE URL", t("table.defaultModel"), t("table.models")], {
    truncate: [3, 1, 4],
    align: ["left", "left", "left", "left", "left", "right"],
  }));
}

export async function cmdPrune(id: string, opts: { apps?: string }): Promise<void> {
  const store = loadStore();
  const provider = getProvider(store, id);
  out(`${t("remove.pruning", { id: pc.bold(id) })}\n`);
  const results = await runTargets("prune", provider, opts.apps);
  if (isJson()) {
    emitJson({
      provider: id,
      op: "prune",
      apps: results.filter((r) => !r.skipped).map((r) => r.app),
      files: results.flatMap((r) => (r.skipped ? [] : r.changed)),
      skipped: results.filter((r) => r.skipped).map((r) => ({ app: r.app, reason: r.skipped! })),
    });
    return;
  }
  reportResults(results);
}

function reportResults(results: ApplyResult[]): void {
  for (const r of results) {
    if (r.skipped) {
      out(`${pc.yellow(t("common.skip"))} ${r.app.padEnd(9)} ${pc.dim(r.skipped)}`);
      continue;
    }
    // An empty change list means the app was already in sync: say so rather than
    // printing a bare "ok" with nothing after it.
    const detail = r.changed.length ? r.changed.join(", ") : pc.dim(t("preview.unchanged"));
    out(`${pc.green("ok  ")} ${r.app.padEnd(9)} ${detail}`);
    for (const note of r.notes) out(`     ${" ".repeat(9)} ${pc.dim(note)}`);
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
      const safe = redactErrors && !(err instanceof SafeConfigError);
      results.push({ app: target.id, changed: [], notes: [], skipped: pc.red(`failed: ${safe ? t("preview.failedSafely") : (err as Error).message}`) });
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
    out(`${pc.dim(t("preview.unchanged"))} ${file}`);
    return;
  }
  out(pc.bold(t("preview.header", { file })));
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
    out(pc.dim(t("preview.contentWithheld")));
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
    else out(pc.red(`- ${line}`));
  }
  for (const line of newLines) {
    const count = oldSeen.get(line) ?? 0;
    if (count > 0) oldSeen.set(line, count - 1);
    else out(pc.green(`+ ${line}`));
  }
  if (oldText === newText) out(pc.dim(t("preview.onlyRedacted")));
}

interface SyncOutcome {
  apps: string[];
  files: string[];
  skipped: Array<{ app: string; reason: string }>;
}

async function runWithOptionalDryRun(
  op: "apply" | "prune",
  provider: Provider,
  apps: string | undefined,
  dryRun: boolean | undefined,
): Promise<SyncOutcome> {
  const summarize = (results: ApplyResult[], files: string[]): SyncOutcome => ({
    apps: results.map((r) => r.app),
    files,
    skipped: results.filter((r) => r.skipped).map((r) => ({ app: r.app, reason: r.skipped! })),
  });
  if (!dryRun) {
    const results = await runTargets(op, provider, apps);
    reportResults(results);
    return summarize(results, results.flatMap((r) => (r.skipped ? [] : r.changed)));
  }
  setDryRun(true);
  try {
    const results = await runTargets(op, provider, apps, true);
    const writes = drainPendingWrites();
    for (const r of results) {
      if (r.skipped) out(`${pc.yellow(t("dryRun.skip"))} ${r.app.padEnd(9)} ${pc.dim(r.skipped)}`);
    }
    out(pc.bold(`\n${t("dryRun.wouldWrite", { count: writes.length })}\n`));
    for (const w of writes) printFileDiff(w.file, w.content, provider.apiKey);
    // Only paths: the staged content is redacted for humans but still configuration, not a machine interface.
    return summarize(results, writes.map((w) => w.file));
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
  out(`${t("use.switching", { id: pc.bold(id), protocol: provider.protocol, model: provider.defaultModel })}\n`);
  const outcome = await runWithOptionalDryRun("apply", provider, opts.apps, opts.dryRun);
  if (isJson()) {
    emitJson({ provider: id, model: provider.defaultModel, dryRun: opts.dryRun === true, ...outcome });
  }
}

export async function cmdSync(opts: { apps?: string; provider?: string; dryRun?: boolean }): Promise<void> {
  resolveTargets(opts.apps);
  const store = loadStore();
  const id = opts.provider ?? store.active;
  if (!id) fail(t("sync.noActive"));
  const provider = getProvider(store, id);
  out(`${t("sync.syncing", { id: pc.bold(id), model: provider.defaultModel })}\n`);
  const outcome = await runWithOptionalDryRun("apply", provider, opts.apps, opts.dryRun);
  if (isJson()) {
    emitJson({ provider: id, model: provider.defaultModel, dryRun: opts.dryRun === true, ...outcome });
  }
}

export function cmdStatus(): void {
  const store = loadStore();
  const apps = targets.map((target) => ({
    id: target.id,
    detected: target.detect(),
    protocols: [...target.protocols],
    current: target.current() ?? null,
    configPath: target.configPaths[0] ?? "",
  }));
  if (isJson()) {
    emitJson(statusReport(configFile, store, apps));
    return;
  }
  out(t("status.config", { file: configFile }));
  out(`${t("status.active", { id: store.active ? pc.bold(store.active) : pc.dim(t("status.none")) })}\n`);
  const rows = apps.map((app) => [
    app.id,
    app.detected ? pc.green(t("common.yes")) : pc.dim(t("common.no")),
    app.protocols.join("+"),
    app.current ?? pc.dim("-"),
    pc.dim(app.configPath),
  ]);
  out(table(rows, ["APP", t("table.found"), t("table.protocols"), t("table.current"), t("table.config")], {
    truncate: [4, 3],
  }));
}

/** `--limit` is user input: a non-numeric or non-positive value must fail, not silently list everything. */
function parseLimit(value: string | undefined): number {
  const limit = value === undefined ? 30 : Number(value);
  if (!Number.isInteger(limit) || limit < 1) fail(t("error.limit"));
  return limit;
}

export async function cmdModels(
  query: string | undefined,
  opts: { provider?: string; refresh?: boolean; limit?: string; metadata?: boolean },
): Promise<void> {
  if (opts.metadata && !opts.provider) fail(t("models.metadataRequiresProvider"));
  if (opts.provider) {
    const store = loadStore();
    const provider = getProvider(store, opts.provider);
    if (isJson()) {
      emitJson(providerModelsReport(provider, opts.metadata === true));
      return;
    }
    // Kept as a bare document without --json: existing scripts parse it directly.
    if (opts.metadata) {
      out(JSON.stringify(providerMetadataReport(provider), null, 2));
      return;
    }
    out(`${pc.bold(provider.id)} (${provider.protocol}) · ${provider.baseUrl}`);
    out(table(modelRows(provider.models), MODEL_HEADER, MODEL_TABLE_OPTIONS));
    printUncatalogedHint(provider.models, await withProgress(t("progress.catalog"), () => loadCatalog()), provider.modelsDevId);
    return;
  }
  const catalog = await withProgress(t("progress.catalog"), () => loadCatalog({ refresh: opts.refresh }));
  if (!catalog) fail(t("models.catalogUnavailable"));
  if (!query) fail(t("models.usage"));
  const limit = parseLimit(opts.limit);
  const hits = searchCatalog(catalog, query, limit);
  if (isJson()) {
    emitJson(modelsQueryReport(query, hits));
    return;
  }
  if (hits.length === 0) {
    out(t("models.noMatch", { query }));
    return;
  }
  const rows = hits.map((h) => {
    const row = modelRows([h.spec])[0]!;
    return [h.provider, ...row];
  });
  out(table(rows, ["PROVIDER", ...MODEL_HEADER], MODEL_QUERY_OPTIONS));
}

export async function cmdRefreshMeta(opts: MetadataOptions & { provider?: string } = {}): Promise<void> {
  const store = loadStore();
  const providers = opts.provider ? [getProvider(store, opts.provider)] : Object.values(store.providers);
  resolveMetadataOptions(opts);
  for (const provider of providers) Object.assign(provider, resolveMetadataOptions(opts, provider));
  const catalog = await withProgress(t("progress.catalog"), () => loadCatalog({ refresh: true }));
  const gatewayLoader = sharedGatewayLoader(true);
  let updated = 0;
  for (const provider of providers) {
    const before = JSON.stringify(provider.models);
    provider.models = await withProgress(t("progress.metadata"), () =>
      enrichProviderModels(catalog, provider.models.map((m) => m.id), {
        ...provider,
        modelsDevId: provider.modelsDevId ?? guessProviderHint(catalog, provider.baseUrl),
      }, { gatewayLoader }));
    if (JSON.stringify(provider.models) !== before) updated++;
  }
  saveStore(store);
  if (isJson()) {
    emitJson({ checked: providers.length, updated, providers: providers.map((p) => p.id) });
    return;
  }
  out(pc.green(t("refresh.checked", { changed: updated })));
  if (updated > 0) note(t("refresh.next"));
  for (const provider of providers) printUncatalogedHint(provider.models, catalog, provider.modelsDevId);
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
  const listed = await withProgress(t("add.discovering", { url: provider.baseUrl }), (progress) =>
    discoverProviderModels(provider, {
      onPage: ({ page, count }) => progress.update(t("progress.discoverPage", { url: provider.baseUrl, page, count })),
    }));
  const pinned = [provider.defaultModel, provider.smallModel].filter((model): model is string => !!model);
  const outcome = applyModelFilter(listed, provider.modelFilter, pinned);
  reportDropped(outcome.dropped);
  const ids = outcome.kept;
  // Pinned ids survive a listing that dropped them, so they are not "removed upstream".
  const retainedIds = [...new Set([...ids, ...pinned])];
  const retained = new Set(retainedIds);
  const known = provider.models.map((m) => m.id);
  const added = ids.filter((m) => !known.includes(m));
  const gone = known.filter((m) => !retained.has(m));
  const catalog = await withProgress(t("progress.catalog"), () => loadCatalog());
  provider.models = await withProgress(t("progress.metadata"), () =>
    enrichProviderModels(catalog, retainedIds, { ...provider, modelsDevId: provider.modelsDevId ?? guessProviderHint(catalog, provider.baseUrl) }));
  if (!ids.includes(provider.defaultModel)) {
    out(pc.yellow(t("discover.defaultMissing", { model: provider.defaultModel })));
  }
  saveStore(store);
  if (isJson()) {
    emitJson({ provider: id, models: ids.length, added, removed: gone });
    return;
  }
  out(
    `${pc.bold(id)}: ${ids.length} models (${pc.green(`+${added.length}`)} / ${pc.red(`-${gone.length}`)})` +
      (added.length ? `\n  new: ${added.join(", ")}` : "") +
      (gone.length ? `\n  removed upstream: ${gone.join(", ")}` : ""),
  );
  out(table(modelRows(provider.models), MODEL_HEADER, MODEL_TABLE_OPTIONS));
  printUncatalogedHint(provider.models, catalog, provider.modelsDevId);
  if (opts.sync) {
    out("");
    await cmdSync({ provider: id, apps: opts.apps });
  } else {
    note(`\n${t("discover.next")}`);
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

async function collectAppRows(onProgress?: (done: number, total: number) => void): Promise<AppRow[]> {
  const total = appPackages.length;
  let done = 0;
  return Promise.all(
    appPackages.map(async (app) => {
      try {
        const [installedResult, latestResult] = await Promise.allSettled([
          Promise.resolve().then(() => installedVersion(app)),
          latestVersion(app),
        ]);
        const installed = installedResult.status === "fulfilled" ? installedResult.value : "?";
        const latest = latestResult.status === "fulfilled" ? latestResult.value : undefined;
        const knownInstalled = normalizeAppVersion(installed);
        const knownLatest = normalizeAppVersion(latest);
        const checkFailed = installedResult.status === "rejected"
          ? t("apps.checkFailedProbe")
          : installed && !knownInstalled
            ? t("apps.checkFailedUnknown")
            : installed && !knownLatest
              ? t("apps.checkFailedLatest")
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
      } finally {
        onProgress?.(++done, total);
      }
    }),
  );
}

type AppStatus = "upgradable" | "installable" | "not-installed" | "unknown" | "up-to-date";

function appStatus(row: AppRow): AppStatus {
  if (row.upgradable) return "upgradable";
  if (!row.installed) return row.installable ? "installable" : "not-installed";
  return row.checkFailed || !normalizeAppVersion(row.latest) ? "unknown" : "up-to-date";
}

function appStatusLabel(status: AppStatus): string {
  switch (status) {
    case "upgradable": return pc.yellow(t("apps.upgradeAvailable"));
    case "installable": return pc.dim(t("apps.installable"));
    case "not-installed": return pc.dim("-");
    case "unknown": return pc.dim(t("apps.unknown"));
    case "up-to-date": return pc.green(t("apps.upToDate"));
  }
}

export async function cmdApps(): Promise<void> {
  const rows = await withProgress(t("apps.checking"), (progress) =>
    collectAppRows((done, total) => progress.update(t("progress.apps", { done, total }))));
  if (isJson()) {
    const report: AppReportRow[] = rows.map((row) => ({
      id: row.id,
      name: row.name,
      installed: row.installed,
      latest: row.latest,
      upgradable: row.upgradable,
      installable: row.installable,
      status: appStatus(row),
    }));
    emitJson(appsReport(report));
    return;
  }
  out(
    table(
      rows.map((r) => [
        r.id,
        r.installed ?? pc.dim(t("apps.notInstalled")),
        r.latest ?? pc.dim("?"),
        appStatusLabel(appStatus(r)),
      ]),
      ["APP", "INSTALLED", "LATEST", "STATUS"],
    ),
  );
  const upgradable = rows.filter((r) => r.upgradable).map((r) => r.id);
  if (upgradable.length) note(`\n${t("apps.upgradeWith", { ids: upgradable.join(" ") })}`);
}

export async function cmdInstall(id: string): Promise<void> {
  const app = appPackages.find((a) => a.id === id);
  if (!app) fail(t("install.unknownApp", { value: id, apps: appPackages.map((a) => a.id).join(", ") }));
  const installCmd = appCommand(app, "install");
  if (!installCmd) fail(t("install.notInstallable", { name: app.name, platform: process.platform }));
  const installed = installedVersion(app);
  if (installed) {
    if (isJson()) {
      emitJson({ app: id, status: "already-installed", version: installed });
      return;
    }
    out(t("install.already", { name: app.name, version: installed, id }));
    return;
  }
  out(t("install.installing", { name: app.name, command: pc.dim(installCmd) }));
  runShell(installCmd);
  const detected = installedVersion(app);
  if (!detected) throw new Error(t("install.notDetected", { name: app.name }));
  const version = normalizeAppVersion(detected);
  if (!version) {
    if (isJson()) error(t("install.versionUnknown", { name: app.name }));
    out(pc.yellow(t("install.versionUnknown", { name: app.name })));
    process.exitCode = 1;
    return;
  }
  if (isJson()) {
    emitJson({ app: id, status: "installed", version });
    return;
  }
  out(pc.green(t("install.installed", { name: app.name, version })));
}

export async function cmdUpgrade(ids: string[]): Promise<void> {
  let selected = appPackages.filter((a) => ids.length === 0 || ids.includes(a.id));
  const unknown = ids.filter((id) => !appPackages.some((a) => a.id === id));
  if (unknown.length) fail(t("upgrade.unknownApps", { ids: unknown.join(", ") }));
  const expectedVersions = new Map<string, string>();
  const upgraded: Array<{ id: string; version: string }> = [];
  const skipped: Array<{ id: string; reason: string }> = [];
  if (ids.length === 0) {
    // no args: upgrade everything that is installed and outdated
    const rows = await withProgress(t("upgrade.checking"), (progress) =>
      collectAppRows((done, total) => progress.update(t("progress.apps", { done, total }))));
    const managed = rows.filter((row) => !!appCommand(appPackages.find((app) => app.id === row.id)!, "upgrade"));
    const failed = managed.filter((row) => row.checkFailed);
    for (const row of failed) out(pc.yellow(t("upgrade.statusUnknown", { id: row.id, reason: row.checkFailed! })));
    if (failed.length) process.exitCode = 1;
    const upgradable = managed.filter((row) => row.upgradable);
    if (upgradable.length === 0) {
      if (isJson()) {
        emitJson({ upgraded, skipped: failed.map((row) => ({ id: row.id, reason: row.checkFailed! })) });
        return;
      }
      if (failed.length) out(t("upgrade.cannotDetermine"));
      else if (managed.some((row) => row.installed)) out(t("upgrade.allCurrent"));
      else out(t("upgrade.none"));
      return;
    }
    for (const row of upgradable) expectedVersions.set(row.id, row.latest!);
    selected = appPackages.filter((app) => expectedVersions.has(app.id));
  }
  for (const app of selected) {
    const cmd = appCommand(app, "upgrade");
    if (!cmd) {
      out(`${pc.yellow(t("dryRun.skip"))} ${t("upgrade.notCli", { id: app.id })}`);
      skipped.push({ id: app.id, reason: "not-cli-managed" });
      process.exitCode = 1;
      continue;
    }
    try {
      if (!installedVersion(app)) {
        out(`${pc.yellow(t("dryRun.skip"))} ${t("upgrade.notInstalled", { id: app.id })}`);
        skipped.push({ id: app.id, reason: "not-installed" });
        process.exitCode = 1;
        continue;
      }
      out(t("upgrade.upgrading", { name: app.name, command: pc.dim(cmd) }));
      runShell(cmd);
      const version = normalizeAppVersion(installedVersion(app));
      if (!version) throw new Error(t("upgrade.unknownVersion"));
      const expected = expectedVersions.get(app.id);
      if (expected && isNewer(version, expected)) throw new Error(t("upgrade.olderThanAvailable", { version, expected }));
      out(pc.green(t("upgrade.done", { id: app.id, version })));
      upgraded.push({ id: app.id, version });
    } catch (err) {
      out(pc.red(t("upgrade.failed", { id: app.id, message: (err as Error).message })));
      skipped.push({ id: app.id, reason: (err as Error).message });
      process.exitCode = 1;
    }
  }
  if (isJson()) emitJson({ upgraded, skipped });
}

export interface ImportOptions extends MetadataOptions {
  all?: boolean;
}

/** Collect custom providers, dedupe by endpoint and credentials, and import what is new. */
export async function cmdImport(opts: ImportOptions): Promise<void> {
  const interactive = process.stdin.isTTY === true && !opts.all && !isJson();
  const metadataOptions = resolveMetadataOptions(opts);
  const rows = scanCandidates();
  const fresh = rows.filter((r) => !r.configured);
  for (const r of rows) {
    if (r.configured) {
      out(`${pc.yellow(t("import.skip"))} ${pc.bold(r.id)} · ${r.protocol} · ${r.baseUrl} — ${t("import.already", { id: pc.bold(r.configured) })}`);
    }
  }
  if (fresh.length === 0) {
    if (isJson()) {
      emitJson({ providers: [], candidates: rows.length });
      return;
    }
    out(rows.length ? t("import.noneNew") : t("import.noneFound"));
    return;
  }

  out("");
  out(
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
      { truncate: [2, 4] },
    ),
  );

  let chosen: MergedCandidate[];
  if (interactive) {
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
      { onCancel: () => cancelInteractive() },
    );
    if (!Array.isArray(pick) || pick.length === 0) {
      out(pc.dim(t("import.nothingSelected")));
      return;
    }
    chosen = (pick as number[]).map((i) => fresh[i]).filter((r): r is MergedCandidate => r !== undefined);
  } else {
    chosen = fresh;
  }

  const store = loadStore();
  const catalog = await withProgress(t("progress.catalog"), () => loadCatalog());
  const gatewayLoader = sharedGatewayLoader();
  const imported: string[] = [];
  for (const c of chosen) {
    let apiKey = c.apiKey;
    if (!apiKey) {
      const why = c.keyEnv ? t("import.keyRefMissing", { name: c.keyEnv }) : t("import.keyNotStored");
      if (!interactive) {
        fail(t("import.missingKey", { id: c.id, why }));
      }
      const a = await prompts(
        {
          type: "password",
          name: "key",
          message: t("import.keyPrompt", { id: c.id, url: c.baseUrl, why }),
          validate: (v: string) => (v.trim() ? true : t("import.required")),
        },
        { onCancel: () => cancelInteractive() },
      );
      apiKey = a.key;
    }

    // A prompted credential can identify a provider imported earlier in this same batch.
    const existing = findMatchingProvider(Object.values(store.providers), { protocol: c.protocol, baseUrl: c.baseUrl, apiKey });
    if (existing) {
      out(`${pc.yellow(t("import.skip"))} ${pc.bold(c.id)} · ${c.protocol} · ${c.baseUrl} — ${t("import.already", { id: pc.bold(existing.id) })}`);
      continue;
    }

    let ids = [...c.models];
    if (ids.length === 0) {
      const discover = (): Promise<string[]> =>
        withProgress(t("import.discovering", { id: c.id }), (progress) =>
          discoverProviderModels({ baseUrl: c.baseUrl, apiKey: apiKey!, protocol: c.protocol }, {
            onPage: ({ page, count }) => progress.update(t("progress.discoverPage", { url: c.baseUrl, page, count })),
          }));
      let listed: string[] | undefined;
      for (let attempt = 0; ; attempt++) {
        try {
          listed = await discover();
          break;
        } catch (err) {
          if (!interactive) fail(t("import.discoveryFailed", { id: c.id, error: (err as Error).message }));
          // Skipping one provider keeps the rest of the batch importable.
          if (attempt >= 2) break;
          const { retry } = await prompts(
            { type: "toggle", name: "retry", message: t("import.retryDiscovery", { id: c.id, error: (err as Error).message }), initial: true },
            { onCancel: () => cancelInteractive() },
          );
          if (!retry) break;
        }
      }
      if (listed === undefined) {
        out(pc.yellow(t("import.skippedAfterFailure", { id: c.id })));
        continue;
      }
      ids = listed;
      ids = applyModelFilter(ids, undefined, []).kept;
    }
    if (ids.length === 0) fail(t("import.noModelsImport", { id: c.id }));

    const id = availableProviderId(c.id, store.providers);
    const hint = guessProviderHint(catalog, c.baseUrl);
    const models = await withProgress(t("progress.metadata"), () =>
      enrichProviderModels(catalog, ids, { ...metadataOptions, modelsDevId: hint }, { gatewayLoader }));
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
    out(
      `${pc.green(t(existed ? "import.updated" : "import.imported"))} ${pc.bold(id)} · ${c.protocol} · ${c.baseUrl} · ${t("import.modelsCount", { count: ids.length })} [${t("import.from")} ${c.sources.join(", ")}]`,
    );
  }
  saveStore(store);
  if (isJson()) {
    emitJson({ providers: imported });
    return;
  }
  if (imported.length) note(`\n${t("import.next", { id: imported[0]! })}`);
}
