import { createHash } from "node:crypto";
import type { ProviderCandidate } from "./targets/types.js";

/** Previous releases used this lossy encoding; recognize it, never generate it. */
export function legacyManagedCredentialRef(id: string): string {
  return `AGENTSW_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
}

/** Human-readable prefix plus an exact, case-sensitive provider identity digest. */
export function managedCredentialRef(id: string): string {
  const prefix = id.toUpperCase().replace(/[^A-Z0-9]/g, "_").slice(0, 48) || "PROVIDER";
  const digest = createHash("sha256").update(id).digest("hex").slice(0, 24).toUpperCase();
  return `AGENTSW_${prefix}_${digest}_API_KEY`;
}

export function isManagedCredentialRef(ref: string, id: string): boolean {
  return ref === managedCredentialRef(id) || ref === legacyManagedCredentialRef(id);
}

/** Account-qualified app-local selector; never embeds endpoints or credentials. */
export function localProviderId(candidate: Pick<ProviderCandidate, "id" | "protocol" | "baseUrl" | "apiKey" | "keyEnv">): string {
  const identity = JSON.stringify([
    candidate.id,
    candidate.protocol,
    candidate.baseUrl,
    candidate.apiKey ?? null,
    candidate.keyEnv ?? null,
  ]);
  return `local-${createHash("sha256").update(identity).digest("hex").slice(0, 32)}`;
}
