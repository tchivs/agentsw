/** Derive a provider-id slug from a base URL host, for apps whose config carries no provider name. */
export function slugFromBaseUrl(baseUrl: string): string {
  let host = "";
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return "imported";
  }
  const labels = host.split(".").filter((l) => l && !["api", "www"].includes(l.toLowerCase()));
  const first = labels.find((l) => /[a-z]/i.test(l)) ?? labels[0] ?? host;
  const slug = first.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "");
  return /^[a-z0-9]/.test(slug) ? slug : "imported";
}

/** True for bare UPPER_SNAKE names that apps may treat as env-var references (omp, prime). */
export function looksLikeEnvName(v: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(v);
}
