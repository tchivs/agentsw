import path from "node:path";
import { appDataDir, isDryRun, readFileSnapshot, recordPendingWrites } from "./fsutil.js";
import type { FileSnapshot } from "./fsutil.js";
import { commitFileChanges } from "./config-transaction.js";
import type { Provider, Store } from "./types.js";

export const configDir = appDataDir("agentsw");
export const configFile = path.join(configDir, "config.json");

const loadedSnapshots = new WeakMap<Store, FileSnapshot>();

export function loadStore(): Store {
  const snapshot = readFileSnapshot(configFile);
  let store: Store;
  if (snapshot.text === undefined) store = { version: 1, providers: {} };
  else {
    try {
      store = JSON.parse(snapshot.text) as Store;
    } catch {
      throw new Error(`${configFile}: invalid provider store JSON`);
    }
    if (!store || typeof store !== "object" || Array.isArray(store)) {
      throw new Error(`${configFile}: expected a provider store object`);
    }
    if (store.providers === undefined) store.providers = {};
    if (!store.providers || typeof store.providers !== "object" || Array.isArray(store.providers)) {
      throw new Error(`${configFile}: expected a providers object`);
    }
  }
  loadedSnapshots.set(store, snapshot);
  return store;
}

export function saveStore(store: Store): void {
  // A snapshot stays associated with this object across asynchronous discovery and repeated saves.
  const expected = loadedSnapshots.get(store) ?? readFileSnapshot(configFile);
  const after = JSON.stringify(store, null, 2) + "\n";
  const changes = [{ file: configFile, before: expected.text, after, mode: 0o600, expected }];
  const dryRun = isDryRun();
  commitFileChanges(changes, { dryRun });
  if (dryRun) {
    recordPendingWrites(changes);
    return;
  }
  const saved = readFileSnapshot(configFile);
  if (saved.text !== after) throw new Error(`${configFile}: configuration changed during store save`);
  loadedSnapshots.set(store, saved);
}

export function getProvider(store: Store, id: string): Provider {
  const p = store.providers[id];
  if (!p) {
    const known = Object.keys(store.providers);
    throw new Error(
      `unknown provider "${id}"${known.length ? ` (known: ${known.join(", ")})` : " (none configured; run: agentsw add)"}`,
    );
  }
  return p;
}
