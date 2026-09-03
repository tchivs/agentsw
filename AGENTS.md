# Repository Guidelines

## Project Overview

`agentsw` is a CLI tool that manages OpenAI/Anthropic-protocol model providers in a single config store and syncs them — with models.dev metadata — into multiple AI coding assistant CLIs (Claude Code, Codex, omp, pi, prime-agent, opencode, Hermes, WorkBuddy, DeepSeek Harness). It provides interactive and scripted workflows for adding providers, discovering models, switching active providers, and installing/upgrading agent CLIs.

## Architecture & Data Flow

```
User → index.ts (Commander) → commands.ts (cmd*) → store.ts (load/save config.json)
                                         ↓                    ↑
                                   discover.ts (/v1/models)   │
                                   modelsdev.ts (catalog)     │
                                   filter.ts (model filter)   │
                                         ↓                    │
                                   Build Provider object ─────┘
                                         ↓
                                   targets/*.ts (apply/prune to app configs)
```

**Core flow**: Every command loads the store fresh (`loadStore()`), performs its action, and saves via `saveStore()` (atomic write, mode 0600). Provider objects are the central domain model — they carry protocol, endpoint, API key, model list with metadata, and filter preferences. Target adapters translate a Provider into each app's native config format.

**Quick-add flow**: `cmdQuickAdd` → `probeProtocols()` (tries `/v1/models` with both Bearer and x-api-key headers) → `discoverProviderModels()` per protocol → `enrichModels()` from models.dev → save provider(s) with `-openai`/`-anthropic` suffixes if both protocols work.

**Import flow**: `scanCandidates()` iterates all targets' `.candidates()` + cc-switch SQLite → `mergeCandidates()` dedupes by `protocol|normalizedUrl` (treats `host` and `host/v1` as same) → interactive multiselect → save to store.

## Key Directories

| Directory | Purpose |
|-----------|---------|
| `src/` | All TypeScript source — entry point, commands, store, i18n, discovery, models.dev, filesystem utils |
| `src/targets/` | Per-app adapters: `claude.ts`, `codex.ts`, `omp.ts`, `pi.ts`, `prime.ts`, `opencode.ts`, `hermes.ts`, `workbuddy.ts`, `dsh.ts`, `wire.ts` (shared wire helpers), `types.ts` (TargetApp interface) |
| `src/sources/` | External config importers: `ccswitch.ts` (cc-switch SQLite reader) |
| `test/` | Node.js built-in test runner — `targets.test.ts` (15 tests), `import.test.ts` (4 tests), `apps.test.ts` (2 tests), `filter.test.ts` (7 tests), `i18n.test.ts` (3 tests) |
| `dist/` | Compiled output (gitignored) |
| `.github/workflows/` | `ci.yml` (matrix test + smoke), `release.yml` (npm OIDC publish on tag) |

## Development Commands

```bash
npm run build       # tsc -p tsconfig.json → dist/
npm run dev         # tsx src/index.ts (run without building)
npm test            # tsx --test test/*.test.ts
npm run typecheck   # tsc --noEmit (no output)
npx tsx src/index.ts <command>  # run any command directly
```

No linting or formatting tools are configured. No external test framework — uses Node.js built-in `node:test` + `node:assert/strict`.

## Code Conventions & Common Patterns

### Error Handling
- `fail(message): never` — universal fatal error helper in `commands.ts`: writes `pc.red('error: ...')` to stderr, calls `process.exit(1)`.
- `runShell(command)` — `execSync` with `stdio: 'inherit'` for install/upgrade commands; throws on nonzero exit.
- Target adapters wrapped in try/catch per-target in `runTargets()` — errors set `process.exitCode=1` but don't abort remaining targets.
- `scanCandidates()` silently skips unparseable configs (reported elsewhere by `status`/`apply`).

### Naming
- Command handlers: `cmdXxx` (e.g., `cmdAdd`, `cmdQuickAdd`, `cmdInstall`).
- Target adapters: lowercase app id (e.g., `claude`, `codex`, `dsh`).
- i18n keys: dot-separated `section.key` (e.g., `cmd.add`, `menu.quickAdd`, `add.autoDiscover`).
- Provider slug: derived from URL hostname via `slugFromBaseUrl()` — strips `api`/`www` labels, lowercases, replaces non-alphanumeric with `-`.

### Async Patterns
- Command handlers are `async` functions; Commander awaits them via `parseAsync()`.
- `loadStore()`/`saveStore()` are synchronous (JSON file I/O).
- Network calls (`discoverProviderModels`, `loadCatalog`, `latestVersion`) are async with timeouts.
- `execSync`/`execFileSync` used for version probes (15s timeout) and shell commands.

### State Management
- Store is a flat JSON file at `~/.config/agentsw/config.json` (or `%APPDATA%/agentsw/` on Windows). No database, no caching — loaded fresh each command.
- `AGENTSW_HOME` env var overrides entire home directory layout (used in tests and CI smoke tests).
- Dry-run mode: `setDryRun(true)` intercepts `writeFileAtomic()` to record intents instead of writing; `drainPendingWrites()` retrieves them for preview output.

