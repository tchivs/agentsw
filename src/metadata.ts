import { findModelMeta, getCatalogFetchedAt, toModelSpec, type Catalog, type CatalogModel } from "./modelsdev.js";
import { loadGatewayCatalog, type GatewayCatalog, type GatewayModelMetadata } from "./gateway.js";
import type { ModelMetadataConflict, ModelMetadataField, ModelMetadataOrigin, ModelMetadataValue, ModelSpec, Provider } from "./types.js";

export interface MetadataOptions {
  gatewayMetadata?: boolean;
  metadataMode?: string;
  /** JSON object of exact local IDs to canonical creator/model IDs. */
  gatewayModels?: string;
}

type MetadataSettings = Pick<Provider, "gatewayMetadata" | "gatewayModelAliases">;
const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
const canonicalId = /^[^/\s]+\/[^/\s]+(?:\/[^/\s]+)*$/;

export function getMetadataMode(settings: Pick<Provider, "gatewayMetadata">): "auto" | "on" | "off" {
  if (settings.gatewayMetadata === undefined || settings.gatewayMetadata === "auto") return "auto";
  if (settings.gatewayMetadata === true) return "on";
  if (settings.gatewayMetadata === false) return "off";
  throw new Error("Gateway metadata must be a boolean or auto");
}

function validateSettings(settings: MetadataSettings): MetadataSettings {
  const result: MetadataSettings = {};
  if (settings.gatewayMetadata !== undefined) {
    getMetadataMode(settings);
    result.gatewayMetadata = settings.gatewayMetadata;
  }
  const aliases = settings.gatewayModelAliases;
  if (aliases !== undefined) {
    if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(aliases))) {
      throw new Error("Gateway model mappings must be a plain object of exact IDs to creator/model IDs");
    }
    const entries = Object.entries(aliases);
    for (const [id, target] of entries) {
      if (!id || /\s/.test(id) || forbiddenKeys.has(id) || typeof target !== "string" || !canonicalId.test(target)) {
        throw new Error("Gateway model mappings must contain valid exact IDs and creator/model IDs");
      }
    }
    result.gatewayModelAliases = Object.fromEntries(entries);
  }
  return result;
}

/** Validate before any mutation or fetch; omitted settings preserve the previous values. */
export function resolveMetadataOptions(opts: MetadataOptions, previous?: MetadataSettings): MetadataSettings {
  const settings = validateSettings(previous ?? {});
  if (opts.gatewayMetadata !== undefined) {
    if (typeof opts.gatewayMetadata !== "boolean") throw new Error("Gateway metadata must be a boolean");
    settings.gatewayMetadata = opts.gatewayMetadata;
  }
  if (opts.metadataMode !== undefined) {
    if (opts.metadataMode !== "auto" && opts.metadataMode !== "on" && opts.metadataMode !== "off") {
      throw new Error("Metadata mode must be auto, on, or off");
    }
    const mode = opts.metadataMode === "auto" ? "auto" : opts.metadataMode === "on";
    if (opts.gatewayMetadata !== undefined && opts.gatewayMetadata !== mode) {
      throw new Error("Metadata mode conflicts with Gateway metadata flag");
    }
    settings.gatewayMetadata = mode;
  }
  if (opts.gatewayModels !== undefined) {
    if (typeof opts.gatewayModels !== "string") throw new Error("Gateway model mappings must be a JSON object");
    let aliases: unknown;
    try {
      aliases = JSON.parse(opts.gatewayModels);
    } catch {
      throw new Error("Gateway model mappings must be a JSON object");
    }
    settings.gatewayModelAliases = validateSettings({ gatewayModelAliases: aliases as Record<string, string> }).gatewayModelAliases;
  }
  return settings;
}

const fields: ModelMetadataField[] = [
  "name", "contextWindow", "maxInput", "maxOutput", "reasoning", "reasoningEfforts", "imageInput",
  "cost.input", "cost.output", "cost.cacheRead", "cost.cacheWrite",
];
const gatewayFields = fields.filter((field) => !field.startsWith("cost."));
const limits = ["maxInput", "maxOutput"] as const;
const coreFields = ["contextWindow", "maxOutput", "reasoning", "imageInput"] as const;

