# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.6.0] - 2026-09-03

### Fixed

- **v1/v1 double-path bug**: target adapters now strip the trailing `/v1` (or
  `/v2`, `/v1beta`) from `baseUrl` when writing to apps whose own SDK appends
  `/v1/...` to the base URL (Claude Code, opencode, hermes, omp, pi, prime, dsh).
  Codex is the exception — it appends `/responses` directly, so it keeps `/v1`.
  This prevents `https://host/v1/v1/messages` style requests when a provider's
  stored `baseUrl` includes the API version segment.

## [0.5.5] - 2026-09-03

### Added

- AGENTS.md — repository guidelines for AI assistants: architecture, data flow,
  key directories, development commands, code conventions, and testing.

## [0.5.4] - 2026-09-03

### Fixed

- dsh detection: restore binary probe for global installs (`dsh --version`),
  with localVersion fallback for npx-only users. Also added a fast
  global-node_modules path check before the slow `npm ls -g` subprocess.

## [0.5.3] - 2026-09-03

### Fixed

- dsh detection: dsh has no global binary (it runs via `npx @deepseek-ai/dsh web`).
  The `apps` command now detects dsh via npx cache, global npm install, or the
  `~/.dsh` config directory instead of probing for a `dsh` binary in PATH.

## [0.5.2] - 2026-09-03

### Fixed

- Windows CI: skip Unix file-permission assertion for dsh credentials on
  win32 (chmod bits are not honored by NTFS).

## [0.5.1] - 2026-09-03

### Added

- Interactive menu now includes an "安装智能体" (install agent) option that
  lists all not-yet-installed agents and installs them via their official
  install commands.

## [0.5.0] - 2026-09-02

### Fixed

- `apps` / `upgrade` no longer leaks `/bin/sh: brew: not found` to the terminal on
  Linux when Homebrew is absent — the `brew info` probe now captures stderr
  instead of inheriting it.
- `apps` status no longer shows "up to date" when the installed version is
  unknown (`?`) or the latest version lookup failed (`?`). These now display
  "unknown" instead of falsely claiming the app is current.
- Model tables (`add`, `discover`, `models --provider`) now print a dim hint
  when some models have no models.dev metadata, so the `-` columns are clearly
  "uncataloged" rather than looking like a display bug.
- `add` with manual model entry no longer fails when the user leaves the model
  list blank — it now auto-discovers from the provider's `/v1/models` instead of
  erroring with "at least one model id is required". The prompt text also notes
  that leaving blank triggers auto-discovery.

### Added

- `agentsw quick` — one-command provider setup: pass only `--base-url` and
  `--api-key` (or just answer two prompts interactively), and agentsw probes
  the endpoint with both OpenAI (`Bearer`) and Anthropic (`x-api-key`) auth
  headers to auto-detect which protocol(s) it speaks. When both succeed, two
  providers are created with `-openai` / `-anthropic` suffixes; models are
  auto-discovered from `/v1/models` for each. The provider id is derived from
  the URL host when `--id` is omitted. Also available as "quick add" in the
  interactive menu.

- Windows support for provider synchronization and app state paths, native Windows
  install commands for the npm/Python-managed agents, Windows executable shim probing,
  and a Windows CI job.

## [0.4.0] - 2026-09-02

### Changed

- **Renamed to `agentsw`** (was `smart-switch`, which collided with home-automation
  switches and React switch components in every search). Binaries are `agentsw` and
  `asw`; the store moves to `~/.config/agentsw/`, the locale override becomes
  `AGENTSW_LANG`, and generated credential references become `AGENTSW_<ID>_API_KEY`.
  A clean cutover — the old name has no released users to migrate.

### Added

- DeepSeek Harness (`dsh`) adapter: writes the `llm-pi-ai` provider route and the
  `agent-default-model` selection into `$DSH_HOME/settings.yaml` (default `~/.dsh`),
  stores the key as a credential reference in `$DSH_HOME/.credentials.yaml` (mode 0600,
  pre-release flat documents migrated to the version 1 layout), imports existing routes,
  and joins the apps manager (`npm i -g @deepseek-ai/dsh`).

- OpenAI Responses wire support for omp/pi/prime/dsh providers: `openai-responses`
  (plus the Azure/Codex variants) is recognized on import — provider-level or
  declared on the models — persisted per provider and written back on sync. New
  `agentsw add --openai-api <completions|responses>`, also asked interactively.

- `import` also reads cc-switch's own provider store (`~/.cc-switch/cc-switch.db`,
  opened read-only, never written back): its Claude env blocks, Codex `config.toml`
  payloads and pi-family rows all become candidates, deduped against the same
  providers found in the agents' configs.

### Fixed

- Import no longer skips omp/pi/prime providers whose `api` is `openai-responses`;
  previously only `openai-completions` and `anthropic-messages` entries were seen,
  so responses-only reseller endpoints were invisible to agentsw.
