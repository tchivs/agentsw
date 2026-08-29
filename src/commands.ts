import pc from "picocolors";
import prompts from "prompts";
import { loadStore, saveStore, getProvider, configFile } from "./store.js";
import { enrichModels, loadCatalog, searchCatalog, type Catalog } from "./modelsdev.js";
import { resolveTargets, supportsProtocol, targets } from "./targets/index.js";
import { discoverProviderModels } from "./discover.js";
import { appPackages, installedVersion, isNewer, latestVersion, runShell } from "./apps.js";
import { drainPendingWrites, readTextIfExists, setDryRun } from "./fsutil.js";
import { applyModelFilter, type ModelFilter } from "./filter.js";
import type { ApplyResult, ModelSpec, Protocol, Provider } from "./types.js";

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
    m.reasoning ? (m.reasoningEfforts?.join("/") ?? "yes") : "no",
    m.cost ? `$${m.cost.input ?? "?"}/$${m.cost.output ?? "?"}` : "-",
  ]);
}

const MODEL_HEADER = ["MODEL", "CTX", "IN", "OUT", "REASONING", "$IN/$OUT per M"];

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

export interface AddOptions {
  id?: string;
  name?: string;
  protocol?: string;
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

function parseFilterOpts(opts: { include?: string; exclude?: string; dedup?: boolean }): ModelFilter | undefined {
  const split = (s?: string) => s?.split(",").map((x) => x.trim()).filter(Boolean);
  const include = split(opts.include);
  const exclude = split(opts.exclude);
  if (!include?.length && !exclude?.length && !opts.dedup) return undefined;
  return { include, exclude, dedup: opts.dedup || undefined };
}

function reportDropped(dropped: Array<{ id: string; reason: string }>): void {
  if (!dropped.length) return;
  console.log(pc.dim(`filtered out ${dropped.length} model(s):`));
  for (const d of dropped) console.log(pc.dim(`  - ${d.id} (${d.reason})`));
}

export async function cmdAdd(opts: AddOptions): Promise<void> {
  const store = loadStore();
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
    });
    answers = await prompts(
      [
        {
          type: "text",
          name: "id",
          message: "provider id (slug)",
          validate: (v: string) => (/^[a-z0-9][a-z0-9_-]*$/.test(v) ? true : "lowercase slug, e.g. glm or my-proxy"),
        },
        { type: "text", name: "name", message: "display name", initial: (prev: string) => prev },
        {
          type: "select",
          name: "protocol",
          message: "wire protocol",
          choices: [
            { title: "openai (chat completions)", value: "openai" },
            { title: "anthropic (messages)", value: "anthropic" },
          ],
        },
        { type: "text", name: "baseUrl", message: "base URL", validate: (v: string) => (/^https?:\/\//.test(v) ? true : "must start with http(s)://") },
        { type: "password", name: "apiKey", message: "API key" },
        {
          type: opts.discover ? null : "text",
          name: "models",
          message: "model ids (comma separated)",
        },
      ],
      { onCancel: () => fail("cancelled") },
    );
  } else {
    const required = opts.discover
      ? (["id", "protocol", "baseUrl", "apiKey"] as const)
      : (["id", "protocol", "baseUrl", "apiKey", "models"] as const);
    for (const field of required) {
      if (!opts[field]) fail(`--${field === "baseUrl" ? "base-url" : field === "apiKey" ? "api-key" : field} is required in non-interactive mode`);
    }
    answers = {
      id: opts.id!,
      name: opts.name ?? opts.id!,
      protocol: opts.protocol!,
      baseUrl: opts.baseUrl!,
      apiKey: opts.apiKey!,
      models: opts.models ?? "",
    };
  }

  const protocol = answers.protocol as Protocol;
  if (protocol !== "openai" && protocol !== "anthropic") fail(`protocol must be "openai" or "anthropic"`);
  const baseUrl = answers.baseUrl!.replace(/\/+$/, "");
  const manualIds = (answers.models ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  let modelIds = manualIds;
  const modelFilter = parseFilterOpts(opts);
  if (opts.discover) {
    process.stderr.write(pc.dim(`discovering models from ${baseUrl} ...\n`));
    const discovered = await discoverProviderModels({ baseUrl, apiKey: answers.apiKey!, protocol });
    console.log(`provider lists ${discovered.length} model(s) via /v1/models`);
    modelIds = [...new Set([...manualIds, ...discovered])];
  }
  const pinned = [...manualIds, ...(opts.defaultModel ? [opts.defaultModel] : [])];
  const outcome = applyModelFilter(modelIds, modelFilter, pinned);
  reportDropped(outcome.dropped);
  modelIds = outcome.kept;
  if (modelIds.length === 0) fail("at least one model id is required (or pass --discover)");

  const catalog = await loadCatalog();
  const hint = opts.modelsDev ?? guessProviderHint(catalog, answers.baseUrl!);
  const models = enrichModels(catalog, modelIds, hint);
  const matched = models.filter((m) => m.contextWindow !== undefined).length;

  const defaultModel = opts.defaultModel ?? modelIds[0]!;
  if (!modelIds.includes(defaultModel)) fail(`default model "${defaultModel}" is not in the model list`);
  if (opts.smallModel && !modelIds.includes(opts.smallModel)) fail(`small model "${opts.smallModel}" is not in the model list`);

  const provider: Provider = {
    id: answers.id!,
    name: answers.name || answers.id!,
    protocol,
    baseUrl,
    apiKey: answers.apiKey!,
    models,
    defaultModel,
    smallModel: opts.smallModel,
    reasoningEffort: opts.reasoningEffort,
    modelsDevId: hint,
    modelFilter,
  };

  const existed = store.providers[provider.id] !== undefined;
  store.providers[provider.id] = provider;
  if (!store.active) store.active = provider.id;
  saveStore(store);

  console.log(pc.green(`${existed ? "updated" : "added"} provider ${pc.bold(provider.id)} (${protocol})`));
  console.log(`models.dev metadata: ${matched}/${models.length} models matched${hint ? ` (provider hint: ${hint})` : ""}`);
  console.log(table(modelRows(models), MODEL_HEADER));
  console.log(pc.dim(`\nnext: smart-switch use ${provider.id}`));
}

export function cmdList(): void {
  const store = loadStore();
  const ids = Object.keys(store.providers);
  if (ids.length === 0) {
    console.log(`no providers configured (config: ${configFile})\nrun: smart-switch add`);
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
  console.log(table(rows, [" ", "ID", "PROTOCOL", "BASE URL", "DEFAULT MODEL", "#MODELS"]));
}

export async function cmdRemove(id: string, opts: { prune?: boolean }): Promise<void> {
  const store = loadStore();
  const provider = getProvider(store, id);
  if (opts.prune) {
    console.log(`pruning ${pc.bold(id)} from app configs\n`);
    reportResults(await runTargets("prune", provider, undefined));
    console.log("");
  }
  delete store.providers[id];
  if (store.active === id) store.active = undefined;
  saveStore(store);
  console.log(pc.green(`removed provider ${id}`));
  if (!opts.prune) {
    console.log(pc.dim("note: target app configs are left as-is; use --prune (or `smart-switch prune <id>`) to clean them"));
  }
}

export async function cmdPrune(id: string, opts: { apps?: string }): Promise<void> {
  const store = loadStore();
  const provider = getProvider(store, id);
  console.log(`pruning ${pc.bold(id)} from app configs\n`);
  reportResults(await runTargets("prune", provider, opts.apps));
}

function reportResults(results: ApplyResult[]): void {
  for (const r of results) {
    if (r.skipped) {
      console.log(`${pc.yellow("skip")} ${r.app.padEnd(9)} ${pc.dim(r.skipped)}`);
      continue;
    }
    console.log(`${pc.green("ok  ")} ${r.app.padEnd(9)} ${r.changed.join(", ")}`);
    for (const note of r.notes) console.log(`     ${" ".repeat(9)} ${pc.dim(note)}`);
  }
}

async function runTargets(op: "apply" | "prune", provider: Provider, appsFilter?: string): Promise<ApplyResult[]> {
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
    if (!target.detect() && !explicit) {
      results.push({ app: target.id, changed: [], notes: [], skipped: `${target.name} not detected (pass --apps ${target.id} to force)` });
      continue;
    }
    try {
      results.push(await target[op](provider));
    } catch (err) {
      results.push({ app: target.id, changed: [], notes: [], skipped: pc.red(`failed: ${(err as Error).message}`) });
      process.exitCode = 1;
    }
  }
  return results;
}

/** naive line diff for config previews: order-preserving added/removed lines */
function printFileDiff(file: string, next: string): void {
  const before = readTextIfExists(file) ?? "";
  if (before === next) {
    console.log(`${pc.dim("unchanged")} ${file}`);
    return;
  }
  console.log(pc.bold(`--- ${file}`));
  const oldLines = before.split("\n");
  const newLines = next.split("\n");
  const oldSeen: Record<string, number> = {};
  for (const l of oldLines) oldSeen[l] = (oldSeen[l] ?? 0) + 1;
  const newSeen: Record<string, number> = {};
  for (const l of newLines) newSeen[l] = (newSeen[l] ?? 0) + 1;
  for (const l of oldLines) {
    if ((newSeen[l] ?? 0) > 0) newSeen[l]!--;
    else console.log(pc.red(`- ${l}`));
  }
  for (const l of newLines) {
    if ((oldSeen[l] ?? 0) > 0) oldSeen[l]!--;
    else console.log(pc.green(`+ ${l}`));
  }
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
    const results = await runTargets(op, provider, apps);
    const writes = drainPendingWrites();
    for (const r of results) {
      if (r.skipped) console.log(`${pc.yellow("skip")} ${r.app.padEnd(9)} ${pc.dim(r.skipped)}`);
    }
    console.log(pc.bold(`\ndry run — ${writes.length} file(s) would be written:\n`));
    for (const w of writes) printFileDiff(w.file, w.content);
  } finally {
    setDryRun(false);
  }
}

