import pc from "picocolors";
import { t } from "./i18n.js";
import { renameProvider } from "./rename.js";
import { listRemovableProviders, removeProvider } from "./remove.js";

function reportChanges(result: { files: string[]; backupDir?: string }, dryRun?: boolean): void {
  console.log(t(dryRun ? "manage.preview" : "manage.changed", { count: result.files.length }));
  for (const file of result.files) console.log(`  ${file}`);
  if (result.backupDir) console.log(pc.dim(t("manage.backup", { path: result.backupDir })));
}

export async function cmdRename(id: string, newId: string, opts: { dryRun?: boolean } = {}): Promise<void> {
  const result = await renameProvider(id, newId, opts);
  if (!opts.dryRun) console.log(pc.green(t("rename.done", { oldId: id, newId })));
  reportChanges(result, opts.dryRun);
}

export async function cmdRemoveProvider(
  id: string,
  opts: { apps?: string; prune?: boolean; dryRun?: boolean } = {},
): Promise<void> {
  const result = await removeProvider(id, opts);
  if (!opts.dryRun) {
    console.log(pc.green(opts.apps
      ? t("remove.localDone", { id, apps: opts.apps })
      : t("remove.removed", { id })));
    if (!opts.apps && !opts.prune) console.log(pc.dim(t("remove.note")));
  }
  reportChanges(result, opts.dryRun);
}

export function cmdListLocalProviders(apps: string): void {
  const rows = listRemovableProviders(apps);
  if (!rows.length) {
    console.log(t("list.localNone"));
    return;
  }
  for (const row of rows) console.log(`${row.app!.padEnd(12)} ${row.id}${row.name && row.name !== row.id ? ` · ${row.name}` : ""}`);
}
