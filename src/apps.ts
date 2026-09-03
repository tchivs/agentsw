import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { appDataDir, home, readJsonIfExists } from "./fsutil.js";

export interface AppPackage {
  id: string;
  name: string;
  /** binary probed for the installed version; undefined = not CLI-managed */
  binary?: string;
  versionArgs?: string[];
  /** where the latest version is looked up */
  latest?: { kind: "npm" | "pypi" | "brew" | "github"; name: string };
  /** shell command that installs the app */
  installCmd?: string;
  /** shell command that upgrades it (defaults to installCmd) */
  upgradeCmd?: string;
  /** native Windows installer; absent means this app is not installable on Windows */
  windowsInstallCmd?: string;
  /** native Windows upgrader; defaults to windowsInstallCmd */
  windowsUpgradeCmd?: string;
  /** fallback local version probe for non-CLI apps */
  localVersion?: () => string | undefined;
}

export const appPackages: AppPackage[] = [
  {
    id: "claude",
    name: "Claude Code",
    binary: "claude",
    latest: { kind: "npm", name: "@anthropic-ai/claude-code" },
    installCmd: "curl -fsSL https://claude.ai/install.sh | bash",
    upgradeCmd: "claude update",
    windowsInstallCmd: "npm install -g @anthropic-ai/claude-code@latest",
  },
  {
    id: "codex",
    name: "Codex CLI",
    binary: "codex",
    latest: { kind: "npm", name: "@openai/codex" },
    installCmd: "npm install -g @openai/codex@latest",
    windowsInstallCmd: "npm install -g @openai/codex@latest",
  },
  {
    id: "omp",
    name: "Oh My Pi",
    binary: "omp",
    latest: { kind: "brew", name: "omp" },
    installCmd: "brew install omp",
    upgradeCmd: "brew upgrade omp",
  },
  {
    id: "pi",
    name: "pi",
    binary: "pi",
    latest: { kind: "npm", name: "@earendil-works/pi-coding-agent" },
    installCmd: "npm install -g @earendil-works/pi-coding-agent@latest",
    windowsInstallCmd: "npm install -g @earendil-works/pi-coding-agent@latest",
  },
  {
    id: "prime",
    name: "prime-agent",
    binary: "prime-agent",
    latest: { kind: "github", name: "PrimeIntellect-ai/prime-agent" },
    installCmd: "curl -fsSL https://raw.githubusercontent.com/PrimeIntellect-ai/prime-agent/main/install.sh | bash",
  },
  {
    id: "opencode",
    name: "opencode",
    binary: "opencode",
    latest: { kind: "npm", name: "opencode-ai" },
    installCmd: "curl -fsSL https://opencode.ai/install | bash",
    upgradeCmd: "opencode upgrade",
    windowsInstallCmd: "npm install -g opencode-ai@latest",
  },
  {
    id: "hermes",
    name: "Hermes",
    binary: "hermes",
    latest: { kind: "pypi", name: "hermes-agent" },
    installCmd: "uv tool install hermes-agent || pipx install hermes-agent",
    upgradeCmd: "uv tool upgrade hermes-agent || pipx upgrade hermes-agent",
    windowsInstallCmd: "uv tool install hermes-agent || pipx install hermes-agent",
    windowsUpgradeCmd: "uv tool upgrade hermes-agent || pipx upgrade hermes-agent",
  },
  {
    id: "workbuddy",
    name: "WorkBuddy",
    // Electron desktop app: version from its data dir; managed by its own updater.
    localVersion: () => {
      const dir = workbuddyDataDir();
      const j = readJsonIfExists<Record<string, unknown>>(path.join(dir, "last-launch.json"));
      const v = (j?.version ?? j?.appVersion) as string | undefined;
      if (v) return v;
      const r = readJsonIfExists<Record<string, unknown>>(
        path.join(dir, "app", "renderer-version.json"),
      );
      return (r?.version as string | undefined) ?? undefined;
    },
  },
  {
    id: "dsh",
    name: "DeepSeek Harness",
    // dsh has no global binary — it runs via `npx @deepseek-ai/dsh web`.
    // Detect via npx cache or ~/.dsh config dir.
    latest: { kind: "npm", name: "@deepseek-ai/dsh" },
    installCmd: "npm install -g @deepseek-ai/dsh@latest",
    upgradeCmd: "npm install -g @deepseek-ai/dsh@latest",
    windowsInstallCmd: "npm install -g @deepseek-ai/dsh@latest",
    localVersion: () => dshLocalVersion(),
  },
];

// dsh config dir; respects $DSH_HOME.
function dshHome(): string {
  const env = process.env.DSH_HOME?.trim();
  return env ? (env.startsWith("~") ? path.join(home, env.slice(1)) : env) :
    process.platform === "win32" ? path.join(home, "AppData", "Local", "dsh") : path.join(home, ".dsh");
}