function fieldValue(spec: ModelSpec, field: ModelMetadataField): ModelMetadataValue | undefined {
  if (field.startsWith("cost.")) return spec.cost?.[field.slice(5) as keyof NonNullable<ModelSpec["cost"]>];
  return spec[field as Exclude<ModelMetadataField, `cost.${string}`>];
}

function setField(spec: ModelSpec, field: ModelMetadataField, value: ModelMetadataValue | undefined): void {
  if (field.startsWith("cost.")) {
    const leaf = field.slice(5) as keyof NonNullable<ModelSpec["cost"]>;
    if (value === undefined) {
      if (spec.cost) delete spec.cost[leaf];
    } else {
      spec.cost ??= {};
      spec.cost[leaf] = value as number;
    }
  } else {
    const record = spec as unknown as Record<string, ModelMetadataValue>;
    if (value === undefined) delete record[field];
    else record[field] = Array.isArray(value) ? [...value] : value;
  }
}

function equalValue(a: ModelMetadataValue | undefined, b: ModelMetadataValue | undefined): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((value, index) => value === b[index]);
  return a === b;
}

interface CatalogEntry {
  provider: string;
  modelId: string;
  model: CatalogModel;
}
interface CatalogIndex {
  exact: Map<string, CatalogEntry[]>;
  canonical: Map<string, CatalogEntry[]>;
}
interface ExactMatch {
  primary?: CatalogEntry;
  gatewayId?: string;
  alias?: string;
}

function indexCatalog(catalog: Catalog): CatalogIndex {
  const exact = new Map<string, CatalogEntry[]>();
  const canonical = new Map<string, CatalogEntry[]>();
  for (const provider of Object.values(catalog)) {
    for (const [key, model] of Object.entries(provider.models)) {
      const modelId = model.id.includes("/") ? model.id : `${provider.id}/${model.id}`;
      const entry = { provider: provider.id, modelId, model };
      for (const id of new Set([key, model.id])) {
        const matches = exact.get(id);
        if (matches) matches.push(entry);
        else exact.set(id, [entry]);
      }
      const matches = canonical.get(modelId);
      if (matches) matches.push(entry);
      else canonical.set(modelId, [entry]);
    }
  }
  return { exact, canonical };
}

function indexGatewayBareIds(gateway: GatewayCatalog): Map<string, string | null> {
  const result = new Map<string, string | null>();
  for (const id of Object.keys(gateway.models)) {
    const slash = id.indexOf("/");
    if (slash < 1 || slash !== id.lastIndexOf("/") || !canonicalId.test(id)) continue;
    const bare = id.slice(slash + 1);
    result.set(bare, result.has(bare) ? null : id);
  }
  return result;
}

function selectExact(
  index: CatalogIndex | undefined, id: string, hint: string | undefined,
  aliases: Record<string, string> | undefined, gateway: GatewayCatalog | undefined,
  gatewayBareIds?: Map<string, string | null>,
): ExactMatch {
  const alias = aliases && Object.hasOwn(aliases, id) ? aliases[id] : undefined;
  const bare = !id.includes("/");
  let gatewayId = alias;
  if (gatewayId === undefined && gateway) {
    if (canonicalId.test(id) && Object.hasOwn(gateway.models, id)) gatewayId = id;
    else if (bare) {
      const candidate = gatewayBareIds?.get(id);
      const evidence = index?.exact.get(id);
      const hintedEvidence = hint ? evidence?.filter((entry) => entry.provider === hint) : undefined;
      const identities = new Set((hintedEvidence?.length ? hintedEvidence : evidence)?.map((entry) => entry.modelId));
      // A unique exact basename is safe only with absent or agreeing primary evidence.
      // Explicit provider hints can resolve primary ambiguity, but never Gateway ambiguity.
      if (candidate && (identities.size === 0 || (identities.size === 1 && identities.has(candidate)))) gatewayId = candidate;
    }
  }
  const candidates = gatewayId !== undefined
    ? index?.canonical.get(gatewayId)
    : (bare && hint ? index?.canonical.get(`${hint}/${id}`) : undefined)
      ?? index?.canonical.get(id) ?? index?.exact.get(id);
  const hinted = candidates?.find((entry) => entry.provider === hint);
  const identities = new Set(candidates?.map((entry) => entry.modelId));
  const primary = hinted ?? (identities.size === 1
    ? candidates?.find((entry) => entry.modelId.startsWith(`${entry.provider}/`)) ?? candidates?.[0]
    : undefined);
  return { primary, gatewayId, alias };
}

