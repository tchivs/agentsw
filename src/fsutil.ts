import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const home = os.homedir();

export function expandHome(p: string): string {
  return p.startsWith("~") ? path.join(home, p.slice(1)) : p;
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function readTextIfExists(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

export function readJsonIfExists<T = unknown>(file: string): T | undefined {
  const text = readTextIfExists(file);
  if (text === undefined) return undefined;
  return JSON.parse(text) as T;
}


/** dry-run mode: writeFileAtomic records intents instead of touching disk; backups are skipped */
let dryRun = false;
const pendingWrites: Array<{ file: string; content: string }> = [];

export function setDryRun(on: boolean): void {
  dryRun = on;
  pendingWrites.length = 0;
}

export function drainPendingWrites(): Array<{ file: string; content: string }> {
  return pendingWrites.splice(0);
}

/** Atomic write: tmp file + rename. Creates parent dirs. In dry-run mode, records the intent instead. */
export function writeFileAtomic(file: string, content: string, mode?: number): void {
  if (dryRun) {
    pendingWrites.push({ file, content });
    return;
  }
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, mode !== undefined ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

export const backupsDir = path.join(home, ".config", "agentsw", "backups");

/** Copy `file` into the backups dir with a timestamp suffix. No-op if file missing. */
export function backupFile(file: string): string | undefined {
  if (!fs.existsSync(file) || dryRun) return undefined;
  ensureDir(backupsDir);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(backupsDir, `${path.basename(file)}.${stamp}`);
  fs.copyFileSync(file, dest);
  return dest;
}