/** dsh version: search npx cache for @deepseek-ai/dsh, fall back to "?" if config dir exists. */
function dshLocalVersion(): string | undefined {
  // 1. Check npx cache (~/.npm/_npx/*/node_modules/@deepseek-ai/dsh/package.json)
  const npxCache = path.join(home, ".npm", "_npx");
  if (fs.existsSync(npxCache)) {
    for (const dir of fs.readdirSync(npxCache)) {
      const pkg = path.join(npxCache, dir, "node_modules", "@deepseek-ai", "dsh", "package.json");
      if (fs.existsSync(pkg)) {
        try {
          const v = JSON.parse(fs.readFileSync(pkg, "utf8")).version;
          if (v) return v as string;
        } catch { /* ignore */ }
      }
    }
  }
  // 2. Check global npm install
  try {
    const out = execSync("npm ls -g @deepseek-ai/dsh --json --depth=0", {
      encoding: "utf8", timeout: 10000, stdio: ["ignore", "pipe", "pipe"],
    });
    const parsed = JSON.parse(out);
    const v = parsed?.dependencies?.["@deepseek-ai/dsh"]?.version;
    if (v) return v as string;
  } catch { /* not installed globally */ }
  // 3. Config dir exists -> used via npx, version unknown
  if (fs.existsSync(dshHome())) return "?";
  return undefined;
}

function workbuddyDataDir(): string {
  return process.env.WORKBUDDY_CONFIG_DIR?.trim() || process.env.CODEBUDDY_CONFIG_DIR?.trim() ||
    (process.platform === "win32" ? appDataDir("workbuddy") : path.join(home, ".workbuddy"));
}

const SEMVERISH = /\d+\.\d+(\.\d+)?([-.+][\w.-]+)?/;

export function installedVersion(app: AppPackage): string | undefined {
  if (app.binary) {
    try {
      const binary = executableName(app.binary);
      const out = execFileSync(binary, app.versionArgs ?? ["--version"], {
        encoding: "utf8",
        timeout: 15000,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return SEMVERISH.exec(out)?.[0];
    } catch {
      // binary present but probe failed (e.g. runtime version gate) -> installed, version unknown
      if (binaryOnPath(app.binary)) return "?";
      return app.localVersion?.();
    }
  }
  return app.localVersion?.();
}

async function fetchJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

export async function latestVersion(app: AppPackage): Promise<string | undefined> {
  const src = app.latest;
  if (!src) return undefined;
  try {
    switch (src.kind) {
      case "npm": {
        const data = (await fetchJson(`https://registry.npmjs.org/${src.name}/latest`)) as { version?: string };
        return data.version;
      }
      case "pypi": {
        const data = (await fetchJson(`https://pypi.org/pypi/${src.name}/json`)) as { info?: { version?: string } };
        return data.info?.version;
      }
      case "github": {
        const data = (await fetchJson(`https://api.github.com/repos/${src.name}/releases/latest`, {
          "user-agent": "agentsw",
        })) as { tag_name?: string };
        return data.tag_name ? (SEMVERISH.exec(data.tag_name)?.[0] ?? data.tag_name) : undefined;
      }
      case "brew": {
        // Local tap metadata first (works for taps; refreshed by `brew update`), then core API.
        try {
          const out = execSync(`brew info --json=v2 ${src.name}`, { encoding: "utf8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] });
          const data = JSON.parse(out) as { formulae?: Array<{ versions?: { stable?: string } }> };
          const stable = data.formulae?.[0]?.versions?.stable;
          if (stable) return stable;
        } catch {
          /* brew missing or formula unknown locally */
        }
        const data = (await fetchJson(`https://formulae.brew.sh/api/formula/${src.name}.json`)) as {
          versions?: { stable?: string };
        };
        return data.versions?.stable;
      }
    }
  } catch {
    return undefined;
  }
}

/** numeric-aware semver-ish comparison; true when b is newer than a */
export function isNewer(installed: string, latest: string): boolean {
  const pa = installed.split(/[.+-]/).map(Number);
  const pb = latest.split(/[.+-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const a = pa[i] ?? 0;
    const b = pb[i] ?? 0;
    if (Number.isNaN(a) || Number.isNaN(b)) break;
    if (b > a) return true;
    if (b < a) return false;
  }
  return false;
}

/** Run an install/upgrade command with live output. Throws on nonzero exit. */
export function runShell(command: string): void {
  execSync(command, { stdio: "inherit", env: process.env });
}

/** Resolve the platform-specific command while keeping the package table readable. */
export function appCommand(app: AppPackage, action: "install" | "upgrade", platform: NodeJS.Platform = process.platform): string | undefined {
  if (platform === "win32") return action === "install" ? app.windowsInstallCmd : app.windowsUpgradeCmd ?? app.windowsInstallCmd;
  return action === "install" ? app.installCmd : app.upgradeCmd ?? app.installCmd;
}

function executableName(binary: string): string {
  if (process.platform !== "win32") return binary;
  for (const suffix of ["", ".cmd", ".exe", ".bat"]) {
    const candidate = `${binary}${suffix}`;
    if (binaryOnPath(candidate)) return candidate;
  }
  return binary;
}

export function binaryOnPath(binary: string): boolean {
  const dirs = (process.env.PATH ?? "").split(path.delimiter);
  return dirs.some((d) => {
    try {
      const names = process.platform === "win32" && !path.extname(binary)
        ? [binary, ...((process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").map((s) => `${binary}${s.toLowerCase()}`))]
        : [binary];
      return names.some((name) => {
        try {
          fs.accessSync(path.join(d, name), process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK);
          return true;
        } catch {
          return false;
        }
      });
    } catch {
      return false;
    }
  });
}