function legacyPrimary(catalog: Catalog, id: string, hint?: string): { spec: ModelSpec; modelId: string } | undefined {
  const hit = findModelMeta(catalog, id, hint);
  if (!hit) return undefined;
  const provider = Object.values(catalog).find((candidate) => candidate.id === hit.provider);
  const base = id.slice(id.lastIndexOf("/") + 1).toLowerCase();
  const model = provider && (Object.hasOwn(provider.models, id) ? provider.models[id]
    : Object.entries(provider.models).find(([key]) => key.slice(key.lastIndexOf("/") + 1).toLowerCase() === base)?.[1]);
  if (!model) return undefined;
  hit.spec.id = model.id;
  return { spec: hit.spec, modelId: model.id.includes("/") ? model.id : `${hit.provider}/${model.id}` };
}

function clearGatewayIdentity(spec: ModelSpec): void {
  const metadata = spec.metadata;
  if (!metadata) return;
  for (const field of fields) {
    const origin = metadata.fields?.[field];
    if (origin?.source !== "ai-gateway") continue;
    if (equalValue(fieldValue(spec, field), origin.value)) setField(spec, field, undefined);
    delete metadata.fields![field];
  }
  delete metadata.gateway;
  if (metadata.conflicts) metadata.conflicts = metadata.conflicts.filter((conflict) => conflict.source !== "ai-gateway");
}

function clearStaleIdentity(spec: ModelSpec, modelId: string): void {
  const metadata = spec.metadata;
  if (!metadata) return;
  for (const field of fields) {
    const origin = metadata.fields?.[field];
    if (!origin || origin.modelId === modelId) continue;
    if (equalValue(fieldValue(spec, field), origin.value)) setField(spec, field, undefined);
    delete metadata.fields![field];
  }
  if (metadata.gateway && metadata.gateway.modelId !== modelId) delete metadata.gateway;
  if (metadata.conflicts) metadata.conflicts = metadata.conflicts.filter((conflict) => conflict.modelId === modelId);
}

