import path from "node:path";
import { home, readJsonIfExists, writeFileAtomic } from "./fsutil.js";
import type { Provider, Store } from "./types.js";

export const configDir = path.join(home, ".config", "smart-switch");
export const configFile = path.join(configDir, "config.json");

export function loadStore(): Store {
  const store = readJsonIfExists<Store>(configFile);
  if (!store) return { version: 1, providers: {} };
  if (!store.providers) store.providers = {};
  return store;
}

export function saveStore(store: Store): void {
  writeFileAtomic(configFile, JSON.stringify(store, null, 2) + "\n", 0o600);
}

export function getProvider(store: Store, id: string): Provider {
  const p = store.providers[id];
  if (!p) {
    const known = Object.keys(store.providers);
    throw new Error(
      `unknown provider "${id}"${known.length ? ` (known: ${known.join(", ")})` : " (none configured; run: smart-switch add)"}`,
    );
  }
  return p;
}
