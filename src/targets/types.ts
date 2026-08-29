import type { ApplyResult, Protocol, Provider } from "../types.js";

export interface TargetApp {
  /** app slug used in --apps filters */
  id: string;
  name: string;
  /** wire protocols this app can consume */
  protocols: Protocol[];
  /** primary config file(s) this adapter writes */
  configPaths: string[];
  /** true when the app appears installed (config dir exists) */
  detect(): boolean;
  /** write the provider into the app's config; must preserve unrelated settings */
  apply(provider: Provider): Promise<ApplyResult>;
  /** remove this provider's entries from the app's config; must not touch unrelated settings */
  prune(provider: Provider): Promise<ApplyResult>;
  current(): string | undefined;
}