### Target Adapter Pattern
Each adapter in `src/targets/` implements the `TargetApp` interface:
- `id`, `name`, `configPaths[]`, `protocols[]`
- `detect()` — checks if the app's config exists
- `current()` — reads which provider is active
- `apply(provider)` — writes provider config into the app's native format
- `prune(provider)` — removes provider entries
- `candidates()` — reads existing custom providers from app config for import
- `supportsProtocol(protocol)` — checks if adapter handles openai/anthropic

Adapters use `YAML` (omp, hermes, dsh), `smol-toml` (codex), or native `JSON` (claude, pi, prime, opencode, workbuddy) depending on the app's config format. The `wire.ts` module provides shared helpers: `classifyApi`, `apiValue`, `entryApi`, `mergeModels`, `stripConflictingOverrides`.

### i18n
- ~90 message keys in a flat `messages` object (`src/i18n.ts`), each with `en` and `zh-CN` variants.
- `t(key, vars?)` — looks up message, replaces `{placeholder}` tokens via `replaceAll`.
- Locale precedence: CLI `--lang` > `$AGENTSW_LANG` > `store.language` > system locale (`LC_ALL` > `LC_MESSAGES` > `LANG` > `Intl` > `en`).

## Important Files

| File | Purpose |
|------|---------|
| `src/index.ts` | CLI entry point (`#!/usr/bin/env node`); Commander program, locale init, command registration |
| `src/commands.ts` | All command handlers + shared helpers (`fail`, `table`, `createProvider`, `runTargets`) |
| `src/types.ts` | Core types: `Protocol`, `Provider`, `ModelSpec`, `Store`, `ApplyResult`, `Locale` |
| `src/store.ts` | Config store load/save (`~/.config/agentsw/config.json`, mode 0600) |
| `src/apps.ts` | App catalog (9 apps), version detection, install/upgrade commands |
| `src/discover.ts` | Model discovery from `/v1/models`, protocol probing (`probeProtocols`) |
| `src/modelsdev.ts` | models.dev catalog fetch/cache (24h TTL), `enrichModels()`, `searchCatalog()` |
| `src/menu.ts` | Interactive TUI menu (prompts-based), dispatches to command handlers |
| `src/i18n.ts` | Bilingual messages (en/zh-CN), locale detection/normalization |
| `src/fsutil.ts` | Atomic writes, dry-run, backups, platform-aware paths (`appDataDir`, `localAppDataDir`) |
| `src/import.ts` | Provider import/merge pipeline, `scanCandidates()`, `mergeCandidates()` |
| `src/slug.ts` | `slugFromBaseUrl()` — URL hostname → provider slug |
| `src/targets/wire.ts` | Shared wire helpers for OpenAI/Anthropic protocol classification |
| `src/targets/types.ts` | `TargetApp` and `ProviderCandidate` interfaces |
| `src/sources/ccswitch.ts` | cc-switch SQLite importer (read-only, 3 shape parsers) |
| `test/targets.test.ts` | Largest test file — apply/prune roundtrips for all 9 adapters |
| `test/filter.test.ts` | Model filter semantics (dedup, include/exclude globs, pinned ids) |

## Runtime/Tooling Preferences

- **Runtime**: Node.js >= 22.12.0 (required, enforced via `engines`). CI tests on Node 22 and 24.
- **Package manager**: npm (no pnpm/yarn.lock committed). `npm ci` in CI.
- **TypeScript**: ESM (`"type": "module"`), target ES2022, `NodeNext` module resolution, `strict: true`, `noUncheckedIndexedAccess: true`.
- **No linting/formatting tools** — no eslint, prettier, or editorconfig.
- **Publishing**: OIDC trusted publishing (no `NPM_TOKEN`). Tag `v*` triggers `release.yml` → `npm publish --access public` + GitHub Release with CHANGELOG body.
- **Binary names**: `agentsw` and `asw` both point to `dist/index.js`.

## Testing & QA

- **Framework**: Node.js built-in `node:test` runner via `tsx --test test/*.test.ts`.
- **Assertions**: `node:assert/strict`.
- **32 tests** across 5 files, all pass in <1s.
- **Sandbox pattern**: Tests use `AGENTSW_HOME` env var or `os.tmpdir()` to isolate config writes. No real network calls — model metadata is mocked or hardcoded.
- **CI matrix**: Ubuntu + macOS (Node 22, 24), Windows (Node 22). Smoke test in CI: `add` → `use` → `status` → `prune` across pi/omp/opencode with sandbox HOME.
- **Windows note**: File permission assertions (`mode & 0o077 === 0`) are skipped on win32 (NTFS doesn't honor Unix chmod bits).
- **Coverage**: No coverage tool configured. Tests focus on adapter roundtrips, filter semantics, import dedup, i18n, and app command resolution.
