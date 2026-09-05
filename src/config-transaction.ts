import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { appDataDir, backupsDir, isDryRun, readFileSnapshot } from "./fsutil.js";
import type { FileSnapshot } from "./fsutil.js";

export interface FileChange {
  file: string;
  before: string | undefined;
  after: string | undefined;
  mode?: number;
  /** When available, validate the original identity and permissions as well as its contents. */
  expected?: FileSnapshot;
}

function sameSnapshot(actual: FileSnapshot, expected: FileSnapshot): boolean {
  return actual.text === expected.text && actual.mode === expected.mode && actual.identity === expected.identity;
}

function assertSnapshot(file: string, expected: FileSnapshot): void {
  if (!sameSnapshot(readFileSnapshot(file), expected)) {
    throw new Error(`${file}: configuration changed since it was read`);
  }
}

function atomicWrite(file: string, text: string, mode: number): FileSnapshot {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.agentsw-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, text, { flag: "wx", mode });
    fs.chmodSync(temp, mode);
    const stat = fs.lstatSync(temp);
    fs.renameSync(temp, file);
    return { text, mode: stat.mode & 0o777, identity: `${stat.dev}:${stat.ino}` };
  } finally {
    fs.rmSync(temp, { force: true });
  }
}

// Store saves and all adapter/management commits share this cross-process lock.
// It covers synchronous validation/commit only, never discovery or network waits.
const lockFile = path.join(appDataDir("agentsw"), ".write.lock");

function writeLockBusyError(): Error {
  let owner: { pid: number; createdAt: string } | undefined;
  try {
    const stat = fs.lstatSync(lockFile);
    if (stat.isFile() && stat.size <= 4096) {
      const value: unknown = JSON.parse(fs.readFileSync(lockFile, "utf8"));
      if (value && typeof value === "object" && "pid" in value && "createdAt" in value &&
        typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0 && value.pid <= 0x7fffffff &&
        typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt))) {
        owner = { pid: value.pid, createdAt: new Date(value.createdAt).toISOString() };
      }
    }
  } catch { /* An empty, unreadable, or initializing lock is not evidence that its owner exited. */ }

  let status = "owner metadata is missing or unreadable; the lock may still be initializing";
  if (owner) {
    status = `owner PID ${owner.pid}, created ${owner.createdAt}; process status could not be determined`;
    try {
      process.kill(owner.pid, 0);
      return new Error(`${lockFile}: configuration write busy; owner PID ${owner.pid} is running on this host (created ${owner.createdAt}); wait for it to finish; do not remove an active lock`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") {
        status = `owner PID ${owner.pid} is no longer running on this host (created ${owner.createdAt}); a previous writer may have crashed`;
      }
    }
  }
  // No timeout-based or automatic unlink: PID reuse, shared homes, and initializing writers
  // make even an apparently abandoned lock unsafe to steal while other writers can start.
  return new Error(`${lockFile}: configuration write busy; ${status}; recovery: stop all agentsw writers, confirm this lock is abandoned, then manually remove ${lockFile} and retry; never remove a lock held by an active writer`);
}

function withWriteLock<T>(operation: () => T): T {
  fs.mkdirSync(path.dirname(lockFile), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = fs.openSync(lockFile, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw writeLockBusyError();
    }
    throw new Error(`${lockFile}: cannot acquire configuration write lock`);
  }
  try {
    const owned = fs.fstatSync(fd);
    try {
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }) + "\n");
      } catch {
        throw new Error(`${lockFile}: cannot record configuration write lock owner`);
      }
      return operation();
    } finally {
      // Keep the descriptor open while checking ownership, preventing inode reuse.
      // A replaced lock belongs to somebody else; never remove it on their behalf.
      try {
        const current = fs.lstatSync(lockFile);
        if (current.dev === owned.dev && current.ino === owned.ino) fs.unlinkSync(lockFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  } finally {
    fs.closeSync(fd);
  }
}

/** Validate the entire plan and save every original before mutating any configuration. */
export function commitFileChanges(
  changes: FileChange[],
  opts: { dryRun?: boolean; reads?: ReadonlyMap<string, FileSnapshot> } = {},
): { files: string[]; backupDir?: string } {
  const paths = new Set<string>();
  const identities = new Set<string>();
  const reads = new Map(opts.reads);
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
    const current = readFileSnapshot(file);
    if (current.identity && identities.has(current.identity)) throw new Error(`${file}: duplicate file plan`);
    if (current.identity) identities.add(current.identity);
    if (current.text !== change.before || (change.expected && !sameSnapshot(current, change.expected))) {
      throw new Error(`${file}: configuration changed since it was read`);
    }
    if (change.mode !== undefined && (!Number.isInteger(change.mode) || change.mode < 0 || change.mode > 0o777)) {
      throw new Error(`${file}: invalid file permissions`);
    }
    if (!reads.has(file)) reads.set(file, change.expected ?? current);
    return { ...change, file, original: current };
  }).filter((change) => change.before !== change.after || (change.original.text !== undefined && change.mode !== undefined && change.mode !== change.original.mode));
  const validateReads = (): void => {
    for (const [file, expected] of reads) assertSnapshot(file, expected);
  };
  validateReads();
  const files = plan.map((change) => change.file);
  if (!plan.length || (opts.dryRun ?? isDryRun())) return { files };

  return withWriteLock(() => {
    // Another writer may have committed between planning and acquiring the lock.
    validateReads();
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
        mode: change.original.mode,
      })), null, 2) + "\n", { flag: "wx", mode: 0o600 });
      fs.chmodSync(path.join(backupDir, "manifest.json"), 0o600);
      validateReads();
    } catch {
      throw new Error(`${currentFile}: backup or pre-write validation failed; configuration files were not changed`);
    }

    const applied: Array<{ change: (typeof plan)[number]; written: FileSnapshot }> = [];
    const createdDirectories: string[] = [];
    try {
      for (const change of plan) {
        currentFile = change.file;
        assertSnapshot(change.file, change.original);
        let written: FileSnapshot;
        if (change.after === undefined) {
          fs.unlinkSync(change.file);
          written = { text: undefined };
        }
        else {
          const missing: string[] = [];
          for (let dir = path.dirname(change.file); !fs.existsSync(dir); dir = path.dirname(dir)) missing.push(dir);
          for (const dir of missing.reverse()) {
            fs.mkdirSync(dir, { mode: 0o700 });
            createdDirectories.push(dir);
          }
          written = atomicWrite(change.file, change.after, change.mode ?? change.original.mode ?? 0o600);
        }
        applied.push({ change, written });
        reads.set(change.file, written);
      }
      validateReads();
    } catch {
      const failed: string[] = [];
      for (const { change, written } of applied.reverse()) {
        try {
          // Do not overwrite a third party's intervening edit while rolling back.
          assertSnapshot(change.file, written);
          if (change.before === undefined) fs.unlinkSync(change.file);
          else atomicWrite(change.file, change.before, change.original.mode ?? 0o600);
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
  });
}
