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

**Core flow**: Every command loads the store fresh (`loadStore()`), performs its action, and saves via `saveStore()` (mode 0600, private backup, optimistic snapshot check and a short commit lock). A stale save must reject, never overwrite another command's work. Provider objects carry protocol, endpoint, key, models, metadata and filter preferences; target adapters translate them into app-native configuration.

**Quick-add flow**: `cmdQuickAdd` → `probeProtocols()` → paginated `discoverProviderModels()` per protocol → `enrichProviderModels()`. Automatic IDs use the full hostname plus protocol; repeated same-account onboarding preserves existing IDs, names, wire flavor, defaults and preferences unless explicitly overridden.

**Import flow**: `scanCandidates()` → `mergeCandidates()` dedupes by normalized endpoint, protocol, and credential identity. `ProviderCandidate.generatedId` distinguishes generated suggestions from explicit names; explicit names win for the same account. Different or unresolved credentials are not silently merged.

**Management flow**: `provider-actions.ts` handles CLI/menu output; `rename.ts` and `remove.ts` plan changes; `config-transaction.ts` preflights snapshots, creates private backups, writes atomically per file, and rolls back earlier writes on failure. Never implement rename by applying a fresh provider then pruning the old one: that loses unmodeled config.

**Adapter writes**: Wrap each TargetApp with `transactionalTarget()`. `fsutil` stages reads/writes in scoped async context; commit only after all input validation and serialization succeeds. Preserve file permissions, use private new files, and reuse shared identity/YAML/JSONC helpers. Multi-target sync remains best-effort per target, not globally atomic.

**Metadata flow**: `metadata.ts` merges tracked models.dev fields and `gateway.ts` public catalog data. `getMetadataMode(provider)` resolves `gatewayMetadata` as `undefined`/`'auto'` → auto, `true` → on, `false` → off. Auto is the default: models.dev first, then lazily load Gateway only for missing core fields (`contextWindow`, `maxOutput`, `reasoning`, `imageInput`), unchanged Gateway-owned fields needing refresh that the primary source has not replaced, or an identity conflict between tracked automatic values and an explicit canonical model ID. Name/prices/optional input limits/efforts alone never trigger auto lookup. On always consults Gateway for nonempty IDs; off never does and retains legacy models.dev lookup. Auto/on use conservative exact identities: a bare case-sensitive ID may map to a unique Gateway creator/model when primary evidence is absent or agrees; ambiguity rejects, qualified IDs never lose prefixes, and custom/ambiguous names require explicit aliases. Preserve manual/untracked values, custom model fields, discovered IDs and routing; auto values refresh only while they match their provenance snapshot. Gateway pricing stays reference-only in `ModelSpec.metadata`, never effective `cost` or routing; audit data never enters runtime agent configs. `--metadata-mode <auto|on|off>` is supported by add/quick/discover/import/refresh; legacy boolean flags remain explicit on/off, omitted options preserve saved settings, and invalid/conflicting options fail before fetch or mutation. `refresh --provider` updates saved metadata/settings without fetching a model list or writing agents; `models --provider --metadata` shows effective mode and audit. Automatic metadata lookup does not change sync behavior: ordinary sync does not fetch model lists or catalogs.

## Key Directories

| Directory | Purpose |
|-----------|---------|
| `src/` | All TypeScript source — entry point, commands, store, i18n, discovery, models.dev, filesystem utils |
| `src/targets/` | Per-app adapters: `claudecode.ts`, `codex.ts`, `omp.ts`, `pistyle.ts` (pi/prime), `opencode.ts`, `hermes.ts`, `workbuddy.ts`, `dsh.ts`, `wire.ts`, `types.ts` |
| `src/sources/` | External config importers: `ccswitch.ts` (cc-switch SQLite reader) |
| `test/` | Node.js test runner: adapter roundtrips, YAML aliases, JSONC, naming/import identity, rename/removal transactions, CLI/menu workflows, and filters |
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
- Automatic provider ID: `providerIdFromBaseUrl(baseUrl, protocol)` retains the entire hostname and appends the protocol; `availableProviderId()` prevents collisions. Sync must never rename an existing ID.

### Async Patterns
- Command handlers are `async` functions; Commander awaits them via `parseAsync()`.
- `loadStore()`/`saveStore()` are synchronous (JSON file I/O).
- Network calls (`discoverProviderModels`, `loadCatalog`, `latestVersion`) are async with timeouts.
- `execSync`/`execFileSync` used for version probes (15s timeout) and shell commands.

### State Management
- Store is a flat JSON file at `~/.config/agentsw/config.json` (or `%APPDATA%/agentsw/` on Windows). No database, no caching — loaded fresh each command.
- `AGENTSW_HOME` env var overrides entire home directory layout (used in tests and CI smoke tests).
- Dry-run mode: `setDryRun(true)` intercepts `writeFileAtomic()` to record intents instead of writing; `drainPendingWrites()` retrieves them for preview output.
- Management commands have their own preplanned transaction dry-run. `remove --apps` is agent-only, including unregistered entries; `remove --prune` removes a central entry plus matching app entries. These scopes are mutually exclusive.

### Target Adapter Pattern
Each adapter in `src/targets/` implements the `TargetApp` interface:
- `id`, `name`, `configPaths[]`, `protocols[]`
- `detect()` — checks if the app's config exists
- `current()` — reads which provider is active
- `apply(provider)` — writes provider config into the app's native format
- `prune(provider)` — removes provider entries
- `candidates()` — reads existing custom providers from app config for import
- `supportsProtocol(protocol)` — checks if adapter handles openai/anthropic