export async function cmdUse(id: string, opts: { apps?: string; model?: string; dryRun?: boolean }): Promise<void> {
  const store = loadStore();
  const provider = getProvider(store, id);
  if (opts.model) {
    if (!provider.models.some((m) => m.id === opts.model)) {
      fail(`model "${opts.model}" is not configured on provider ${id} (have: ${provider.models.map((m) => m.id).join(", ")})`);
    }
    provider.defaultModel = opts.model;
  }
  if (!opts.dryRun) {
    store.active = id;
    saveStore(store);
  }
  console.log(`switching to ${pc.bold(id)} (${provider.protocol}) · default model ${provider.defaultModel}\n`);
  await runWithOptionalDryRun("apply", provider, opts.apps, opts.dryRun);
}

export async function cmdSync(opts: { apps?: string; provider?: string; dryRun?: boolean }): Promise<void> {
  const store = loadStore();
  const id = opts.provider ?? store.active;
  if (!id) fail("no active provider; run `smart-switch use <id>` first");
  const provider = getProvider(store, id);
  console.log(`syncing provider ${pc.bold(id)} · default model ${provider.defaultModel}\n`);
  await runWithOptionalDryRun("apply", provider, opts.apps, opts.dryRun);
}

export function cmdStatus(): void {
  const store = loadStore();
  console.log(`config: ${configFile}`);
  console.log(`active provider: ${store.active ? pc.bold(store.active) : pc.dim("(none)")}\n`);
  const rows = targets.map((t) => [
    t.id,
    t.detect() ? pc.green("yes") : pc.dim("no"),
    t.protocols.join("+"),
    t.current() ?? pc.dim("-"),
    pc.dim(t.configPaths[0] ?? ""),
  ]);
  console.log(table(rows, ["APP", "FOUND", "PROTOCOLS", "CURRENT", "CONFIG"]));
}

