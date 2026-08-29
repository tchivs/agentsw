/** Persistable model-id filter applied after /v1/models discovery. */
export interface ModelFilter {
  /** keep only ids matching one of these globs (substring match when no wildcard) */
  include?: string[];
  /** drop ids matching any of these globs */
  exclude?: string[];
  /** set false to keep snapshot duplicates (-latest, date suffixes); dropping them is the default */
  dedup?: boolean;
}

function globToRegex(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  // bare substring patterns match anywhere; wildcards anchor the whole id
  return glob.includes("*") || glob.includes("?") ? new RegExp(`^${escaped}$`, "i") : new RegExp(escaped, "i");
}

/**
 * Strip snapshot noise from a model id to get its dedup group key:
 * trailing -latest, -YYYYMMDD, -YYYY-MM-DD, -MMDD, @YYYYMMDD, and date-stamped tails
 * like "-250414". Real variants (-air, -flash, -thinking, -mini, :free) are preserved.
 */
export function snapshotBase(id: string): string {
  return id
    .replace(/[-@.](20\d{6}|\d{6}|\d{4}-\d{2}-\d{2})$/, "")
    .replace(/-(latest|\d{4})$/, "")
    .toLowerCase();
}

export interface FilterOutcome {
  kept: string[];
  /** id -> reason, for reporting */
  dropped: Array<{ id: string; reason: string }>;
}

/**
 * Apply include/exclude globs, then drop snapshot duplicates.
 * A suffixed id (-latest, date stamps) is a duplicate only when its bare base id is
 * also listed; snapshot-only models are kept as-is (no collapsing onto a "winner").
 * Dropping duplicates is the DEFAULT; disable with filter.dedup === false.
 * `pinned` ids (explicit --models entries, current default model) are never dropped.
 */
export function applyModelFilter(ids: string[], filter: ModelFilter | undefined, pinned: string[] = []): FilterOutcome {
  const includes = (filter?.include ?? []).map(globToRegex);
  const excludes = (filter?.exclude ?? []).map(globToRegex);
  const dropped: Array<{ id: string; reason: string }> = [];

  let kept = ids.filter((id) => {
    if (pinned.includes(id)) return true;
    if (includes.length && !includes.some((re) => re.test(id))) {
      dropped.push({ id, reason: "not in --include" });
      return false;
    }
    const hit = excludes.find((re) => re.test(id));
    if (hit) {
      dropped.push({ id, reason: `--exclude ${hit.source}` });
      return false;
    }
    return true;
  });

  if (filter?.dedup !== false) {
    const present: Record<string, string> = {};
    for (const id of kept) present[id.toLowerCase()] = id;
    kept = kept.filter((id) => {
      if (pinned.includes(id)) return true;
      const base = snapshotBase(id);
      if (base === id.toLowerCase()) return true; // already a bare id
      const bare = present[base];
      if (bare !== undefined) {
        dropped.push({ id, reason: `duplicate of ${bare}` });
        return false;
      }
      return true; // snapshot-only model: nothing it duplicates
    });
  }

  return { kept, dropped };
}
