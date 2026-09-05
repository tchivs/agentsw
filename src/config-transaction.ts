import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { backupsDir } from "./fsutil.js";

export interface FileChange {
  file: string;
  before: string | undefined;
  after: string | undefined;
  mode?: number;
}

function snapshot(file: string): { text: string | undefined; mode?: number; identity?: string } {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) throw new Error("not a regular file");
    return { text: fs.readFileSync(file, "utf8"), mode: stat.mode & 0o777, identity: `${stat.dev}:${stat.ino}` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: undefined };
    throw new Error(`${file}: cannot read a regular configuration file`);
  }
}

function atomicWrite(file: string, text: string, mode: number): void {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.agentsw-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, text, { flag: "wx", mode });
    fs.chmodSync(temp, mode);
    fs.renameSync(temp, file);
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

/** Validate the entire plan and save every original before mutating any configuration. */
export function commitFileChanges(
  changes: FileChange[],
  opts: { dryRun?: boolean } = {},
): { files: string[]; backupDir?: string } {
  const paths = new Set<string>();
  const identities = new Set<string>();
  const plan = changes.map((change) => {
    const file = path.resolve(change.file);
    // Resolve the parent too, so directory symlinks cannot disguise duplicate plans.
    let canonical = file;
    try {
      canonical = path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`${file}: cannot resolve configuration directory`);
      }
    }
    if (paths.has(canonical)) throw new Error(`${file}: duplicate file plan`);
    paths.add(canonical);
    const current = snapshot(file);
    if (current.identity && identities.has(current.identity)) throw new Error(`${file}: duplicate file plan`);
    if (current.identity) identities.add(current.identity);
    if (current.text !== change.before) throw new Error(`${file}: configuration changed since it was read`);
    if (change.mode !== undefined && (!Number.isInteger(change.mode) || change.mode < 0 || change.mode > 0o777)) {
      throw new Error(`${file}: invalid file permissions`);
    }
    return { ...change, file, originalMode: current.mode };
  }).filter((change) => change.before !== change.after);
  const files = plan.map((change) => change.file);
  if (!plan.length || opts.dryRun) return { files };

  let backupDir: string;
  let currentFile = backupsDir;
  try {
    fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
    backupDir = fs.mkdtempSync(path.join(backupsDir, "transaction-"));
    fs.chmodSync(backupDir, 0o700);
    for (const [index, change] of plan.entries()) {
      currentFile = change.file;
      if (change.before === undefined) continue;
      const backup = path.join(backupDir, `${index}-${path.basename(change.file)}`);
      fs.writeFileSync(backup, change.before, { flag: "wx", mode: 0o600 });
      fs.chmodSync(backup, 0o600);
    }
    fs.writeFileSync(path.join(backupDir, "manifest.json"), JSON.stringify(plan.map((change, index) => ({
      file: change.file,
      backup: change.before === undefined ? null : `${index}-${path.basename(change.file)}`,
      mode: change.originalMode,
    })), null, 2) + "\n", { flag: "wx", mode: 0o600 });
    for (const change of plan) {
      currentFile = change.file;
      if (snapshot(change.file).text !== change.before) throw new Error("stale snapshot");
    }
  } catch {
    throw new Error(`${currentFile}: backup or pre-write validation failed; configuration files were not changed`);
  }

  const applied: typeof plan = [];
  const createdDirectories: string[] = [];
  try {
    for (const change of plan) {
      currentFile = change.file;
      if (snapshot(change.file).text !== change.before) throw new Error("stale snapshot");
      if (change.after === undefined) fs.unlinkSync(change.file);
      else {
        const missing: string[] = [];
        for (let dir = path.dirname(change.file); !fs.existsSync(dir); dir = path.dirname(dir)) missing.push(dir);
        for (const dir of missing.reverse()) {
          fs.mkdirSync(dir, { mode: 0o700 });
          createdDirectories.push(dir);
        }
        atomicWrite(change.file, change.after, change.mode ?? change.originalMode ?? 0o600);
      }
      applied.push(change);
    }
  } catch {
    const failed: string[] = [];
    for (const change of applied.reverse()) {
      try {
        // Do not overwrite a third party's intervening edit while rolling back.
        if (snapshot(change.file).text !== change.after) throw new Error("stale rollback snapshot");
        if (change.before === undefined) fs.unlinkSync(change.file);
        else atomicWrite(change.file, change.before, change.originalMode ?? 0o600);
      } catch {
        failed.push(change.file);
      }
    }
    for (const dir of createdDirectories.reverse()) {
      try { fs.rmdirSync(dir); } catch { /* Only remove empty directories created by this transaction. */ }
    }
    throw new Error(`${currentFile}: configuration transaction failed; ${failed.length ? `rollback incomplete for ${failed.join(", ")}` : "previous writes rolled back"}; backups: ${backupDir}`);
  }
  return { files, backupDir };
}
