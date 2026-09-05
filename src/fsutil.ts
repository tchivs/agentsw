import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { FileChange } from "./config-transaction.js";

// AGENTSW_HOME is an explicit portable/test override. Native Windows otherwise
// uses USERPROFILE/os.homedir(), while Unix follows HOME as expected.
export const home = process.env.AGENTSW_HOME?.trim() ||
  (process.platform === "win32" ? process.env.USERPROFILE?.trim() || os.homedir() : process.env.HOME?.trim() || os.homedir());

/** Windows roaming application data; Unix keeps the existing XDG-style layout. */
export function appDataDir(app: string): string {
  // AGENTSW_HOME is also a portable-layout override for tests and Git Bash.
  if (process.platform === "win32" && !process.env.AGENTSW_HOME) {
    return path.join(process.env.APPDATA?.trim() || path.join(home, "AppData", "Roaming"), app);
  }
  return path.join(home, ".config", app);
}

/** Windows local application data, used by agents whose native config lives there. */
export function localAppDataDir(app: string): string {
  if (process.platform === "win32" && !process.env.AGENTSW_HOME) {
    return path.join(process.env.LOCALAPPDATA?.trim() || path.join(home, "AppData", "Local"), app);
  }
  return path.join(home, `.${app}`);
}

export function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(home, p.slice(1)) : p;
}

export function ensureDir(dir: string): void {
  if (isDryRun() || stagedFiles.getStore()) return;
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export interface FileSnapshot {
  text: string | undefined;
  mode?: number;
  identity?: string;
}

/** Read exactly one regular file. A broken path or unreadable file is not an empty config. */
export function readFileSnapshot(file: string): FileSnapshot {
  try {
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile()) throw new Error(`${file}: not a regular configuration file`);
    return { text: fs.readFileSync(file, "utf8"), mode: Number(stat.mode & 0o777n), identity: `${stat.dev}:${stat.ino}` };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { text: undefined };
    throw new Error(`${file}: cannot read a regular configuration file`);
  }
}

interface StagedFiles {
  reads: Map<string, FileSnapshot>;
  writes: Map<string, FileChange>;
  dryRun: boolean;
  closed: boolean;
}

const stagedFiles = new AsyncLocalStorage<StagedFiles>();

function stagedSnapshot(scope: StagedFiles, file: string): FileSnapshot {
  if (scope.closed) throw new Error("configuration transaction already finished");
  let snapshot = scope.reads.get(file);
  if (!snapshot) {
    snapshot = readFileSnapshot(file);
    scope.reads.set(file, snapshot);
  }
  return snapshot;
}

/** Scope only this asynchronous adapter invocation, never unrelated filesystem calls. */
export async function stageFileWrites<T>(operation: () => Promise<T>): Promise<{
  result: T;
  changes: FileChange[];
  reads: Map<string, FileSnapshot>;
  dryRun: boolean;
}> {
  if (stagedFiles.getStore()) throw new Error("nested configuration transaction is not supported");
  const scope: StagedFiles = { reads: new Map(), writes: new Map(), dryRun, closed: false };
  try {
    const result = await stagedFiles.run(scope, operation);
    return { result, changes: [...scope.writes.values()], reads: scope.reads, dryRun: scope.dryRun };
  } finally {
    scope.closed = true;
  }
}

export function readTextIfExists(file: string): string | undefined {
  const scope = stagedFiles.getStore();
  if (scope) {
    file = path.resolve(file);
    const snapshot = stagedSnapshot(scope, file);
    return scope.writes.has(file) ? scope.writes.get(file)!.after : snapshot.text;
  }
  try {
    return fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export function readJsonIfExists<T = unknown>(file: string): T | undefined {
  const text = readTextIfExists(file);
  if (text === undefined) return undefined;
  return JSON.parse(text) as T;
}

/** Compatibility preview switch. Each target captures its value when its scoped work starts. */
let dryRun = false;
const pendingWrites: Array<{ file: string; content: string }> = [];

export function isDryRun(): boolean {
  return stagedFiles.getStore()?.dryRun ?? dryRun;
}

export function setDryRun(on: boolean): void {
  dryRun = on;
  pendingWrites.length = 0;
}

export function drainPendingWrites(): Array<{ file: string; content: string }> {
  return pendingWrites.splice(0);
}

/** Publish previews only after the adapter has validated all of its input files. */
export function recordPendingWrites(changes: FileChange[]): void {
  for (const change of changes) {
    if (change.before !== change.after && change.after !== undefined) {
      pendingWrites.push({ file: change.file, content: change.after });
    }
  }
}

/** Atomic replacement, preserving existing permissions and defaulting new secret files to 0600. */
export function writeFileAtomic(file: string, content: string, mode?: number): void {
  const scope = stagedFiles.getStore();
  if (scope) {
    file = path.resolve(file);
    const expected = stagedSnapshot(scope, file);
    scope.writes.set(file, { file, before: expected.text, after: content, mode, expected });
    return;
  }
  if (dryRun) {
    pendingWrites.push({ file, content });
    return;
  }
  const existing = readFileSnapshot(file);
  const permissions = mode ?? existing.mode ?? 0o600;
  if (!Number.isInteger(permissions) || permissions < 0 || permissions > 0o777) {
    throw new Error(`${file}: invalid file permissions`);
  }
  ensureDir(path.dirname(file));
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.agentsw-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tmp, content, { flag: "wx", mode: permissions });
    fs.chmodSync(tmp, permissions);
    fs.renameSync(tmp, file);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export const backupsDir = path.join(appDataDir("agentsw"), "backups");

/** Each original gets a private, unique directory even for equal basenames and timestamps. */
export function backupFile(file: string): string | undefined {
  const scope = stagedFiles.getStore();
  if (scope) {
    stagedSnapshot(scope, path.resolve(file));
    return undefined;
  }
  if (dryRun) return undefined;
  const snapshot = readFileSnapshot(file);
  if (snapshot.text === undefined) return undefined;
  fs.mkdirSync(backupsDir, { recursive: true, mode: 0o700 });
  const dir = fs.mkdtempSync(path.join(backupsDir, "file-"));
  const dest = path.join(dir, path.basename(file));
  try {
    fs.chmodSync(dir, 0o700);
    fs.copyFileSync(file, dest, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(dest, 0o600);
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
  return dest;
}