/** Apply a source as a set of field proposals, checking bounds against retained values first. */
function mergeSource(
  spec: ModelSpec, incoming: ModelSpec, source: ModelMetadataOrigin["source"], modelId: string,
  now: string, fetchedAt?: string, supplementalGateway?: ModelSpec,
): void {
  const sourceFields = source === "ai-gateway" ? gatewayFields : fields;
  const proposals = new Map<ModelMetadataField, ModelMetadataValue>();
  const conflicts: ModelMetadataConflict[] = [];
  const conflict = (field: ModelMetadataField, value: ModelMetadataValue, keptValue: ModelMetadataValue, blockedBy?: ModelMetadataField): void => {
    conflicts.push({ field, source, modelId, value: Array.isArray(value) ? [...value] : value,
      keptValue: Array.isArray(keptValue) ? [...keptValue] : keptValue, ...(blockedBy ? { blockedBy } : {}) });
  };
  for (const field of sourceFields) {
    const value = fieldValue(incoming, field);
    if (value === undefined) continue;
    if (field === "name" && (value === incoming.id || value === modelId)) continue;
    const current = fieldValue(spec, field);
    const origin = spec.metadata?.fields?.[field];
    if (current === undefined || (origin && (source === "models.dev" || origin.source === source))) {
      proposals.set(field, value);
    } else if (!equalValue(current, value)) {
      conflict(field, value, current);
    }
  }

  // A proposed context may shrink only when every retained limit still fits.
  let context = proposals.get("contextWindow") ?? spec.contextWindow;
  if (typeof context === "number" && proposals.has("contextWindow")) {
    for (const field of limits) {
      const proposed = proposals.get(field);
      const primaryFits = typeof proposed === "number" && proposed <= context;
      let retained = primaryFits ? proposed : fieldValue(spec, field);
      // The supplement runs next: account for a still-owned limit that it can
      // lower in this same refresh, rather than requiring a second refresh.
      const next = supplementalGateway && spec.metadata?.fields?.[field]?.source === "ai-gateway"
        ? supplementalGateway[field] : undefined;
      if (!primaryFits && typeof next === "number" && next <= context) retained = next;
      if (typeof retained === "number" && retained > context) {
        conflict("contextWindow", context, retained, field);
        proposals.delete("contextWindow");
        context = spec.contextWindow;
        break;
      }
    }
  }
  for (const field of limits) {
    const value = proposals.get(field);
    if (typeof value === "number" && typeof context === "number" && value > context) {
      conflict(field, value, context, "contextWindow");
      proposals.delete(field);
    }
  }

  const reasoning = proposals.get("reasoning") ?? spec.reasoning;
  if (reasoning === false) {
    const efforts = proposals.get("reasoningEfforts");
    const emptyEfforts = Array.isArray(efforts) && efforts.length === 0;
    if (efforts !== undefined && !emptyEfforts) {
      conflict("reasoningEfforts", efforts, false, "reasoning");
      proposals.delete("reasoningEfforts");
    }
    // Do not introduce a contradictory false flag over retained effort settings.
    if (proposals.has("reasoning") && spec.reasoning !== false && !emptyEfforts && spec.reasoningEfforts?.length) {
      conflict("reasoning", false, spec.reasoningEfforts, "reasoningEfforts");
      proposals.delete("reasoning");
    }
  }

  const metadata = spec.metadata ??= {};
  if (metadata.conflicts) metadata.conflicts = metadata.conflicts.filter((entry) => entry.source !== source);
  if (conflicts.length) metadata.conflicts = [...(metadata.conflicts ?? []), ...conflicts];
  for (const [field, value] of proposals) {
    const previous = metadata.fields?.[field];
    const unchanged = previous?.source === source && previous.modelId === modelId && equalValue(previous.value, value);
    const origin: ModelMetadataOrigin = {
      source, modelId, value: Array.isArray(value) ? [...value] : value,
      updatedAt: unchanged ? previous.updatedAt : now,
    };
    const timestamp = fetchedAt ?? (unchanged ? previous.fetchedAt : undefined);
    if (timestamp !== undefined) origin.fetchedAt = timestamp;
    (metadata.fields ??= {})[field] = origin;
    setField(spec, field, value);
  }
}