- Import dedupe now spans the `/v1` segment: omp/pi/opencode keep it in the base URL
  while Codex leaves it off (the client appends it), so the same reseller used to be
  imported twice — `sub` and `sub-2`. One endpoint is now one provider, and the
  variant naming the API version is the one stored.
- Sync no longer drops provider-level keys agentsw does not model when
  rewriting an existing provider entry — omp/pi/prime (`authHeader`, `headers`,
  `compat`, `auth`, `discovery`, ...), opencode (`options.headers`, per-model
  fields) and Hermes — or per-model extras such as `thinkingLevelMap`. Only the
  fields agentsw owns are overwritten, and an existing responses wire is
  never downgraded to chat completions.
- A re-sync now clears the per-model keys agentsw owns but no longer emits
  (a stale `thinkingLevelMap` beside `reasoning: false`, sizes the catalog dropped),
  removes `disableStrictTools` when a provider is re-applied on an openai wire, and
  drops per-model `api`/`baseUrl` overrides that contradict the route it just wrote
  (they would silently win over the provider entry). Dropped overrides are reported.
- A provider whose models declare different wire protocols is skipped on import
  instead of being adopted under the first model's protocol.

## [0.3.0] - 2026-08-30

### Added

- First-run provider import: scan custom providers from Claude Code, Codex, omp,
  pi, prime-agent, opencode, Hermes and WorkBuddy configs; preview and multi-select
  candidates; merge duplicates by normalized base URL + wire protocol while
  preserving different protocols on the same host; union model ids/source apps;
  resolve inline/env-backed API keys; enrich imported models from models.dev.
  Available from the empty-store menu and `agentsw import [--all]`.
- English / 简体中文 CLI i18n: first-run language selection, persisted menu
  preference, system-locale auto-detection, `AGENTSW_LANG` and `--lang`
  overrides, plus localized help, provider add/import prompts, and core menu
  command output.

## [0.2.0] - 2026-08-30

### Added

- Interactive main menu on bare invocation — `npx agentsw` (zero install) or
  `agentsw` with no arguments: add/update a provider via guided prompts
  (protocol, base URL, API key, discover-or-manual model list), switch providers
  (with optional default-model override), status, list, sync, discover,
  remove, and agent version check/upgrade. Non-TTY bare invocation prints help.
- `.version` now reads package.json instead of a hardcoded literal.

## [0.1.1] - 2026-08-30

### Changed

- Release pipeline now publishes via npm OIDC trusted publishing (no token secrets).
- Bilingual docs (English / 简体中文), CHANGELOG, LICENSE, CI matrix (ubuntu/macos × Node 22/24).


## [0.1.0] - 2026-08-30

### Added

- Provider management: `add` (interactive or flagged), `list`, `remove`, `use`,
  `sync`, `status` across eight coding agents: Claude Code, Codex CLI, Oh My Pi,
  pi, prime-agent, opencode, Hermes (NousResearch), WorkBuddy (Tencent).
- OpenAI-protocol and Anthropic-protocol providers; per-app protocol gating
  (Codex is Responses-API/openai-only, Claude Code and WorkBuddy per their wire).
- models.dev integration: metadata enrichment (context window, input/output
  limits, reasoning effort levels, image input, pricing) pushed into each app's
  config — `thinkingLevelMap` for pi/prime, `limit`/`attachment`/`cost` for
  opencode, `contextWindow`/`maxTokens` for omp, capability flags for WorkBuddy.
- Model discovery: `add --discover` and `discover <id> [--sync]` list ids from
  the provider's `/v1/models` and re-enrich from models.dev, reporting upstream
  additions/removals.
- Discovery filters, persisted per provider: `--include`/`--exclude` globs and
  default snapshot-duplicate dropping (`-latest`, date suffixes) with
  `--no-dedup` opt-out; explicit models and the default model are never dropped.
- Agent installation manager: `apps` (installed vs latest via npm/PyPI/brew/
  GitHub releases), `install <app>`, `upgrade [apps...]`.
- Safety: timestamped backups of every modified config, atomic writes,
  YAML comment preservation (omp, hermes), `--dry-run` line-diff preview for
  `use`/`sync`, `prune <id>` / `remove --prune` cleanup.
- `models <query>` catalog search and `refresh` metadata re-fetch with 24h cache
  and offline fallback.
- Test suite (`node:test`): filter semantics and adapter apply/prune roundtrips.

[Unreleased]: https://github.com/tchivs/agentsw/compare/v0.5.5...HEAD
[0.5.5]: https://github.com/tchivs/agentsw/compare/v0.5.4...v0.5.5
[0.5.4]: https://github.com/tchivs/agentsw/compare/v0.5.3...v0.5.4
[0.5.3]: https://github.com/tchivs/agentsw/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/tchivs/agentsw/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/tchivs/agentsw/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/tchivs/agentsw/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/tchivs/agentsw/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/tchivs/agentsw/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/tchivs/agentsw/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/tchivs/agentsw/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/tchivs/agentsw/releases/tag/v0.1.0
