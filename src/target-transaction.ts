import { commitFileChanges } from "./config-transaction.js";
import { recordPendingWrites, stageFileWrites } from "./fsutil.js";
import type { ApplyResult, Provider } from "./types.js";
import type { TargetApp } from "./targets/types.js";

const wrappedTargets = new WeakSet<TargetApp>();

/** Validate every adapter input before committing any of its configuration writes. */
export function transactionalTarget(target: TargetApp): TargetApp {
  if (wrappedTargets.has(target)) return target;
  const wrapped = Object.create(Object.getPrototypeOf(target), Object.getOwnPropertyDescriptors(target)) as TargetApp;
  for (const method of ["apply", "prune"] as const) {
    const operation = target[method];
    wrapped[method] = async function (this: TargetApp, provider: Provider): Promise<ApplyResult> {
      const staged = await stageFileWrites(() => operation.call(this, provider));
      const committed = commitFileChanges(staged.changes, { dryRun: staged.dryRun, reads: staged.reads });
      if (staged.dryRun) recordPendingWrites(staged.changes);
      return {
        ...staged.result,
        changed: committed.files,
        notes: committed.backupDir ? [...staged.result.notes, `backup: ${committed.backupDir}`] : staged.result.notes,
      };
    };
  }
  wrappedTargets.add(wrapped);
  return wrapped;
}