/** Supplement metadata only; IDs, routes, protocol and provider-effective pricing remain untouched. */
export async function enrichProviderModels(
  catalog: Catalog | undefined,
  ids: string[],
  settings: Pick<Provider, "modelsDevId" | "gatewayMetadata" | "gatewayModelAliases"> & { models?: ModelSpec[] },
  options: { gateway?: GatewayCatalog | null; gatewayLoader?: () => Promise<GatewayCatalog | null> } = {},
): Promise<ModelSpec[]> {
  const validated = validateSettings(settings);
  const mode = getMetadataMode(validated);
  if (ids.length === 0) return [];
  const enabled = mode !== "off";
  const index = enabled && catalog ? indexCatalog(catalog) : undefined;
  const existing = new Map(settings.models?.map((model) => [model.id, model]));
  const fetchedAt = catalog ? getCatalogFetchedAt(catalog) : undefined;
  const now = new Date().toISOString();
  const enrich = (gateway?: GatewayCatalog): ModelSpec[] => {
    const gatewayBareIds = gateway ? indexGatewayBareIds(gateway) : undefined;
    return ids.map((id) => {
      const previous = existing.get(id);
      const spec: ModelSpec = previous ? structuredClone(previous) : { id };
      for (const field of fields) {
        const origin = spec.metadata?.fields?.[field];
        if (origin && !equalValue(fieldValue(spec, field), origin.value)) delete spec.metadata!.fields![field];
      }
      let primary: { spec: ModelSpec; modelId: string } | undefined;
      let supplement: GatewayModelMetadata | undefined;
      let match: ExactMatch | undefined;
      if (enabled) {
        match = selectExact(index, id, settings.modelsDevId, validated.gatewayModelAliases, gateway, gatewayBareIds);
        const oldGateway = spec.metadata?.gateway;
        if (oldGateway && (oldGateway.alias !== match.alias
          || (match.gatewayId !== undefined && oldGateway.modelId !== match.gatewayId))) {
          clearGatewayIdentity(spec);
        }
        if (match.primary) primary = { spec: toModelSpec(match.primary.model.id, match.primary.model), modelId: match.primary.modelId };
        if (gateway && match.gatewayId !== undefined && Object.hasOwn(gateway.models, match.gatewayId)) {
          supplement = gateway.models[match.gatewayId];
        }
        // An explicit mapping establishes identity even offline. An outage without
        // a mapping or exact catalog evidence does not justify deleting metadata.
        const confirmedId = match.alias ?? match.primary?.modelId ?? supplement?.id;
        if (confirmedId !== undefined) clearStaleIdentity(spec, confirmedId);
      } else if (catalog) {
        primary = legacyPrimary(catalog, id, settings.modelsDevId);
      }
      if (primary) mergeSource(spec, primary.spec, "models.dev", primary.modelId, now, fetchedAt, supplement?.spec);
      if (supplement && gateway && match) {
        mergeSource(spec, supplement.spec, "ai-gateway", supplement.id, now, gateway.fetchedAt);
        const audit: NonNullable<NonNullable<ModelSpec["metadata"]>["gateway"]> = { modelId: supplement.id, fetchedAt: gateway.fetchedAt };
        if (match.alias !== undefined) audit.alias = match.alias;
        if (supplement.referenceCost !== undefined) audit.referenceCost = structuredClone(supplement.referenceCost);
        if (supplement.pricingIsVariable !== undefined) audit.pricingIsVariable = supplement.pricingIsVariable;
        (spec.metadata ??= {}).gateway = audit;
      }
      if (spec.metadata?.fields && Object.keys(spec.metadata.fields).length === 0) delete spec.metadata.fields;
      if (spec.metadata?.conflicts?.length === 0) delete spec.metadata.conflicts;
      if (spec.metadata && Object.keys(spec.metadata).length === 0) delete spec.metadata;
      return spec;
    });
  };
  if (!enabled) return enrich();
  if (options.gateway !== undefined) return enrich(options.gateway ?? undefined);
  const primaryOnly = mode === "auto" ? enrich() : undefined;
  if (primaryOnly && !primaryOnly.some((spec) => {
    if (coreFields.some((field) => spec[field] === undefined)
      || gatewayFields.some((field) => spec.metadata?.fields?.[field]?.source === "ai-gateway")) return true;
    // Complete legacy basename metadata still needs an exact identity check,
    // unless an explicit mapping or current primary match already confirms it.
    if (!canonicalId.test(spec.id) || !fields.some((field) => {
      const origin = spec.metadata?.fields?.[field];
      return origin && origin.modelId !== spec.id;
    })) return false;
    const match = selectExact(index, spec.id, settings.modelsDevId, validated.gatewayModelAliases, undefined);
    const confirmedId = match.alias ?? match.primary?.modelId ?? spec.id;
    return fields.some((field) => {
      const origin = spec.metadata?.fields?.[field];
      return origin && origin.modelId !== confirmedId;
    });
  })) return primaryOnly;
  let gateway: GatewayCatalog | null;
  try {
    gateway = await (options.gatewayLoader ?? loadGatewayCatalog)() ?? null;
  } catch {
    gateway = null;
  }
  // Never feed the primary pre-pass back into merging: identity and coordinated
  // bounds must be resolved with the supplement against the original values.
  return gateway ? enrich(gateway) : primaryOnly ?? enrich();
}
