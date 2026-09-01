import type { Protocol } from "../types.js";
import type { TargetApp } from "./types.js";
import { claudecode } from "./claudecode.js";
import { dsh } from "./dsh.js";
import { codex } from "./codex.js";
import { omp } from "./omp.js";
import { opencode } from "./opencode.js";
import { hermes } from "./hermes.js";
import { pi, prime } from "./pistyle.js";
import { workbuddy } from "./workbuddy.js";

export const targets: TargetApp[] = [claudecode, codex, omp, pi, prime, opencode, hermes, workbuddy, dsh];

export function resolveTargets(filter?: string): TargetApp[] {
  if (!filter || filter === "all") return targets;
  const wanted = filter.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const out: TargetApp[] = [];
  for (const w of wanted) {
    const hit = targets.find((t) => t.id === w || t.name.toLowerCase() === w);
    if (!hit) {
      throw new Error(`unknown app "${w}" (supported: ${targets.map((t) => t.id).join(", ")})`);
    }
    out.push(hit);
  }
  return out;
}

export function supportsProtocol(target: TargetApp, protocol: Protocol): boolean {
  return target.protocols.includes(protocol);
}
