/** Persistable model-id filter applied after /v1/models discovery. */
export interface ModelFilter {
  /** keep only ids matching one of these globs (substring match when no wildcard) */
  include?: string[];
  /** drop ids matching any of these globs */
  exclude?: string[];
  /** collapse snapshot variants (date suffixes, -latest) onto one id per base name */
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
 * Apply include/exclude globs and snapshot dedup.
 * `pinned` ids (explicit --models entries, current default model) are never dropped.
 */
export function applyModelFilter(ids: string[], filter: ModelFilter | undefined, pinned: string[] = []): FilterOutcome {
  if (!filter || (!filter.include?.length && !filter.exclude?.length && !filter.dedup)) {
    return { kept: ids, dropped: [] };
  }
  const includes = (filter.include ?? []).map(globToRegex);
  const excludes = (filter.exclude ?? []).map(globToRegex);
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

  if (filter.dedup) {
    const groups: Record<string, string[]> = {};
    for (const id of kept) (groups[snapshotBase(id)] ??= []).push(id);
    kept = kept.filter((id) => {
      if (pinned.includes(id)) return true;
      const group = groups[snapshotBase(id)]!;
      if (group.length === 1) return true;
      // prefer a pinned member, then the bare base name, then the newest (lexicographically last) snapshot
      const winner =
        group.find((g) => pinned.includes(g)) ??
        group.find((g) => g.toLowerCase() === snapshotBase(id)) ??
        [...group].sort().at(-1)!;
      if (id !== winner) {
        dropped.push({ id, reason: `dedup -> ${winner}` });
        return false;
      }
      return true;
    });
  }

  return { kept, dropped };
}