Adapters use `YAML` (omp, hermes, dsh), `smol-toml` (codex), `jsonc.ts` (pi/prime), or native JSON. Preserve YAML alias values and JSONC comments; validate before mutation. The `wire.ts` module provides shared API and model-merge helpers.
New adapters also require schema/reference support in `rename.ts` and `remove.ts`, account-qualified local selectors when no native ID exists, and corresponding transaction, identity, dry-run and lifecycle regressions. Add `apps.ts` platform commands if installable. Generated credential references must use `provider-identity.ts`; never normalize IDs to environment names with a lossy uppercase/underscore transform.

### i18n
- Message keys live in a flat `messages` object (`src/i18n.ts`), each with `en` and `zh-CN` variants.
- `t(key, vars?)` — looks up message, replaces `{placeholder}` tokens via `replaceAll`.
- Locale precedence: CLI `--lang` > `$AGENTSW_LANG` > `store.language` > system locale (`LC_ALL` > `LC_MESSAGES` > `LANG` > `Intl` > `en`).

## Important Files

| File | Purpose |
|------|---------|
| `src/index.ts` | CLI entry point (`#!/usr/bin/env node`); Commander program, locale init, command registration |
| `src/commands.ts` | Provider creation/discovery/sync commands + shared helpers (`fail`, `table`, `createProvider`, `runTargets`) |
| `src/provider-actions.ts` | Localized CLI/menu wrappers for rename, scoped removal, and local provider listing |
| `src/rename.ts`, `src/remove.ts` | Schema-aware provider ID/reference migration and scoped deletion plans |
| `src/config-transaction.ts` | Preflight, private unique backups, atomic writes, and rollback |
| `src/jsonc.ts` | Comment-preserving JSONC validation and incremental edits |
| `src/types.ts` | Core types: `Protocol`, `Provider`, `ModelSpec`, `Store`, `ApplyResult`, `Locale` |
| `src/store.ts` | Config store load/save (`~/.config/agentsw/config.json`, mode 0600) |
| `src/apps.ts` | App catalog (9 apps), version detection, install/upgrade commands |
| `src/discover.ts` | Model discovery from `/v1/models`, protocol probing (`probeProtocols`) |
| `src/modelsdev.ts` | models.dev catalog fetch/cache (24h TTL), `enrichModels()`, `searchCatalog()` |
| `src/menu.ts` | Interactive TUI menu (prompts-based), dispatches to command handlers |
| `src/i18n.ts` | Bilingual messages (en/zh-CN), locale detection/normalization |
| `src/fsutil.ts` | Atomic writes, dry-run, backups, platform-aware paths (`appDataDir`, `localAppDataDir`) |
| `src/import.ts` | Provider import/merge pipeline, `scanCandidates()`, `mergeCandidates()` |
| `src/slug.ts` | Full-hostname/protocol IDs, display names, and collision-safe allocation |
| `src/targets/wire.ts` | Shared wire helpers for OpenAI/Anthropic protocol classification |
| `src/targets/types.ts` | `TargetApp` and `ProviderCandidate` interfaces |
| `src/sources/ccswitch.ts` | cc-switch SQLite importer (read-only, 3 shape parsers) |
| `test/targets.test.ts` | Largest test file — apply/prune roundtrips for all 9 adapters |
| `test/filter.test.ts` | Model filter semantics (dedup, include/exclude globs, pinned ids) |

## Runtime/Tooling Preferences

- **Runtime**: Node.js >= 22.13.0 (built-in SQLite without the experimental flag). CI tests the exact minimum plus current Node 22 and 24.
- **Package manager**: npm (no pnpm/yarn.lock committed). `npm ci` in CI.
- **TypeScript**: ESM (`"type": "module"`), target ES2022, `NodeNext` module resolution, `strict: true`, `noUncheckedIndexedAccess: true`.
- **No linting/formatting tools** — no eslint, prettier, or editorconfig.
- **Publishing**: OIDC trusted publishing (no `NPM_TOKEN`). Tag `v*` triggers `release.yml` → `npm publish --access public` + GitHub Release with CHANGELOG body.
- **Binary names**: `agentsw` and `asw` both point to `dist/index.js`.

## Testing & QA

- **Framework**: Node.js built-in `node:test` runner via `tsx --test test/*.test.ts`.
- **Assertions**: `node:assert/strict`.
- **Regression coverage**: Includes initialization, repeated sync, malformed configs, reference migration, deletion scope, dry-run nonwrites, and interactive confirmation; use `npm test` for the current count.
- **Sandbox pattern**: Tests use `AGENTSW_HOME` env var or `os.tmpdir()` to isolate config writes. No real network calls — model metadata is mocked or hardcoded.
- **CI matrix**: Ubuntu + macOS (Node 22, 24), Ubuntu (exact Node 22.13.0), Windows (Node 22). Installed-package smoke on every job exercises npm-pack installation, both binary aliases, add/use/redacted-preview/status/rename and scoped/global removal in a sandbox.
- **Windows note**: File permission assertions (`mode & 0o077 === 0`) are skipped on win32 (NTFS doesn't honor Unix chmod bits).
- **Coverage**: No coverage percentage gate. Regressions include command orchestration, pagination, metadata matching, shell/probe failures, SemVer, account isolation, file permissions, stale store writes, adapter roundtrips and bilingual management UI. Run `node scripts/package-smoke.mjs` after building to test the actual distributable.
