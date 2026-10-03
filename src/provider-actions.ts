import pc from "picocolors";
import { t } from "./i18n.js";
import { renameProvider } from "./rename.js";
import { listRemovableProviders, removeProvider } from "./remove.js";
import { emitJson, isJson, note, out, table } from "./ui.js";
import { listAppsReport } from "./report.js";

function reportChanges(result: { files: string[]; backupDir?: string }, dryRun?: boolean): void {
  out(t(dryRun ? "manage.preview" : "manage.changed", { count: result.files.length }));
  for (const file of result.files) out(`  ${file}`);
  if (result.backupDir) out(pc.dim(t("manage.backup", { path: result.backupDir })));
}

export async function cmdRename(id: string, newId: string, opts: { dryRun?: boolean } = {}): Promise<void> {
  const result = await renameProvider(id, newId, opts);
  if (isJson()) {
    emitJson({ id, newId, dryRun: opts.dryRun === true, files: result.files, backupDir: result.backupDir ?? null });
    return;
  }
  if (!opts.dryRun) out(pc.green(t("rename.done", { oldId: id, newId })));
  reportChanges(result, opts.dryRun);
}

export async function cmdRemoveProvider(
  id: string,
  opts: { apps?: string; prune?: boolean; dryRun?: boolean } = {},
): Promise<void> {
  const result = await removeProvider(id, opts);
  if (isJson()) {
    emitJson({
      id,
      apps: opts.apps ?? null,
      prune: opts.prune === true,
      dryRun: opts.dryRun === true,
      files: result.files,
      backupDir: result.backupDir ?? null,
    });
    return;
  }
  if (!opts.dryRun) {
    out(pc.green(opts.apps
      ? t("remove.localDone", { id, apps: opts.apps })
      : t("remove.removed", { id })));
    if (!opts.apps && !opts.prune) note(t("remove.note"));
  }
  reportChanges(result, opts.dryRun);
}

export function cmdListLocalProviders(apps: string): void {
  const rows = listRemovableProviders(apps);
  if (isJson()) {
    emitJson(listAppsReport(apps, rows));
    return;
  }
  if (!rows.length) {
    out(t("list.localNone"));
    return;
  }
  out(table(
    rows.map((row) => [row.app!, row.id, row.name && row.name !== row.id ? row.name : ""]),
    undefined,
    { truncate: [2] },
  ));
}