export async function cmdModels(
  query: string | undefined,
  opts: { provider?: string; refresh?: boolean; limit?: string },
): Promise<void> {
  if (opts.provider) {
    const store = loadStore();
    const provider = getProvider(store, opts.provider);
    console.log(`${pc.bold(provider.id)} (${provider.protocol}) · ${provider.baseUrl}`);
    console.log(table(modelRows(provider.models), MODEL_HEADER));
    return;
  }
  const catalog = await loadCatalog({ refresh: opts.refresh });
  if (!catalog) fail("models.dev catalog unavailable (offline and no cache)");
  if (!query) fail("usage: smart-switch models <query> | smart-switch models --provider <id>");
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

export async function cmdRefreshMeta(): Promise<void> {
  const store = loadStore();
  const catalog = await loadCatalog({ refresh: true });
  if (!catalog) fail("models.dev catalog unavailable");
  let updated = 0;
  for (const provider of Object.values(store.providers)) {
    const before = JSON.stringify(provider.models);
    provider.models = enrichModels(
      catalog,
      provider.models.map((m) => m.id),
      provider.modelsDevId ?? guessProviderHint(catalog, provider.baseUrl),
    );
    if (JSON.stringify(provider.models) !== before) updated++;
  }
  saveStore(store);
  console.log(pc.green(`refreshed models.dev metadata (${updated} provider(s) changed)`));
  if (updated > 0) console.log(pc.dim("run `smart-switch sync` to push updated metadata into app configs"));
}

export async function cmdDiscover(
  id: string,
  opts: { sync?: boolean; apps?: string; include?: string; exclude?: string; dedup?: boolean; filter?: boolean },
): Promise<void> {
  const store = loadStore();
  const provider = getProvider(store, id);
  // flags override and re-persist the filter; --no-filter clears it
  const flagFilter = parseFilterOpts(opts);
  if (opts.filter === false) provider.modelFilter = undefined;
  else if (flagFilter) provider.modelFilter = flagFilter;
  process.stderr.write(pc.dim(`discovering models from ${provider.baseUrl} ...\n`));
  const listed = await discoverProviderModels(provider);
  const outcome = applyModelFilter(listed, provider.modelFilter, [provider.defaultModel]);
  reportDropped(outcome.dropped);
  const ids = outcome.kept;
  const known = provider.models.map((m) => m.id);
  const added = ids.filter((m) => !known.includes(m));
  const gone = known.filter((m) => !ids.includes(m));
  const catalog = await loadCatalog();
  provider.models = enrichModels(catalog, ids, provider.modelsDevId ?? guessProviderHint(catalog, provider.baseUrl));
  if (!ids.includes(provider.defaultModel)) {
    console.log(pc.yellow(`default model ${provider.defaultModel} no longer listed; keeping it anyway`));
    provider.models.push({ id: provider.defaultModel });
  }
  saveStore(store);
  console.log(
    `${pc.bold(id)}: ${ids.length} models (${pc.green(`+${added.length}`)} / ${pc.red(`-${gone.length}`)})` +
      (added.length ? `\n  new: ${added.join(", ")}` : "") +
      (gone.length ? `\n  removed upstream: ${gone.join(", ")}` : ""),
  );
  console.log(table(modelRows(provider.models), MODEL_HEADER));
  if (opts.sync) {
    console.log("");
    await cmdSync({ provider: id, apps: opts.apps });
  } else {
    console.log(pc.dim("\nrun `smart-switch sync` to push into app configs"));
  }
}

interface AppRow {
  id: string;
  name: string;
  installed?: string;
  latest?: string;
  upgradable: boolean;
  installable: boolean;
}

async function collectAppRows(): Promise<AppRow[]> {
  return Promise.all(
    appPackages.map(async (app) => {
      const [installed, latest] = await Promise.all([
        Promise.resolve(installedVersion(app)),
        latestVersion(app),
      ]);
      return {
        id: app.id,
        name: app.name,
        installed,
        latest,
        upgradable: !!installed && installed !== "?" && !!latest && isNewer(installed, latest),
        installable: !installed && !!app.installCmd,
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
          : r.installed
            ? pc.green("up to date")
            : r.installable
              ? pc.dim("installable")
              : pc.dim("-"),
      ]),
      ["APP", "INSTALLED", "LATEST", "STATUS"],
    ),
  );
  const upgradable = rows.filter((r) => r.upgradable).map((r) => r.id);
  if (upgradable.length) console.log(pc.dim(`\nupgrade with: smart-switch upgrade ${upgradable.join(" ")}`));
}

export async function cmdInstall(id: string): Promise<void> {
  const app = appPackages.find((a) => a.id === id);
  if (!app) fail(`unknown app "${id}" (supported: ${appPackages.map((a) => a.id).join(", ")})`);
  if (!app.installCmd) fail(`${app.name} is not CLI-installable (desktop app manages itself)`);
  const installed = installedVersion(app);
  if (installed) {
    console.log(`${app.name} already installed (${installed}); use \`smart-switch upgrade ${id}\``);
    return;
  }
  console.log(`installing ${app.name}: ${pc.dim(app.installCmd)}`);
  runShell(app.installCmd);
  console.log(pc.green(`${app.name} installed: ${installedVersion(app) ?? "version unknown"}`));
}

export async function cmdUpgrade(ids: string[]): Promise<void> {
  let selected = appPackages.filter((a) => ids.length === 0 || ids.includes(a.id));
  const unknown = ids.filter((id) => !appPackages.some((a) => a.id === id));
  if (unknown.length) fail(`unknown app(s): ${unknown.join(", ")}`);
  if (ids.length === 0) {
    // no args: upgrade everything that is installed and outdated
    process.stderr.write(pc.dim("checking versions ...\n"));
    const rows = await collectAppRows();
    const upgradable = rows.filter((r) => r.upgradable).map((r) => r.id);
    if (upgradable.length === 0) {
      console.log("everything is up to date");
      return;
    }
    selected = appPackages.filter((a) => upgradable.includes(a.id));
  }
  for (const app of selected) {
    const cmd = app.upgradeCmd ?? app.installCmd;
    if (!cmd) {
      console.log(`${pc.yellow("skip")} ${app.id}: not CLI-upgradable`);
      continue;
    }
    if (!installedVersion(app)) {
      console.log(`${pc.yellow("skip")} ${app.id}: not installed (use \`smart-switch install ${app.id}\`)`);
      continue;
    }
    console.log(`upgrading ${app.name}: ${pc.dim(cmd)}`);
    try {
      runShell(cmd);
      console.log(pc.green(`${app.id} -> ${installedVersion(app) ?? "?"}`));
    } catch (err) {
      console.log(pc.red(`${app.id} upgrade failed: ${(err as Error).message}`));
      process.exitCode = 1;
    }
  }
}
